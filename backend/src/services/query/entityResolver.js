"use strict";

// --------------------------------------------------
// Tenant-scoped entity resolver (used by the planner to re-verify every name it put in a plan).
//
// Confirms that a name typed in a question really exists for THIS tenant as
// a customer / supplier / product / product group, and returns the canonical
// stored spelling. The tenantId is fixed at construction by the server and
// is never read from question text. Read-only; every query is filtered by
// tenantId. Names are compared on a normalized form (case,
// punctuation and spacing insensitive). An EXACT normalized match always wins. There is no fuzzy matching; the
// one relaxation is a typed name that is the leading whole word(s) of exactly ONE stored name (see resolveEntity).
// --------------------------------------------------

/** Lower-case, punctuation-free, single-spaced form used to compare entity names. */
function normalizeText(raw) {
  return String(raw)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9%\-\s]/g, " ")
    .replace(/(^|\s)-+(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const READ_TIMEOUT_MS = 5000;
const ENTITY_RESOLVER_UNAVAILABLE = "ENTITY_RESOLVER_UNAVAILABLE";
const PREFIX_MIN_FIRST_WORD = 4; // a shorter first word ("a", "mr", "new") is too generic to stand for a stored name

function defaultSources(tenantId) {
  const Sale = require("../../models/sales.model");
  const Purchase = require("../../models/purchase.model");
  const StockItemMaster = require("../../models/stockItemMaster.model");
  return {
    customer: () => Sale.distinct("header.partyName", { tenantId }).maxTimeMS(READ_TIMEOUT_MS),
    supplier: () => Purchase.distinct("header.partyName", { tenantId }).maxTimeMS(READ_TIMEOUT_MS),
    product: () => StockItemMaster.distinct("itemName", { tenantId }).maxTimeMS(READ_TIMEOUT_MS),
    productGroup: () => StockItemMaster.distinct("stockGroupName", { tenantId }).maxTimeMS(READ_TIMEOUT_MS),
  };
}

/**
 * @param {{tenantId: *, sources?: object}} opts  `sources` is injectable for tests
 *        ({dim: async () => string[]}).
 */
function createEntityResolver({ tenantId, sources } = {}) {
  if (!tenantId) throw new Error("createEntityResolver: tenantId is required");
  const src = sources || defaultSources(tenantId);
  const cache = new Map();

  // A failed load is NEVER cached: the entry is evicted so the next question retries the read, and the
  // failure surfaces as ENTITY_RESOLVER_UNAVAILABLE - never as "no match" (an empty list is only ever a
  // list the source really returned).
  async function index(dim) {
    if (!cache.has(dim)) {
      const loading = (async () => {
        const names = await src[dim]();
        if (!Array.isArray(names)) throw new Error(`entity source "${dim}" did not return a list`);
        const map = new Map();
        for (const n of names) {
          if (typeof n !== "string" || !n.trim()) continue;
          const key = normalizeText(n);
          if (key && !map.has(key)) map.set(key, n);
        }
        return map;
      })().catch((error) => {
        if (cache.get(dim) === loading) cache.delete(dim);
        const err = new Error(`Entity lookup is temporarily unavailable (${dim}).`);
        err.code = ENTITY_RESOLVER_UNAVAILABLE;
        err.cause = error;
        throw err;
      });
      cache.set(dim, loading);
    }
    return cache.get(dim);
  }

  async function resolveEntity({ entity, hintDim, text }) {
    const key = normalizeText(text || "");
    if (!key) return { matches: [] };
    let dims = entity === "sales" ? ["customer", "product", "productGroup"] : entity === "purchase" ? ["supplier", "product", "productGroup"] : ["customer", "supplier", "product", "productGroup"];
    if (hintDim) dims = dims.filter((d) => d === hintDim);
    const matches = [];
    for (const dim of dims) {
      const found = (await index(dim)).get(key);
      if (found) matches.push({ dim, value: found });
    }
    // Demo fix: people type the first word(s) of a stored name ("Dhingra" for "DHINGRA GENERAL STORE"). Only when
    // NO exact match exists, a typed name that is the leading whole word(s) of EXACTLY ONE stored name (across the
    // allowed kinds) resolves to it, flagged `partial` so the caller can say so. Two or more candidates -> no match.
    if (!matches.length && key.split(" ")[0].length >= PREFIX_MIN_FIRST_WORD) {
      const prefix = `${key} `;
      const hits = [];
      for (const dim of dims) {
        for (const [k, v] of await index(dim)) {
          if (k.startsWith(prefix)) {
            hits.push({ dim, value: v });
            if (hits.length > 1) break;
          }
        }
        if (hits.length > 1) break;
      }
      if (hits.length === 1) matches.push({ ...hits[0], partial: true });
    }
    return { matches };
  }

  return resolveEntity;
}

module.exports = { createEntityResolver, ENTITY_RESOLVER_UNAVAILABLE };
