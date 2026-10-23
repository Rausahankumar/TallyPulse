"use strict";

/**
 * Tenant-scoped entity resolver (services/query/entityResolver.js): the one component that confirms a typed
 * customer / supplier / product / group name exists for THIS tenant. The planner re-verifies every name Claude used
 * through it.
 *
 * Fully offline: injected sources only - no MongoDB, no Tally, no Anthropic, no network.
 * (These checks used to live inside the router suite; the router is gone, the resolver is not.)
 * Run: node verify-entity-resolver.js
 */

const { createEntityResolver, ENTITY_RESOLVER_UNAVAILABLE } = require("./src/services/query/entityResolver");

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const mk = (tenantId, names) => createEntityResolver({ tenantId, sources: Object.fromEntries(["customer", "supplier", "product", "productGroup"].map((d) => [d, async () => names[d] || []])) });
const find = (r, text, hintDim = null, entity = null) => r({ entity, hintDim, text }).then((x) => x.matches);

(async () => {
  section("A. exact matches on the normalized form (case, punctuation and spacing insensitive)");
  {
    const r = mk("T", { customer: ["Dhingra General Store", "AT&T Co.", "M/S A.B. Traders (P) Ltd."], supplier: ["Acme Foods Pvt Ltd"], product: ["Maggi Noodles"], productGroup: ["Snacks"] });
    const one = await find(r, "dhingra   GENERAL store", "customer");
    check("case and spacing do not matter; the canonical stored spelling is returned", one.length === 1 && one[0].value === "Dhingra General Store" && one[0].dim === "customer" && !one[0].partial);
    check("punctuation does not matter", (await find(r, "at and t co", "customer")).length === 1);
    check("entity 'sales' only looks at customers, products and groups (never suppliers)", (await find(r, "Acme Foods Pvt Ltd", null, "sales")).length === 0);
    check("entity 'purchase' looks at suppliers", (await find(r, "Acme Foods Pvt Ltd", null, "purchase")).length === 1);
    check("a name that exists as a product resolves with its dimension", (await find(r, "maggi noodles", null, "sales"))[0].dim === "product");
    check("empty or punctuation-only text matches nothing", (await find(r, "")).length === 0 && (await find(r, "  --  ")).length === 0);
    check("an unknown name resolves to nothing (never invented)", (await find(r, "Ghost Traders", "customer")).length === 0);
  }

  section("B. partial names: the unique leading word(s) of exactly one stored name");
  {
    const r = mk("DEMO-T", { customer: ["Acme Trading Store", "Zenith Mart", "Zenith Stores", "Orbit Co", "Orbit Co Pvt"], supplier: ["Vendor Works Ltd"], product: ["Widget Pro 10"] });
    const one = await find(r, "acme");
    check("unique leading word resolves to the stored name, flagged partial", one.length === 1 && one[0].value === "Acme Trading Store" && one[0].partial === true);
    check("two names share the leading word -> no match (never guessed)", (await find(r, "zenith")).length === 0);
    const orbit = await find(r, "orbit co");
    check("an exact match always wins over a longer name (no partial flag)", orbit.length === 1 && orbit[0].partial !== true);
    check("a word that is not the START of a name does not resolve", (await find(r, "trading")).length === 0 && (await find(r, "store")).length === 0);
    check("a short first word (<4 chars) never prefix-matches", (await find(r, "orb")).length === 0 && (await find(r, "wid")).length === 0);
    check("the hint dimension still limits the prefix match", (await find(r, "acme", "supplier")).length === 0 && (await find(r, "vendor", "supplier")).length === 1);
  }

  section("C. tenant isolation (the tenant is fixed at construction and never read from text)");
  {
    const rA = mk("A", { customer: ["Only-A Traders", "Common Co"], product: ["A-only Widget"] });
    const rB = mk("B", { customer: ["Only-B Traders", "Common Co"], product: ["B-only Widget"] });
    check("A resolves A-only customer; B cannot", (await find(rA, "only-a traders", "customer")).length === 1 && (await find(rB, "Only-A Traders", "customer")).length === 0);
    check("B resolves B-only customer; A cannot", (await find(rB, "only-b traders", "customer")).length === 1 && (await find(rA, "Only-B Traders", "customer")).length === 0);
    check("A cannot resolve B-only product; B cannot resolve A-only product", (await find(rA, "B-only Widget", "product")).length === 0 && (await find(rB, "A-only Widget", "product")).length === 0);
    check("a shared name resolves independently in both tenants", (await find(rA, "common co", "customer")).length === 1 && (await find(rB, "common co", "customer")).length === 1);
    check("prefix matching is per tenant (a foreign tenant cannot see it)", (await find(mk("U", { customer: ["Other Co"] }), "acme")).length === 0);
    let threw = false;
    try {
      createEntityResolver({});
    } catch (e) {
      threw = true;
    }
    let threw2 = false;
    try {
      createEntityResolver({ sources: {} });
    } catch (e) {
      threw2 = true;
    }
    check("a resolver cannot be created without a server-supplied tenantId", threw && threw2);
  }

  section("D. a failed lookup is 'temporarily unavailable' - never 'not found', never cached, never guessed");
  {
    const NAMES = { customer: ["Dhingra General Store"], supplier: ["Acme Foods Pvt Ltd"], product: ["Maggi Noodles"], productGroup: ["Snacks"] };
    const mkFlaky = (failDim, failTimes = 1) => {
      const loads = { customer: 0, supplier: 0, product: 0, productGroup: 0 };
      const sources = {};
      for (const [dim, names] of Object.entries(NAMES)) {
        sources[dim] = async () => {
          loads[dim] += 1;
          if (dim === failDim && loads[dim] <= failTimes) throw new Error("MongoNetworkError: connection reset (secret-host:27017)");
          return names;
        };
      }
      return { resolveEntity: createEntityResolver({ tenantId: "TEST-TENANT", sources }), loads };
    };
    const ask = (f) => f.resolveEntity({ entity: "sales", hintDim: "customer", text: "Dhingra General Store" });

    const flaky = mkFlaky("customer", 1);
    let err = null;
    try {
      await ask(flaky);
    } catch (e) {
      err = e;
    }
    check("a failed load rejects with ENTITY_RESOLVER_UNAVAILABLE (not an empty match list)", !!err && err.code === ENTITY_RESOLVER_UNAVAILABLE);
    check("the error message carries no database detail", !!err && !/secret-host|Mongo/.test(err.message));
    const again = await ask(flaky);
    check("the next request after a failure does a fresh load and recovers", flaky.loads.customer === 2 && again.matches.length === 1 && again.matches[0].value === "Dhingra General Store");
    await ask(flaky);
    check("once loaded, the good list is cached again (no reload per question)", flaky.loads.customer === 2);

    const persist = mkFlaky("customer", 5);
    for (let i = 0; i < 3; i += 1) {
      try {
        await persist.resolveEntity({ entity: "sales", hintDim: "customer", text: "x y" });
      } catch (e) {
        /* expected */
      }
    }
    check("a persistent outage retries on every request (nothing is poisoned)", persist.loads.customer === 3);

    const badShape = createEntityResolver({ tenantId: "TEST-TENANT", sources: { customer: async () => null, supplier: async () => [], product: async () => [], productGroup: async () => [] } });
    let shapeErr = null;
    try {
      await badShape({ entity: "sales", hintDim: "customer", text: "Dhingra General Store" });
    } catch (e) {
      shapeErr = e;
    }
    check("a source that returns no list is a failure, not 'no such name'", !!shapeErr && shapeErr.code === ENTITY_RESOLVER_UNAVAILABLE);

    for (const dim of ["customer", "supplier", "product", "productGroup"]) {
      const f = mkFlaky(dim, 1);
      let e2 = null;
      try {
        await f.resolveEntity({ entity: null, hintDim: dim, text: NAMES[dim][0] });
      } catch (e) {
        e2 = e;
      }
      const ok = await f.resolveEntity({ entity: null, hintDim: dim, text: NAMES[dim][0] });
      check(`${dim}: a failed load is an outage, and the same resolver recovers on the next request`, !!e2 && e2.code === ENTITY_RESOLVER_UNAVAILABLE && ok.matches.length === 1);
    }

    const tA = mkFlaky("customer", 1);
    const tB = createEntityResolver({ tenantId: "TEST-TENANT-B", sources: { customer: async () => ["Kestrel Traders"], supplier: async () => [], product: async () => [], productGroup: async () => [] } });
    let aDown = false;
    try {
      await tA.resolveEntity({ entity: "sales", hintDim: "customer", text: "Kestrel Traders" });
    } catch (e) {
      aDown = e.code === ENTITY_RESOLVER_UNAVAILABLE;
    }
    const bOk = await tB({ entity: "sales", hintDim: "customer", text: "Kestrel Traders" });
    const aAfter = await tA.resolveEntity({ entity: "sales", hintDim: "customer", text: "Kestrel Traders" });
    check("tenant A's outage does not affect B; after recovery A still cannot see B's customer", aDown && bOk.matches.length === 1 && aAfter.matches.length === 0);
  }

  console.log(`\nverify-entity-resolver: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
