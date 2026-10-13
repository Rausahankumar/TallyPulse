const crypto = require("crypto");
const StockItemMaster = require("../../models/stockItemMaster.model");
const { parseStockItemGstRecord, MAX_ISSUES } = require("../parser/gstFields");
const { validateMasterOwnership } = require("./companyOwnership");
const { isSafeStockGroupNameForFormula } = require("../odbc/odbcService");

// --------------------------------------------------
// Stock Item GST refresh: the second phase of refreshStockItemMasters (stockItemMaster.js).
//
// The core phase has already written and ownership-verified the tenant's Stock Items (name,
// group, GUID). This phase reads each Stock Group's GST/HSN configuration from Tally, ONE group per
// request and sequentially, and stores it on the matching item under `gst`.
//
// Safety rules (same discipline as every other master ingest):
//   - Ownership is checked on every response before anything is used; a foreign GUID aborts the rest.
//   - Records are matched to items by {tenantId, tallyGuid} only, never by name.
//   - It only ever $sets `gst` on an existing item. It never creates an item and never touches the
//     name, group or GUID.
//   - The stored GST is a mirror of Tally's current dated history. It is replaced as a whole, so a
//     repeat sync cannot duplicate entries and a corrected historical row replaces the old one.
//   - A bad response never destroys good data: a section that comes back absent, empty or malformed
//     does not overwrite a stored section that was valid. Each section (applicability, hsn, details)
//     is decided on its own.
//   - A group that fails, is empty, or cannot be queried leaves its items' GST as it was and is
//     named in the result.
// --------------------------------------------------

const GST_SCHEMA_VERSION = 1;
const SECTIONS = ["applicability", "hsn", "details"];
const MAX_REPORTED_GROUPS = 20;

// ---------- content hash ----------

// Key order and null/absent differences must not change the hash, so a re-read of stored data
// hashes the same as the freshly parsed data it came from.
function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined && value[k] !== null).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashContent(content) {
  return crypto.createHash("sha1").update(canonical(content)).digest("hex");
}

// ---------- merge ----------

function hasContent(section, value) {
  if (section === "applicability") return !!(value && (value.gstApplicable || value.typeOfSupply));
  return Array.isArray(value) && value.length > 0;
}

// How much real content a section holds. A response whose sections are present but hollow (for example
// history entries with no rate rows because the nested rate methods were not returned, or HSN entries with no
// code) must not replace a stored section that has content. Every real entry seen so far, including
// Non-GST and Exempt, carries its rate rows.
function substance(section, value) {
  if (section === "details") return (value || []).reduce((n, d) => n + (d.stateRates || []).reduce((m, s) => m + (s.rates || []).length, 0), 0);
  if (section === "hsn") return (value || []).filter((h) => h.code).length;
  return hasContent(section, value) ? 1 : 0;
}

function capIssues(issues) {
  const errorsFirst = [...issues].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return errorsFirst.slice(0, MAX_ISSUES).map((i) => ({
    section: i.section,
    path: i.path,
    code: i.code,
    severity: i.severity,
    raw: i.raw === undefined ? null : i.raw,
  }));
}

/**
 * Combine the stored `gst` of an item with what Tally just returned.
 *
 * Per section:
 *   absent   Tally did not return that part            -> keep stored
 *   empty    returned but empty                        -> keep stored if it had content (never erase), else store the empty
 *   hollow   entries present but without substance     -> keep stored if it had substance (rate rows / HSN codes)
 *   invalid  has a malformed value                     -> keep stored if it was clean; otherwise store it with the issues flagged
 *   applied  valid                                     -> replace (mirrors Tally, including corrections and removed rows)
 *
 * @returns {{gst: object|null, changed: boolean, outcome: object|string}}
 *   gst is null when there is nothing to store at all (an item with no GST data and none stored).
 */
