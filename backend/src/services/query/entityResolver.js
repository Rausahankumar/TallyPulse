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
const ENTITY_RESOLVER_UNAVAILABLE = "ENTITY_RESOLVER_UNAVAILABLE";
const DIMS = ["customer", "supplier", "product", "productGroup"];
const MAX_SPAN_TOKENS = 20;

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
    return { matches };
  }

  // ---- span index (P1-2): the SAME four tenant-scoped indexes viewed as one set of known names, so the
  // router can mark a known name as opaque before its grammar runs. Built only from this resolver's own
  // loads - never a global index - and dropped with the resolver. A failed load is not cached (see index()).
  let known = null;
  function knownNames() {
    if (!known) {
      const building = Promise.all(DIMS.map((d) => index(d)))
        .then((maps) => {
          const keys = new Set();
          const raw = new Set();
          let maxTokens = 1;
          for (const m of maps) {
            for (const [key, value] of m) {
              keys.add(key);
              raw.add(value.trim());
              maxTokens = Math.max(maxTokens, key.split(" ").length);
            }
          }
          return { keys, raw: [...raw].filter(Boolean), maxTokens: Math.min(maxTokens, MAX_SPAN_TOKENS), literalsByPick: new WeakMap() };
        })
        .catch((error) => {
          if (known === building) known = null;
          throw error;
        });
      known = building;
    }
    return known;
  }

  const spanIndex = {
    /**
     * Leftmost-longest known-name spans over normalized tokens. `accept(slice)` lets the caller veto a span
     * (e.g. one made only of grammar words). Deterministic: scans left to right, longest first, no overlaps.
     */
    async findSpans(tokens, accept = () => true) {
      const { keys, maxTokens } = await knownNames();
      const spans = [];
      for (let i = 0; i < tokens.length; ) {
        let hit = 0;
        for (let n = Math.min(maxTokens, tokens.length - i); n >= 1; n -= 1) {
          const slice = tokens.slice(i, i + n);
          if (keys.has(slice.join(" ")) && accept(slice)) {
            hit = n;
            break;
          }
        }
        if (hit) {
          spans.push({ start: i, end: i + hit, text: tokens.slice(i, i + hit).join(" ") });
          i += hit;
        } else i += 1;
      }
      return spans;
    },
    /**
     * Exact (case-insensitive) occurrences in the RAW question of stored names chosen by `pick` - used only
     * for names whose own characters the router's input gate would reject. Longest names first, no overlaps,
     * whole-word boundaries. Returns character offsets; nothing is interpreted.
     */
    async findLiterals(raw, pick = () => false) {
      const loaded = await knownNames();
      const lower = String(raw).toLowerCase();
      // Candidates depend only on the loaded names and the caller's (stable) predicate: computed once per load.
      let ordered = loaded.literalsByPick.get(pick);
      if (!ordered) {
        const variants = new Set();
        for (const n of loaded.raw) {
          if (!pick(n)) continue;
          variants.add(n);
          const bare = n.replace(/^[\s*.,-]+|[\s*.,-]+$/g, ""); // "* Fevikwik 203 [20gm]20" is typed without "* "
          if (bare) variants.add(bare);
        }
        ordered = [...variants].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
        loaded.literalsByPick.set(pick, ordered);
      }
      const found = [];
      for (const name of ordered) {
        const needle = name.toLowerCase();
        for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
          const end = at + needle.length;
          const bounded = !/[a-z0-9]/i.test(raw[at - 1] || "") && !/[a-z0-9]/i.test(raw[end] || "");
          if (bounded && !found.some((f) => at < f.end && end > f.start)) found.push({ start: at, end, name });
        }
      }
      return found.sort((a, b) => a.start - b.start);
    },
  };
  resolveEntity.spanIndex = spanIndex;
  return resolveEntity;
}

module.exports = { createEntityResolver, ENTITY_RESOLVER_UNAVAILABLE };
