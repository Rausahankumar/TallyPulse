// --------------------------------------------------
// Batch sizing for the incremental sync worker.
//
// Problem: a company with a large backlog (a first sync, or a long outage)
// made the worker ask Tally for EVERY voucher since the checkpoint in one
// request - thousands of vouchers with their inventory/ledger detail. That
// exceeds the Tally client timeout, the checkpoint never advances, and the
// worker repeats the same oversized request every tick, keeping Tally busy.
//
// Fix: the worker first probes the pending AlterIDs (a light query), and
// this module picks a cut-off so each tick fetches at most `batchSize`
// vouchers: the batch is everything with AlterID in (checkpoint, cutOff].
// The cut-off is the batchSize-th smallest pending AlterID - an AlterID of
// a voucher that really exists - so the checkpoint can safely advance to it
// after the batch persists, and can never skip past unseen vouchers.
// --------------------------------------------------

const DEFAULT_BATCH_SIZE = 100;

// Positive integer from the given value, else the default. Invalid or
// missing config must never disable bounding or produce a zero-size batch.
function resolveBatchSize(value, fallback = DEFAULT_BATCH_SIZE) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

// alterIds: AlterIDs of every pending voucher (any order).
// Returns:
//   pending     - how many are pending in total
//   bounded     - true when the backlog exceeds one batch
//   upToAlterId - inclusive cut-off for this batch when bounded, else null
//                 (small backlogs are fetched exactly as before: no cap)
//   batchCount  - how many pending vouchers this batch covers
function computeBatchWindow(alterIds, batchSize) {
  const size = resolveBatchSize(batchSize);
  const sorted = alterIds.slice().sort((a, b) => a - b);

  if (sorted.length <= size) {
    return {
      pending: sorted.length,
      bounded: false,
      upToAlterId: null,
      batchCount: sorted.length,
    };
  }

  const upToAlterId = sorted[size - 1];

  return {
    pending: sorted.length,
    bounded: true,
    upToAlterId,
    batchCount: sorted.filter((id) => id <= upToAlterId).length,
  };
}

// Completeness check for a fetched batch: every AlterID the probe selected
// for the window must be present in what Tally actually returned. Returned
// vouchers that were NOT probed are fine (a superset is allowed - e.g. a
// voucher created after the probe). Any expected AlterID that is missing
// means the response was partial or the voucher changed between probe and
// fetch, so the batch must not advance the checkpoint; a retry re-probes
// against fresh state. Returns the missing AlterIDs, ascending.
function findMissingAlterIds(expectedAlterIds, returnedAlterIds) {
  const returned = new Set(returnedAlterIds);

  return Array.from(new Set(expectedAlterIds))
    .filter((id) => !returned.has(id))
    .sort((a, b) => a - b);
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  resolveBatchSize,
  computeBatchWindow,
  findMissingAlterIds,
};