function mergeGst(previous, parsed, now = new Date()) {
  const prev = previous && previous.schemaVersion ? previous : null;
  const merged = {
    applicability: prev && prev.applicability ? prev.applicability : null,
    hsn: prev && Array.isArray(prev.hsn) ? prev.hsn : [],
    details: prev && Array.isArray(prev.details) ? prev.details : [],
  };
  const outcome = {};
  const issues = [];
  let shrunk = false;

  for (const section of SECTIONS) {
    const next = parsed[section];
    const found = parsed.issues.filter((i) => i.section === section);
    const hasError = found.some((i) => i.severity === "error");
    const prevIssues = prev ? (prev.issues || []).filter((i) => i.section === section) : [];
    const prevHas = !!prev && hasContent(section, prev[section]);
    const prevClean = !prevIssues.some((i) => i.severity === "error");

    if (next === null || next === undefined) {
      outcome[section] = "absent";
      issues.push(...prevIssues);
    } else if (!hasContent(section, next)) {
      if (prevHas) {
        outcome[section] = "kept_empty";
        issues.push(...prevIssues);
      } else {
        merged[section] = next;
        outcome[section] = "applied";
        issues.push(...found);
      }
    } else if (prevHas && substance(section, prev[section]) > 0 && substance(section, next) === 0) {
      outcome[section] = "kept_incomplete";
      issues.push(...prevIssues);
    } else if (hasError && prevHas && prevClean) {
      outcome[section] = "kept_invalid";
      issues.push(...prevIssues);
    } else {
      if (prevHas && Array.isArray(next) && next.length < prev[section].length) shrunk = true;
      merged[section] = next;
      outcome[section] = hasError ? "stored_with_issues" : "applied";
      issues.push(...found);
    }
  }

  if (!prev && !parsed.hasGstData && issues.length === 0) {
    return { gst: null, changed: false, outcome: "no_gst_data" };
  }

  const stored = capIssues(issues);
  const contentHash = hashContent({ applicability: merged.applicability, hsn: merged.hsn, details: merged.details, issues: stored });
  const changed = !prev || prev.contentHash !== contentHash;

  return {
    gst: {
      schemaVersion: GST_SCHEMA_VERSION,
      syncedAt: changed ? now : prev.syncedAt,
      applicability: merged.applicability,
      hsn: merged.hsn,
      details: merged.details,
      issues: stored,
      issueCount: issues.length,
      contentHash,
    },
    changed,
    outcome,
    shrunk,
  };
}

// Schema-level check of a block before it is written (enum/required/type errors from our own code or a
// future Tally variation never reach the database; the item is reported as invalid instead).
async function validateGstBlock(block) {
  const doc = new StockItemMaster({ tenantId: "_", itemName: "_", stockGroupName: "_", tallyGuid: "_", gst: block });
  try {
    await doc.validate();
    return null;
  } catch (error) {
    return Object.values((error && error.errors) || {}).map((e) => e.message).slice(0, 3).join("; ") || String((error && error.message) || error);
  }
}

// ---------- response handling ----------

function parseGstResponse(rawResponse) {
  const payload = typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse;
  const collection = payload && payload.data && payload.data.collection;
  if (!Array.isArray(collection)) return [];
  return collection.filter((r) => r && typeof r === "object").map((record) => parseStockItemGstRecord(record));
}

function newSummary() {
  return {
    attempted: true,
    aborted: null,
    groupsRequested: 0,
    groupsFetched: 0,
    groupsFailed: [],
    groupsSkipped: [],
    groupsEmpty: [],
    recordsReceived: 0,
    matched: 0,
    notInCoreList: 0,
    groupMismatch: 0,
    withoutGstData: 0,
    updated: 0,
    unchanged: 0,
    storedWithIssues: 0,
    keptPreviousInvalid: 0,
    keptPreviousEmpty: 0,
    keptPreviousIncomplete: 0,
    shrunk: 0,
    invalid: 0,
    invalidSample: [],
    itemsInUnfetchedGroups: 0,
  };
}

const note = (list, entry) => {
  if (list.length < MAX_REPORTED_GROUPS) list.push(entry);
};

/**
 * @param {Object} params
 * @param {string} params.tenantId
 * @param {string} params.companyGuid  trusted, from the Company record
 * @param {string} [params.baseUrl]
 * @param {Array<{itemName, stockGroupName, tallyGuid}>} params.items  this run's ownership-verified core items
 * @param {Function} params.fetcher  ({baseUrl, stockGroupName}) -> raw Tally response (injectable for tests)
 * @returns {Promise<object>} a summary; this function does not throw
 */
