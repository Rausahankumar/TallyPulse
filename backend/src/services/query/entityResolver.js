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

const catalog = require("./semanticCatalog");

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
const SUGGEST_MAX = 3; // "did you mean" shows at most this many names
const SUGGEST_MIN_SCORE = 0.7; // average best-word similarity (0..1) a stored name needs to be offered
const ENTITY_RESOLVER_UNAVAILABLE = "ENTITY_RESOLVER_UNAVAILABLE";
const PREFIX_MIN_FIRST_WORD = 4; // a shorter first word ("a", "mr", "new") is too generic to stand for a stored name

// The catalog's name dimensions a typed name is matched against: those of the entity for sales or purchase, all of them
// otherwise (no entity, or a return entity).
const searchedDims = (entity) => catalog.nameDimensionIds(entity === "sales" || entity === "purchase" ? entity : undefined);

// `models` is injectable for tests ({Sale, Purchase, StockItemMaster}); production loads the real ones.
function defaultSources(tenantId, models) {
  const { Sale, Purchase, StockItemMaster } = models || {
    Sale: require("../../models/sales.model"),
    Purchase: require("../../models/purchase.model"),
    StockItemMaster: require("../../models/stockItemMaster.model"),
  };
  const names = (Model, field) => Model.distinct(field, { tenantId }).maxTimeMS(READ_TIMEOUT_MS);
  return {
    customer: () => names(Sale, "header.partyName"),
    supplier: () => names(Purchase, "header.partyName"),
    // The query engine's "product" is the item name on the voucher line (inventory.itemName), so the names that really appear on this
    // tenant's sales and purchase lines come first; the Stock Item master only adds items that have no voucher yet. Without this, a
    // tenant whose master is not synced could not name a single product.
    product: async () => {
      const [sold, bought, master] = await Promise.all([names(Sale, "inventory.itemName"), names(Purchase, "inventory.itemName"), names(StockItemMaster, "itemName")]);
      return [...sold, ...bought, ...master];
    },
    productGroup: () => names(StockItemMaster, "stockGroupName"),
  };
}

