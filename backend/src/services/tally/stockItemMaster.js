const { getStockItemMasters, getStockItemGstMasters } = require("../odbc/odbcService");
const { parseVoucherTypeMasterList } = require("./voucherTypeClassifier");
const { validateMasterOwnership } = require("./companyOwnership");
const { refreshStockItemGst } = require("./stockItemGst");
const StockItemMaster = require("../../models/stockItemMaster.model");

// --------------------------------------------------
// Smallest safe Stock Item -> Stock Group master layer.
//
// Explicit/on-demand only (see refreshStockItemMasters below) - there is
// no scheduled worker, no 60-second loop, and the existing incremental
// voucher sync (tallySyncWorker.js) is completely untouched by this
// file. A later, separate decision can wire this into a periodic job if
// that's wanted; this phase only builds the capability itself.
//
// parseVoucherTypeMasterList is REUSED as-is, not duplicated - Tally's
// {metadata:{name}, parent, guid} shape for a flat master collection is
// identical for "Type": "VoucherType" and "Type": "StockItem"; the field
// meanings differ (voucher-type-name/parent-voucher-type vs
// item-name/stock-group), which parseStockItemMasterList below expresses
// with StockItem-appropriate field names, without a second parser.
// --------------------------------------------------

// {name, parent, guid} (as parsed) -> {itemName, stockGroupName, tallyGuid}
// (StockItem-appropriate names). Only real, non-empty Tally values pass
// through - an item with an empty $Parent is dropped (fail closed:
// "no group" is not a group and must never become one, e.g. "").
function parseStockItemMasterList(rawTallyResponse) {
  const raw = parseVoucherTypeMasterList(rawTallyResponse); // [{name, parent, reservedName, guid}]

  return raw
    .filter((entry) => entry.name && entry.parent && entry.guid)
    .map((entry) => ({
      itemName: entry.name,
      stockGroupName: entry.parent,
      tallyGuid: entry.guid,
    }));
}

// Items whose Tally record was missing a usable name/parent/guid -
// reported separately so a caller can see what was silently excluded,
// rather than that exclusion being invisible.
function findUnusableStockItemEntries(rawTallyResponse) {
  const raw = parseVoucherTypeMasterList(rawTallyResponse);
  return raw.filter((entry) => !(entry.name && entry.parent && entry.guid));
}

function buildFailureResult(reason) {
  return {
    ok: false,
    written: 0,
    totalFetched: 0,
    reason,
    resolvedAt: new Date(),
  };
}

/**
 * Fetch this tenant's Stock Item masters from Tally, verify company
 * ownership, and (only if verification passes) upsert them into
 * StockItemMaster. Fails closed: any fetch/parse/ownership problem
 * leaves whatever StockItemMaster data already exists completely
 * untouched - never partially written, never cleared, never guessed.
 *
 * @param {Object} params
 * @param {string} params.tenantId - the app's own tenant id (never from
 *   Tally's response - see companyOwnership.js for why).
 * @param {string} params.companyGuid - trusted, from the Company record.
 * @param {string} [params.baseUrl] - this company's Tally connection URL.
 * @param {Function} [params.fetcher] - defaults to the real
 *   getStockItemMasters (live Tally). Overridable so tests can exercise
 *   the full parse -> validate -> persist flow against a synthetic,
 *   Tally-shaped response without a live Tally connection - the
 *   production code path (default) is unchanged either way.
 * @param {Function} [params.gstFetcher] - ({baseUrl, stockGroupName}) -> the
 *   GST/HSN configuration of one Stock Group's items. Defaults to the real
 *   getStockItemGstMasters ONLY when `fetcher` is also the real one, so a test
 *   that stubs the core fetcher can never reach live Tally by accident.
 * @param {boolean} [params.includeGst] - false skips the GST phase (default true).
 *
 * The GST phase runs AFTER the core Name/Parent/Guid write, group by group, and
 * can never fail the core refresh: its outcome is reported under `gst`.
 */
async function refreshStockItemMasters({
  tenantId,
  companyGuid,
  baseUrl,
  fetcher = getStockItemMasters,
  gstFetcher = fetcher === getStockItemMasters ? getStockItemGstMasters : undefined,
  includeGst = true,
} = {}) {
  if (typeof tenantId !== "string" || !tenantId.trim()) {
    return buildFailureResult("No tenantId supplied - refusing to write company-less Stock Item data.");
  }
  if (typeof companyGuid !== "string" || !companyGuid.trim()) {
    return buildFailureResult("No trusted companyGuid supplied - refusing to accept unverifiable Tally data.");
  }

  let rawResponse;
  try {
    rawResponse = await fetcher({ baseUrl });
  } catch (error) {
    return buildFailureResult(`Could not fetch Stock Item masters from Tally: ${error.message || error}`);
  }

  let parsedPayload;
  try {
    parsedPayload = typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse;
  } catch (error) {
    return buildFailureResult(`Stock Item master response was not valid JSON: ${error.message}`);
  }

  // Ownership is checked against the FULL raw list (same discipline as
  // voucherTypeClassifier) - before any name/parent/guid filtering, so a
  // foreign-company response is rejected on its own GUIDs, not silently
  // narrowed down first.
  const rawForOwnership = parseVoucherTypeMasterList(parsedPayload);
  if (rawForOwnership.length === 0) {
    return buildFailureResult("Tally returned zero Stock Items - nothing to refresh.");
  }

  const ownership = validateMasterOwnership(rawForOwnership, companyGuid);
  if (!ownership.ok) {
    console.warn(
      `[stockItemMaster] REJECTED Stock Item masters tenant=${tenantId} company=${String(companyGuid).slice(0, 8)}... total=${ownership.total} foreign=${ownership.foreign} verified=${ownership.verified} sample=[${ownership.sample.join(",")}]`
    );
    return buildFailureResult(ownership.reason);
  }

  const items = parseStockItemMasterList(parsedPayload);
  const unusable = findUnusableStockItemEntries(parsedPayload);

  if (items.length === 0) {
    return buildFailureResult("Every Stock Item in the verified response was missing a usable name/Parent/Guid - nothing to write.");
  }

  // Tenant-scoped bulk upsert, keyed by {tenantId, tallyGuid} (identity),
  // so a Stock Item renamed in Tally updates the SAME document rather
  // than leaving a stale duplicate under its old name.
  const now = new Date();
  const ops = items.map((item) => ({
    updateOne: {
      filter: { tenantId, tallyGuid: item.tallyGuid },
      update: {
        $set: {
          tenantId,
          itemName: item.itemName,
          stockGroupName: item.stockGroupName,
          tallyGuid: item.tallyGuid,
          syncedAt: now,
        },
      },
      upsert: true,
    },
  }));

  const result = await StockItemMaster.bulkWrite(ops, { ordered: false });

  const gst = includeGst && typeof gstFetcher === "function"
    ? await refreshStockItemGst({ tenantId, companyGuid, baseUrl, items, fetcher: gstFetcher, now })
    : { attempted: false };

  return {
    ok: true,
    written: (result.upsertedCount || 0) + (result.modifiedCount || 0),
    totalFetched: rawForOwnership.length,
    usable: items.length,
    unusable: unusable.length,
    distinctStockGroups: new Set(items.map((i) => i.stockGroupName)).size,
    resolvedAt: now,
    gst,
  };
}

module.exports = {
  parseStockItemMasterList,
  findUnusableStockItemEntries,
  refreshStockItemMasters,
};
