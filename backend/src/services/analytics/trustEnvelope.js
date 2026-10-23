const { getFreshness } = require("./freshness");

// --------------------------------------------------
// Wraps a raw analytics result with the explicit trust state the frontend
// must react to differently. The REST analytics endpoints return THIS
// envelope, never a raw analytics object alone, so there is no code path
// where a caller can present a number without also knowing whether it's
// fresh, stale, or came from a failed sync.
//
// States (from the master spec, Part 8):
//   valid_data        - real data found, sync is fresh -> answer normally
//   zero_result        - query ran fine, zero matching vouchers -> say so
//   no_usable_data      - required capability/data doesn't exist
//                        (a {supported:false} result) -> say so
//   stale_data          - real data found, but sync is stale -> answer +
//                        freshness warning
//   sync_failed          - last sync attempt failed -> answer with cached
//                        data if any exists, clearly flagged
//   analytics_error      - the analytics function itself threw -> do not
//                        fabricate a result
// --------------------------------------------------

async function wrapAnalyticsResult({
  tenantId,
  voucherType,
  run, // async () => rawResult
}) {
  const freshness = await getFreshness(tenantId, voucherType);

  let rawResult;
  try {
    rawResult = await run();
  } catch (error) {
    return {
      state: "analytics_error",
      data: null,
      freshness,
      message: `The analytics calculation failed: ${error.message}. No result is being shown rather than an unverified one.`,
    };
  }

  // A capability that does not exist returns {supported: false, reason}.
  if (rawResult && rawResult.supported === false) {
    return {
      state: "no_usable_data",
      data: null,
      freshness,
      message: rawResult.reason,
    };
  }

  // Freshness is checked BEFORE emptiness, deliberately. A tenant that
  // has never been synced and a tenant that was synced and genuinely
  // has zero matching vouchers must produce different messages - "we
  // don't have your data yet" is a fundamentally different, more
  // actionable statement than "we checked and there's nothing there."
  // Collapsing the two into one "zero_result" would hide a sync/setup
  // problem behind what looks like a normal empty-period answer.
  if (freshness.state === "never_synced") {
    return {
      state: "no_usable_data",
      data: null,
      freshness,
      message: freshness.message,
    };
  }

  if (freshness.state === "sync_failed") {
    return {
      state: "sync_failed",
      data: rawResult,
      freshness,
      message: `${freshness.message} The figures below are from the last successful sync and may not reflect recent changes in Tally.`,
    };
  }

  const hasData =
    rawResult && typeof rawResult.hasData === "boolean"
      ? rawResult.hasData
      : true;

  if (!hasData) {
    return {
      state: "zero_result",
      data: rawResult,
      freshness,
      message: "No matching records were found for this query.",
    };
  }

  if (freshness.state === "stale") {
    return {
      state: "stale_data",
      data: rawResult,
      freshness,
      message: freshness.message,
    };
  }

  return {
    state: "valid_data",
    data: rawResult,
    freshness,
    message: null,
  };
}

module.exports = {
  wrapAnalyticsResult,
};
