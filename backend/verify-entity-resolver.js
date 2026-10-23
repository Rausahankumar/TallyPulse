"use strict";

/**
 * Tenant-scoped entity resolver (services/query/entityResolver.js): the one component that confirms a typed
 * customer / supplier / product / group name exists for THIS tenant. The planner re-verifies every name Claude used
 * through it.
 *
 * Fully offline: injected sources / fake models only - no MongoDB, no Tally, no Anthropic, no network.
 * (These checks used to live inside the router suite; the router is gone, the resolver is not.)
 * Run: node verify-entity-resolver.js
 */

const { createEntityResolver, defaultSources, ENTITY_RESOLVER_UNAVAILABLE } = require("./src/services/query/entityResolver");

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

  section("E. products come from the voucher lines (the Stock Item master only adds to them); every read is tenant-scoped");
  {
    const calls = [];
    const fakeModel = (label, byField) => ({
      distinct: (field, filter) => {
        calls.push({ label, field, filter });
        return { maxTimeMS: () => Promise.resolve(byField[field] || []) };
      },
    });
    const models = {
      Sale: fakeModel("Sale", { "header.partyName": ["Sold To Co"], "inventory.itemName": ["FEVICOL MR [20 GM]", "Shared Item"] }),
      Purchase: fakeModel("Purchase", { "header.partyName": ["Bought From Co"], "inventory.itemName": ["Bought Only Item", "shared item"] }),
      StockItemMaster: fakeModel("StockItemMaster", { itemName: ["Master Only Item", "Shared  Item"], stockGroupName: ["Adhesives"] }),
    };
    const sources = defaultSources("TENANT-E", models);
    const r = createEntityResolver({ tenantId: "TENANT-E", sources });
    const hit = async (text) => (await find(r, text, "product"))[0];
    check("a product that exists only on a sales line resolves, with the exact stored spelling (brackets included)", (await hit("fevicol mr 20 gm")) && (await hit("fevicol mr 20 gm")).value === "FEVICOL MR [20 GM]");
    check("a product that exists only on a purchase line resolves", !!(await hit("Bought Only Item")));
    check("a product that only the Stock Item master knows still resolves (an item with no voucher yet)", !!(await hit("master only item")));
    check("a name on a sales line and in the master resolves to ONE product, with the voucher spelling", (await find(r, "shared item", "product")).length === 1 && (await hit("shared item")).value === "Shared Item");
    check("a name nobody has stays unresolved", (await find(r, "Ghost Widget", "product")).length === 0);
    check("customers and suppliers are still read from the party name of the matching voucher type", (await find(r, "sold to co", "customer")).length === 1 && (await find(r, "bought from co", "supplier")).length === 1 && (await find(r, "sold to co", "supplier")).length === 0);
    check("the product group still comes from the Stock Item master", (await find(r, "adhesives", "productGroup")).length === 1);
    check("every read is filtered by this tenant", calls.length >= 6 && calls.every((c) => c.filter && c.filter.tenantId === "TENANT-E"), JSON.stringify(calls.map((c) => c.label + ":" + c.field)));
    check("the product read covers Sale and Purchase lines and the master", ["Sale:inventory.itemName", "Purchase:inventory.itemName", "StockItemMaster:itemName"].every((k) => calls.some((c) => `${c.label}:${c.field}` === k)));
    const before = calls.length;
    await find(r, "bought only item", "product");
    check("the lists are cached after the first read (no second read for the same dimension)", calls.length === before);
    const down = createEntityResolver({ tenantId: "TENANT-E", sources: defaultSources("TENANT-E", { ...models, Purchase: { distinct: () => ({ maxTimeMS: () => Promise.reject(new Error("timeout")) }) } }) });
    let code = null;
    try { await find(down, "fevicol mr 20 gm", "product"); } catch (e) { code = e.code; }
    check("if any one of the product reads fails the lookup is 'temporarily unavailable', never a partial list", code === ENTITY_RESOLVER_UNAVAILABLE);
  }

  section("F. did you mean: the closest stored names for a name that did not resolve (a list for the user, never a pick)");
  {
    const r = mk("T-F", {
      customer: ["Dhingra General Store", "Dhingra Traders", "Dhingra Hardware", "Dhingra Paints", "Sharma Enterprises", "Orbit Co"],
      supplier: ["Acme Foods Pvt Ltd"],
      product: ["FEVICOL MR [20 GM]", "FEVICOL SH 50 GM", "Maggi Noodles"],
    });
    const sg = (text, hintDim, entity = null) => r.suggest({ entity, hintDim, text }).then((x) => x.map((y) => y.value));
    check("a missing letter still finds the store", (await sg("Dhingr General Stor", "customer"))[0] === "Dhingra General Store");
    check("a different order of letters in one word still finds it", (await sg("Sharma Enterprizes", "customer"))[0] === "Sharma Enterprises");
    check("at most three names are offered", (await sg("Dhingra", "customer")).length === 3);
    check("the best match comes first and the order is stable", JSON.stringify(await sg("Dhingra", "customer")) === JSON.stringify(await sg("Dhingra", "customer")) && (await sg("dhingra general", "customer"))[0] === "Dhingra General Store");
    check("equal scores: the shorter name first, then a fixed order (same answer every time)", JSON.stringify(await sg("Dhingra", "customer")) === JSON.stringify(["Dhingra Paints", "Dhingra Traders", "Dhingra Hardware"]), JSON.stringify(await sg("Dhingra", "customer")));
    const rs = mk("T-F4", { customer: ["Acme Stores", "Acme Store Co"] });
    check("a better score beats a shorter name (an exact word is worth more than a near one)", (await rs.suggest({ hintDim: "customer", text: "acme store" })).map((x) => x.value).join("|") === "Acme Store Co|Acme Stores");
    check("a product name with a typo suggests the product", (await sg("Fevicol MR 20GM", "product"))[0] === "FEVICOL MR [20 GM]");
    check("an unrelated name gets no suggestions", (await sg("Zzzz Qqqq Xxxx", "customer")).length === 0);
    check("the hint dimension limits the suggestions (a customer name is never offered for a supplier)", (await sg("Dhingra", "supplier")).length === 0 && (await sg("Acme Foods", "supplier")).length === 1);
    check("entity 'sales' never offers suppliers; 'purchase' never offers customers", (await sg("Acme Foods Pvt", null, "sales")).length === 0 && (await sg("Dhingra", null, "purchase")).length === 0);
    check("empty text gives nothing", (await sg("", "customer")).length === 0 && (await sg("  --  ", "customer")).length === 0);
    const rB = mk("T-F2", { customer: ["Other Tenant Traders"] });
    check("suggestions come only from this tenant's own names", (await rB.suggest({ hintDim: "customer", text: "Dhingra General" })).length === 0);
    const failing = createEntityResolver({ tenantId: "T-F3", sources: { customer: async () => { throw new Error("db down"); }, supplier: async () => [], product: async () => [], productGroup: async () => [] } });
    let code = null;
    try { await failing.suggest({ hintDim: "customer", text: "Dhingra" }); } catch (e) { code = e.code; }
    check("a failed read while suggesting is reported as unavailable, never as 'no suggestions'", code === ENTITY_RESOLVER_UNAVAILABLE);
  }

  console.log(`\nverify-entity-resolver: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