// Edit distance between two short words (two-row dynamic programming).
function editDistance(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// 0..1: how alike two words are. A typed word that is the start of a stored word (or the reverse) counts as a near match.
function wordSimilarity(a, b) {
  if (a === b) return 1;
  const longest = Math.max(a.length, b.length);
  const shortest = Math.min(a.length, b.length);
  if (shortest >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.9;
  return 1 - editDistance(a, b) / longest;
}

// How well a stored name fits what was typed: every typed word is matched to its closest stored word and the results are averaged;
// a stored name with many more words than were typed scores a little lower.
function nameScore(typedWords, storedWords) {
  let total = 0;
  for (const w of typedWords) total += Math.max(...storedWords.map((s) => wordSimilarity(w, s)));
  const average = total / typedWords.length;
  return average * (0.9 + 0.1 * Math.min(1, typedWords.length / storedWords.length));
}

/**
 * @param {{tenantId: *, sources?: object}} opts  `sources` is injectable for tests
 *        ({dim: async () => string[]}).
 *
 * The name lists are kept for the life of the resolver (the chat keeps one per tenant). When the tenant's data changes the lists
 * are only MARKED STALE (markStale), not dropped: a name found in a stale list is still a real stored name, so it answers at once
 * while the list reloads in the background; a name NOT found in a stale list waits for the fresh list before "no match" is said, so
 * a customer created a minute ago is never reported as unknown. Lists of the dimensions a question needs load in parallel.
 */
function createEntityResolver({ tenantId, sources } = {}) {
  if (!tenantId) throw new Error("createEntityResolver: tenantId is required");
  const src = sources || defaultSources(tenantId);
  const cache = new Map(); // dim -> { map: Map | null, loading: Promise | null, stale: boolean, gen: number }

  async function load(dim) {
    const names = await src[dim]();
    if (!Array.isArray(names)) throw new Error(`entity source "${dim}" did not return a list`);
    const map = new Map();
    for (const n of names) {
      if (typeof n !== "string" || !n.trim()) continue;
      const key = normalizeText(n);
      if (key && !map.has(key)) map.set(key, n);
    }
    return map;
  }

  // One load per dimension at a time. A failed load is NEVER cached: nothing is stored, the next question retries the read, and the
  // failure surfaces as ENTITY_RESOLVER_UNAVAILABLE - never as "no match" (an empty list is only ever a list the source really
  // returned). A load that started before the latest markStale does not make the list fresh (gen).
  function refresh(entry, dim) {
    if (!entry.loading) {
      const gen = entry.gen;
      const loading = load(dim).then(
        (map) => {
          entry.map = map;
          entry.stale = entry.gen !== gen;
          if (entry.loading === loading) entry.loading = null;
          return map;
        },
        (error) => {
          if (entry.loading === loading) entry.loading = null;
          const err = new Error(`Entity lookup is temporarily unavailable (${dim}).`);
          err.code = ENTITY_RESOLVER_UNAVAILABLE;
          err.cause = error;
          throw err;
        }
      );
      entry.loading = loading;
    }
    return entry.loading;
  }

  function index(dim, { allowStale = false } = {}) {
    let entry = cache.get(dim);
    if (!entry) {
      entry = { map: null, loading: null, stale: false, gen: 0 };
      cache.set(dim, entry);
    }
    // resolves { map, servedStale }: servedStale says the list handed back may be out of date (decided HERE, when it is handed back:
    // the background reload can finish a moment later and must not make an answer from the old list look like one from the new)
    if (!entry.map) return refresh(entry, dim).then((map) => ({ map, servedStale: false })); // first load: nothing to serve yet
    if (!entry.stale) return Promise.resolve({ map: entry.map, servedStale: false });
    if (allowStale) {
      refresh(entry, dim).catch(() => {}); // background; a failure keeps the old list (still stale, retried next time)
      return Promise.resolve({ map: entry.map, servedStale: true });
    }
    return refresh(entry, dim).then((map) => ({ map, servedStale: false }));
  }

  /** The tenant's data changed: every list is reloaded before it is next trusted for a "no match". */
  function markStale() {
    for (const entry of cache.values()) {
      entry.gen += 1;
      if (entry.map) entry.stale = true;
    }
  }

  async function lookup(key, dims, allowStale) {
    const got = await Promise.all(dims.map((d) => index(d, { allowStale }))); // parallel: the slowest list, not the sum
    const maps = got.map((g) => g.map);
    const servedStale = got.some((g) => g.servedStale);
    const matches = [];
    dims.forEach((dim, i) => {
      const found = maps[i].get(key);
      if (found) matches.push({ dim, value: found });
    });
    // Demo fix: people type the first word(s) of a stored name ("Dhingra" for "DHINGRA GENERAL STORE"). Only when
    // NO exact match exists, a typed name that is the leading whole word(s) of EXACTLY ONE stored name (across the
    // allowed kinds) resolves to it, flagged `partial` so the caller can say so. Two or more candidates -> no match.
    if (!matches.length && key.split(" ")[0].length >= PREFIX_MIN_FIRST_WORD) {
      const prefix = `${key} `;
      const hits = [];
      for (let i = 0; i < dims.length && hits.length <= 1; i += 1) {
        for (const [k, v] of maps[i]) {
          if (k.startsWith(prefix)) {
            hits.push({ dim: dims[i], value: v });
            if (hits.length > 1) break;
          }
        }
      }
      if (hits.length === 1) matches.push({ ...hits[0], partial: true });
    }
    return { matches, servedStale };
  }

  async function resolveEntity({ entity, hintDim, text }) {
    const key = normalizeText(text || "");
    if (!key) return { matches: [] };
    let dims = searchedDims(entity);
    if (hintDim) dims = dims.filter((d) => d === hintDim);
    let found = await lookup(key, dims, true);
    // nothing found in a list that may be out of date: wait for the fresh one before saying so
    if (!found.matches.length && found.servedStale) found = await lookup(key, dims, false);
    return { matches: found.matches };
  }

  // "Did you mean": the closest stored names (at most SUGGEST_MAX) for a name that did not resolve. Same tenant data and the same
  // dimensions as resolveEntity; nothing here ever picks a name for the caller - it only lists candidates to show the user.
  async function suggest({ entity, hintDim, text }) {
    const typed = normalizeText(text || "").split(" ").filter(Boolean);
    if (!typed.length) return [];
    let dims = searchedDims(entity);
    if (hintDim) dims = dims.filter((d) => d === hintDim);
    const maps = (await Promise.all(dims.map((d) => index(d)))).map((g) => g.map);
    const scored = [];
    dims.forEach((dim, i) => {
      for (const [key, value] of maps[i]) {
        const score = nameScore(typed, key.split(" "));
        if (score >= SUGGEST_MIN_SCORE) scored.push({ dim, value, score });
      }
    });
    scored.sort((x, y) => y.score - x.score || x.value.length - y.value.length || (x.value < y.value ? -1 : 1));
    return scored.slice(0, SUGGEST_MAX).map(({ dim, value }) => ({ dim, value }));
  }

  resolveEntity.suggest = suggest;
  resolveEntity.markStale = markStale;
  // read-only view for tests and diagnostics: which lists are loaded and which are waiting to be reloaded
  resolveEntity.state = () => Object.fromEntries([...cache].map(([dim, e]) => [dim, { loaded: !!e.map, stale: e.stale }]));
  return resolveEntity;
}

module.exports = { createEntityResolver, defaultSources, ENTITY_RESOLVER_UNAVAILABLE };
