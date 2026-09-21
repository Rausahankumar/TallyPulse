const { getVoucherTypeMasters } = require("../odbc/odbcService");
const { unwrapJsonExValue } = require("../parser/tallyParser");
const { validateMasterOwnership } = require("./companyOwnership");

// --------------------------------------------------
// Generic, metadata-driven Sales/Purchase voucher-type classification.
//
// Problem this replaces: the old sync hardcoded "Child Of": "$$VchTypeSales"
// / "$$VchTypePurchase". Confirmed live against a real customized company
// ("We Four") that this only ever matches vouchers whose OWN
// VoucherTypeName is literally "Sales"/"Purchase" - it does not walk the
// voucher-type parent hierarchy at all. A company that records real sales
// under several distinct voucher-type names (e.g. "Invoice",
// "AMAZON INVOICE", "Darpan Sale") organized under a renamed custom parent
// group ("Online Sales") was therefore missing the vast majority of its
// sales vouchers, silently.
//
// Fix: Tally's VoucherType master exposes `metadata.reservedname` on every
// voucher type - a permanent internal system-class tag (e.g. "Sales",
// "Purchase", "Journal", ...) that survives renaming. Confirmed live: a
// voucher type named "Online Sales" (self-parented - it IS the root of its
// own hierarchy) carries reservedname "Sales", proving the tag doesn't
// follow the display name. Every other voucher type in that company's
// Sales workflow chains up to that root via its own `parent` field, at
// whatever depth the customer built.
//
// So: fetch the flat VoucherType master, walk each type's parent chain to
// its self-parented root, and classify by that root's reservedname - never
// by voucher type NAME, never by isdeemedpositive/affectsstock (both are
// too weakly correlated with Sales/Purchase specifically to be a safe
// signal - e.g. Debit Note also has isdeemedpositive=true).
// --------------------------------------------------

const RESERVED_SALES = "Sales";
const RESERVED_PURCHASE = "Purchase";

// Generous bound on hierarchy depth - purely a safety net against a
// malformed/never-terminating chain. Real Tally hierarchies observed so
// far are 1-2 levels deep.
const MAX_PARENT_CHAIN_HOPS = 25;

const DEFAULT_CACHE_TTL_MS =
  (Number(process.env.VOUCHER_TYPE_CLASSIFICATION_CACHE_TTL_MINUTES) || 360) *
  60 *
  1000;

function safeString(value) {
  const unwrapped = unwrapJsonExValue(value);
  if (unwrapped === undefined || unwrapped === null) return "";
  return String(unwrapped);
}

// Extracts {name, parent, reservedName} for every voucher type Tally's
// "Type": "VoucherType" collection returns. Real identities only, straight
// off Tally's own response - never invents a value when one is missing.
function parseVoucherTypeMasterList(rawTallyResponse) {
  const collection = rawTallyResponse?.data?.collection;
  if (!Array.isArray(collection)) return [];

  return collection
    .map((entry) => {
      const meta = (entry && entry.metadata) || {};
      const name = safeString(meta.name).trim();
      const reservedName = safeString(meta.reservedname).trim();
      const parent = safeString(entry && entry.parent).trim();
      // "<companyGuid>-<masterId>": what ties a master to its company.
      const guid = safeString(entry && entry.guid).trim();

      return { name, parent, reservedName, guid };
    })
    .filter((entry) => entry.name);
}