async function refreshStockItemGst({ tenantId, companyGuid, baseUrl, items, fetcher, now = new Date() }) {
  const summary = newSummary();

  try {
    const itemByGuid = new Map(items.map((i) => [i.tallyGuid, i]));
    const groups = [...new Set(items.map((i) => i.stockGroupName))].sort();
    const fetchedGroups = new Set();
    summary.groupsRequested = groups.length;

    for (const group of groups) {
      if (!isSafeStockGroupNameForFormula(group)) {
        note(summary.groupsSkipped, { group, reason: "name cannot be placed safely in a Tally formula" });
        continue;
      }

      let records;
      try {
        records = parseGstResponse(await fetcher({ baseUrl, stockGroupName: group }));
      } catch (error) {
        note(summary.groupsFailed, { group, reason: String((error && error.message) || error).slice(0, 160) });
        continue;
      }

      if (records.length === 0) {
        note(summary.groupsEmpty, group);
        continue;
      }

      const ownership = validateMasterOwnership(records.map((r) => ({ guid: r.tallyGuid })), companyGuid);
      if (!ownership.ok) {
        console.warn(
          `[stockItemGst] REJECTED Stock Item GST response tenant=${tenantId} group="${group}" total=${ownership.total} foreign=${ownership.foreign} verified=${ownership.verified}`
        );
        summary.aborted = `ownership check failed for a GST response: ${ownership.reason}`;
        break;
      }

      fetchedGroups.add(group);
      summary.groupsFetched += 1;
      summary.recordsReceived += records.length;

      const matched = [];
      for (const record of records) {
        const item = record.tallyGuid ? itemByGuid.get(record.tallyGuid) : null;
        if (!item) {
          summary.notInCoreList += 1;
        } else if (record.parent && record.parent !== item.stockGroupName) {
          summary.groupMismatch += 1;
        } else {
          matched.push(record);
        }
      }
      summary.matched += matched.length;
      if (matched.length === 0) continue;

      const stored = await StockItemMaster.find(
        { tenantId, tallyGuid: { $in: matched.map((r) => r.tallyGuid) } },
        { tallyGuid: 1, gst: 1, _id: 0 }
      ).lean();
      const storedByGuid = new Map(stored.map((d) => [d.tallyGuid, d.gst]));

      const ops = [];
      for (const record of matched) {
        const result = mergeGst(storedByGuid.get(record.tallyGuid), record, now);

        if (!result.gst) {
          summary.withoutGstData += 1;
          continue;
        }

        const o = result.outcome;
        if (SECTIONS.some((s) => o[s] === "kept_invalid")) {
          summary.keptPreviousInvalid += 1;
          summary.invalid += 1;
          // Say WHAT was malformed, so a rejected response can be diagnosed from the result alone.
          const first = record.issues.find((i) => i.severity === "error");
          note(summary.invalidSample, {
            tallyGuid: record.tallyGuid,
            reason: first ? `${first.path} ${first.code}${first.raw ? ` (${first.raw})` : ""}`.slice(0, 160) : "invalid section",
          });
        }
        if (SECTIONS.some((s) => o[s] === "kept_empty")) summary.keptPreviousEmpty += 1;
        if (SECTIONS.some((s) => o[s] === "kept_incomplete")) summary.keptPreviousIncomplete += 1;
        if (SECTIONS.some((s) => o[s] === "stored_with_issues")) summary.storedWithIssues += 1;
        if (result.shrunk) summary.shrunk += 1;

        if (!result.changed) {
          summary.unchanged += 1;
          continue;
        }

        const problem = await validateGstBlock(result.gst);
        if (problem) {
          summary.invalid += 1;
          note(summary.invalidSample, { tallyGuid: record.tallyGuid, reason: problem.slice(0, 160) });
          continue;
        }

        ops.push({
          updateOne: {
            filter: { tenantId, tallyGuid: record.tallyGuid },
            update: { $set: { gst: result.gst } },
          },
        });
      }

      if (ops.length) {
        await StockItemMaster.bulkWrite(ops, { ordered: false });
        summary.updated += ops.length;
      }
    }

    summary.itemsInUnfetchedGroups = items.filter((i) => !fetchedGroups.has(i.stockGroupName)).length;
  } catch (error) {
    summary.aborted = `unexpected error: ${String((error && error.message) || error).slice(0, 200)}`;
  }

  return summary;
}

module.exports = {
  GST_SCHEMA_VERSION,
  mergeGst,
  hashContent,
  validateGstBlock,
  parseGstResponse,
  refreshStockItemGst,
};
