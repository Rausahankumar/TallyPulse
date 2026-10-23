"use strict";

// --------------------------------------------------
// Tenant-scoped entity resolver for the local router (Phase 1D).
//
// Confirms that a name typed in a question really exists for THIS tenant as
// a customer / supplier / product / product group, and returns the canonical
// stored spelling. The tenantId is fixed at construction by the server and
// is never read from question text. Read-only; every query is filtered by
// tenantId. Names are compared on the router's normalized form (case,
// punctuation and spacing insensitive) but only EXACT normalized matches
// count - there is no fuzzy matching, so nothing is guessed.
// --------------------------------------------------

const { normalizeText } = require("./localRouter");

const READ_TIMEOUT_MS = 5000;

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

  async function index(dim) {
    if (!cache.has(dim)) {
      cache.set(
        dim,
        (async () => {
          const names = (await src[dim]()) || [];
          const map = new Map();
          for (const n of names) {
            if (typeof n !== "string" || !n.trim()) continue;
            const key = normalizeText(n);
            if (key && !map.has(key)) map.set(key, n);
          }
          return map;
        })()
      );
    }
    return cache.get(dim);
  }

  return async function resolveEntity({ entity, hintDim, text }) {
    const key = normalizeText(text || "");
    if (!key) return { matches: [] };
    let dims = entity === "sales" ? ["customer", "product", "productGroup"] : entity === "purchase" ? ["supplier", "product", "productGroup"] : ["customer", "supplier", "product", "productGroup"];
    if (hintDim) dims = dims.filter((d) => d === hintDim);
    const matches = [];
    for (const dim of dims) {
      const found = (await index(dim)).get(key);
      if (found) matches.push({ dim, value: found });
    }
    return { matches };
  };
}

module.exports = { createEntityResolver };