// Pure, synchronous core algorithm - no I/O, fully unit-testable.
//
// voucherTypeMasters: [{name, parent, reservedName}]
//
// Returns:
//   {
//     sales:    { status: "ok" | "needs_configuration", typeNames, rootName, reason },
//     purchase: { status: "ok" | "needs_configuration", typeNames, rootName, reason },
//     totalVoucherTypes: number,
//     unresolvedTypeNames: string[] - types whose own parent chain is
//       broken/cyclic; excluded from both sets, never guessed into either.
//   }
function classifyVoucherTypes(voucherTypeMasters) {
  const parentByName = new Map();
  const reservedNameByName = new Map();

  for (const entry of voucherTypeMasters || []) {
    const name = String((entry && entry.name) || "").trim();
    if (!name) continue;

    const parent = String((entry && entry.parent) || "").trim();
    // A voucher type with no parent at all is treated as self-parented
    // (its own root) - matches how Tally represents the 28 built-in
    // reserved types themselves.
    parentByName.set(name, parent || name);
    reservedNameByName.set(
      name,
      String((entry && entry.reservedName) || "").trim()
    );
  }

  const allNames = Array.from(parentByName.keys());

  // Find every self-parented root, grouped by its reservedname.
  const rootNamesByReserved = new Map();
  for (const name of allNames) {
    if (parentByName.get(name) !== name) continue;

    const reserved = reservedNameByName.get(name);
    if (!reserved) continue;

    if (!rootNamesByReserved.has(reserved)) {
      rootNamesByReserved.set(reserved, []);
    }
    rootNamesByReserved.get(reserved).push(name);
  }

  function resolveRootFor(reservedLabel) {
    const roots = rootNamesByReserved.get(reservedLabel) || [];

    if (roots.length === 0) {
      return {
        status: "needs_configuration",
        typeNames: [],
        rootName: null,
        reason: `No voucher type carries the reserved "${reservedLabel}" classification in this company's VoucherType master.`,
      };
    }

    if (roots.length > 1) {
      return {
        status: "needs_configuration",
        typeNames: [],
        rootName: null,
        reason: `Multiple voucher types carry the reserved "${reservedLabel}" classification (${roots.join(
          ", "
        )}); refusing to guess which is authoritative.`,
      };
    }

    return { status: "ok", typeNames: [], rootName: roots[0], reason: null };
  }

  const salesResolution = resolveRootFor(RESERVED_SALES);
  const purchaseResolution = resolveRootFor(RESERVED_PURCHASE);

  // Walk a single voucher type's parent chain to its ultimate self-parented
  // root. Memoized since the same intermediate nodes get walked repeatedly
  // across different leaf types. Detects cycles via a per-call visited set
  // (independent of the cache) and bails out past MAX_PARENT_CHAIN_HOPS as
  // a last-resort safety net.
  const rootCache = new Map();
  function findUltimateRoot(startName) {
    if (rootCache.has(startName)) return rootCache.get(startName);

    const visited = new Set();
    let current = startName;
    let outcome = null;

    for (let hops = 0; hops <= MAX_PARENT_CHAIN_HOPS; hops += 1) {
      if (visited.has(current)) {
        outcome = { broken: true, reason: "cycle" };
        break;
      }
      visited.add(current);

      const parent = parentByName.get(current);
      if (parent === undefined) {
        outcome = { broken: true, reason: "missing-parent" };
        break;
      }

      if (parent === current) {
        outcome = { broken: false, root: current };
        break;
      }

      current = parent;
    }

    if (!outcome) {
      outcome = { broken: true, reason: "max-hops-exceeded" };
    }

    rootCache.set(startName, outcome);
    return outcome;
  }

  const unresolvedTypeNames = [];

  function collectTypeNamesForRoot(targetRootName) {
    if (!targetRootName) return [];

    const matches = [];
    for (const name of allNames) {
      const resolved = findUltimateRoot(name);

      if (resolved.broken) {
        if (!unresolvedTypeNames.includes(name)) {
          unresolvedTypeNames.push(name);
        }
        continue;
      }

      if (resolved.root === targetRootName) {
        matches.push(name);
      }
    }
    return matches;
  }

  if (salesResolution.status === "ok") {
    salesResolution.typeNames = collectTypeNamesForRoot(
      salesResolution.rootName
    );
  }

  if (purchaseResolution.status === "ok") {
    purchaseResolution.typeNames = collectTypeNamesForRoot(
      purchaseResolution.rootName
    );
  }

  return {
    sales: salesResolution,
    purchase: purchaseResolution,
    totalVoucherTypes: allNames.length,
    unresolvedTypeNames,
  };
}

function buildFetchFailureResult(reason) {
  return {
    sales: { status: "error", typeNames: [], rootName: null, reason },
    purchase: { status: "error", typeNames: [], rootName: null, reason },
    totalVoucherTypes: 0,
    unresolvedTypeNames: [],
    resolvedAt: new Date(),
    source: "live",
  };
}

// In-memory cache, keyed by companyGuid. VoucherType masters change
// infrequently (creating/renaming a voucher type is a rare admin action),
// so re-fetching and re-classifying on every sync tick would be wasted
// work for no correctness benefit. Deliberately NOT persisted to MongoDB:
// a cold cache after a process restart just costs one extra Tally
// round-trip on the next sync tick per company (the same tick already
// makes a comparable round-trip for verifyOpenTallyCompany) - there is no
// correctness risk to losing this cache, since it is always recomputed
// from Tally's own current live state, never from anything written by a
// previous run. See the accompanying report for the explicit
// in-memory-vs-persisted decision.
//
// Company isolation: Tally answers master queries for whichever company is
// SELECTED, which need not be the tenant's. A master list is therefore checked
// against the tenant's configured company GUID (companyOwnership.js) BEFORE it
// is classified or cached; a foreign or unverifiable list is a fetch failure
// and is never cached, so one tenant can never be served - or leave behind -
// another company's voucher types. The key is always the tenant's companyGuid;
// there is no "default" key any more.
const classificationCache = new Map();

function cacheKeyFor(companyGuid) {
  return companyGuid;
}

// Fail-closed by construction: any fetch/parse error, or a company whose
// Sales/Purchase root can't be uniquely resolved, comes back as a non-"ok"
// status - it is never translated into a fallback to the old
// $$VchTypeSales/$$VchTypePurchase behavior by this function or its
// callers.
async function resolveVoucherTypeClassification({
  companyGuid,
  baseUrl,
  forceRefresh = false,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
} = {}) {
  // Without a trusted company GUID nothing can be verified or cached safely.
  if (typeof companyGuid !== "string" || !companyGuid.trim()) {
    return buildFetchFailureResult(
      "No company GUID was supplied, so Tally's voucher types cannot be tied to a company."
    );
  }

  const key = cacheKeyFor(companyGuid);

  if (!forceRefresh) {
    const cached = classificationCache.get(key);
    if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
      return { ...cached.result, source: "cache" };
    }
  }

  let rawResponse;
  try {
    rawResponse = await getVoucherTypeMasters({ baseUrl });
  } catch (error) {
    const message =
      error && error.message
        ? error.message
        : "Unknown error fetching the VoucherType master from Tally.";
    return buildFetchFailureResult(
      `Could not fetch the VoucherType master from Tally: ${message}`
    );
  }

  let parsedPayload;
  try {
    parsedPayload =
      typeof rawResponse === "string" ? JSON.parse(rawResponse) : rawResponse;
  } catch (error) {
    return buildFetchFailureResult(
      `VoucherType master response was not valid JSON: ${error.message}`
    );
  }

  let masters;
  try {
    masters = parseVoucherTypeMasterList(parsedPayload);
  } catch (error) {
    return buildFetchFailureResult(
      `Could not parse the VoucherType master list: ${error.message}`
    );
  }

  if (!masters.length) {
    return buildFetchFailureResult(
      "Tally returned zero voucher types - cannot classify Sales/Purchase."
    );
  }

  const ownership = validateMasterOwnership(masters, companyGuid);

  if (!ownership.ok) {
    console.warn(
      `[companyOwnership] REJECTED voucher-type masters company=${String(companyGuid).slice(0, 8)}... total=${ownership.total} foreign=${ownership.foreign} verified=${ownership.verified} sample=[${ownership.sample.join(",")}]`
    );
    return buildFetchFailureResult(ownership.reason);
  }

  const classification = classifyVoucherTypes(masters);
  const result = { ...classification, resolvedAt: new Date(), source: "live" };

  // Only a genuinely successful, live classification is cached - a fetch
  // failure must never poison the cache with a stale "error" result that
  // would otherwise be trusted for the next `cacheTtlMs` window.
  classificationCache.set(key, { result, cachedAt: Date.now() });

  return result;
}

function clearVoucherTypeClassificationCache(companyGuid) {
  if (companyGuid) {
    classificationCache.delete(companyGuid);
  } else {
    classificationCache.clear();
  }
}

module.exports = {
  classifyVoucherTypes,
  parseVoucherTypeMasterList,
  resolveVoucherTypeClassification,
  clearVoucherTypeClassificationCache,
  DEFAULT_CACHE_TTL_MS,
  RESERVED_SALES,
  RESERVED_PURCHASE,
};
