/**
 * LedgerMaster phase: Tally Ledger/Group master sync + "new customer/supplier"
 * (= Tally ledger CreatedDate inside the period, and traded in it).
 *
 *   A. parsing + party role from the group chain (pure)
 *   B. refreshLedgerMasters: ownership rejection, persistence, unchanged skip,
 *      rename, removal, mass-removal guard, tenant isolation (Mongo)
 *   C. schema / validator rules for the new_in_period filter (pure)
 *   E. executor end-to-end on synthetic Mongo data (engine vs hand-computed oracle),
 *      disclosures, missing master, tenant isolation, no N+1
 *
 * SYNTHETIC ONLY: made-up tenants, company GUIDs and party names; no live Tally,
 * no Anthropic calls. Every document written is deleted at the end.
 *
 * Run: node verify-ledger-master.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");
const LedgerMaster = require("./src/models/ledgerMaster.model");
const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const { parseGroupMasterList, parseLedgerMasterList, derivePartyRole, refreshLedgerMasters } = require("./src/services/tally/ledgerMaster");
const { parseQueryPlan } = require("./src/services/query/queryPlan.schema");
const { validateQueryPlan } = require("./src/services/query/validator");
const { executeQuery } = require("./src/services/query/execute");

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) pass += 1;
  else fail += 1;
  if (!ok) console.log(`  FAIL - ${label}${detail !== undefined ? ` (${detail})` : ""}`);
};
const section = (t) => console.log(`=== ${t} ===`);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------- synthetic fixtures
const CG = "aaaaaaaa-1111-2222-3333-bbbbbbbbbbbb"; // synthetic company GUID
const CG_OTHER = "cccccccc-4444-5555-6666-dddddddddddd";
const T1 = "TEST-TENANT-ledger-master-1";
const T2 = "TEST-TENANT-ledger-master-2";
const T_EMPTY = "TEST-TENANT-ledger-master-empty";
const ALL_T = [T1, T2, T_EMPTY];

const sv = (value, type = "String") => ({ type, value });
const group = (name, parent, hex, reserved = "", cg = CG) => ({ metadata: { type: "Group", name, reservedname: reserved }, parent: sv(parent), guid: sv(`${cg}-${hex}`) });
const ledger = (name, parent, hex, alterId, created, cg = CG) => {
  const e = { metadata: { type: "Ledger", name, reservedname: "" }, parent: sv(parent), guid: sv(`${cg}-${hex}`), alterid: sv(` ${alterId}`, "Number"), masterid: sv(` ${parseInt(hex, 16)}`, "Number") };
  if (created) e.createddate = sv(created, "Date");
  return e;
};
const payload = (collection) => ({ status: "1", data: { collection } });

const GROUPS = [
  group("Current Assets", "", "0001", "Current Assets"),
  group("Sundry Debtors", "Current Assets", "0002", "Sundry Debtors"),
  group("Current Liabilities", "", "0003", "Current Liabilities"),
  group("Sundry Creditors", "Current Liabilities", "0004", "Sundry Creditors"),
  group("Retail Buyers", "Sundry Debtors", "0005"), // nested sub-group
  group("Loop A", "Loop B", "0006"),
  group("Loop B", "Loop A", "0007"),
  group("Sales Accounts", "", "0008", "Sales Accounts"),
];
const LEDGERS = [
  ledger("Test Party One", "Sundry Debtors", "a001", 101, "20250403"),
  ledger("Test Party Two", "Retail Buyers", "a002", 102, "20251005"),
  ledger("Test Supplier One", "Sundry Creditors", "a003", 103, "20240110"),
  ledger("Test Sales Ledger", "Sales Accounts", "a004", 104, "20200101"),
  ledger("Test Undated Party", "Sundry Debtors", "a005", 105, null),
];

async function cleanup() {
  const ids = { $in: ALL_T };
  await Promise.all([LedgerMaster.deleteMany({ tenantId: ids }), Sale.deleteMany({ tenantId: ids }), Purchase.deleteMany({ tenantId: ids })]);
}

const fetchOk = (groups, ledgers) => ({
  fetchGroups: async () => payload(groups),
  fetchLedgers: async () => payload(ledgers),
});

let seq = 0;
const utc = (s) => new Date(`${s}T00:00:00.000Z`);
function voucher(tenantId, date, party, total, status = "active") {
  seq += 1;
  return {
    tenantId,
    tallyGuid: `${CG}-lm${seq}`,
    tallyAlterId: seq,
    voucherStatus: status,
    header: { voucherNo: `LM-${seq}`, voucherDate: utc(date), voucherType: "Invoice", voucherTotalAmount: total, narration: "", partyName: party },
    inventory: [{ itemName: "Test Item", quantity: 1, rate: total, amount: total }],
    ledgers: [],
  };
}
const lm = (tenantId, name, created, extra = {}) => ({
  tenantId,
  companyGuid: CG,
  ledgerGuid: `${CG}-${(seq += 1).toString(16)}`,
  name,
  parentGroup: "Sundry Debtors",
  partyRole: "debtor",
  alterId: seq,
  masterId: seq,
  createdDate: created ? utc(created) : null,
  syncedAt: new Date(),
  ...extra,
});

(async () => {
  await connectDB();
  await cleanup();
  try {
    // ============================================================ A
    section("A. parsing + party role");
    const pg = parseGroupMasterList(payload(GROUPS));
    const pl = parseLedgerMasterList(payload(LEDGERS));
    check("groups parsed with reserved names", pg.length === 8 && pg[1].reservedName === "Sundry Debtors" && pg[1].parent === "Current Assets");
    check("ledger fields parsed (guid, alterId, masterId, createdDate as UTC midnight)", pl[0].guid === `${CG}-a001` && pl[0].alterId === 101 && pl[0].masterId === 0xa001 && pl[0].createdDate.toISOString() === "2025-04-03T00:00:00.000Z");
    check("missing CreatedDate -> null (never invented)", pl[4].createdDate === null);
    const byName = new Map(pg.map((g) => [g.name, g]));
    check("direct Sundry Debtors -> debtor", derivePartyRole("Sundry Debtors", byName) === "debtor");
    check("nested sub-group of Sundry Debtors -> debtor", derivePartyRole("Retail Buyers", byName) === "debtor");
    check("Sundry Creditors -> creditor", derivePartyRole("Sundry Creditors", byName) === "creditor");
    check("other group -> other", derivePartyRole("Sales Accounts", byName) === "other");
    check("cyclic chain -> other (no loop)", derivePartyRole("Loop A", byName) === "other");
    check("unknown group -> other", derivePartyRole("Nope", byName) === "other");
    const renamed = new Map([["Customers", { name: "Customers", parent: "", reservedName: "Sundry Debtors" }]]);
    check("role follows Tally's reserved name, not the (renamed) group name", derivePartyRole("Customers", renamed) === "debtor");

    // ============================================================ B
    section("B. refreshLedgerMasters");
    let r = await refreshLedgerMasters({ tenantId: "", companyGuid: CG, ...fetchOk(GROUPS, LEDGERS) });
    check("no tenantId -> refused", !r.ok);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: "", ...fetchOk(GROUPS, LEDGERS) });
    check("no companyGuid -> refused", !r.ok);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, fetchGroups: async () => payload(GROUPS), fetchLedgers: async () => { throw new Error("tally down"); } });
    check("fetch failure -> refused, nothing written", !r.ok && (await LedgerMaster.countDocuments({ tenantId: T1 })) === 0);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, [...LEDGERS, ledger("Foreign Party", "Sundry Debtors", "f001", 900, "20251001", CG_OTHER)]) });
    check("one foreign ledger GUID -> whole list rejected, nothing written", !r.ok && (await LedgerMaster.countDocuments({ tenantId: T1 })) === 0, r.reason);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk([...GROUPS, group("Foreign Group", "", "f002", "", CG_OTHER)], LEDGERS) });
    check("one foreign group GUID -> rejected, nothing written", !r.ok && (await LedgerMaster.countDocuments({ tenantId: T1 })) === 0);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, []) });
    check("zero ledgers -> refused", !r.ok);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, fetchGroups: async () => payload(GROUPS), fetchLedgers: async () => "{not json" });
    check("malformed JSON -> refused", !r.ok);

    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, LEDGERS) });
    const stored = await LedgerMaster.find({ tenantId: T1 }).lean();
    check("valid refresh writes every ledger", r.ok && r.written === 5 && stored.length === 5, JSON.stringify(r));
    const p2 = stored.find((d) => d.name === "Test Party Two");
    check("stored doc: tenant, company, role via nested group, createdDate", p2.companyGuid === CG && p2.partyRole === "debtor" && p2.createdDate.toISOString() === "2025-10-05T00:00:00.000Z" && p2.removedAt === null);
    check("supplier ledger role = creditor", stored.find((d) => d.name === "Test Supplier One").partyRole === "creditor");
    check("undated ledger stored with createdDate null, counted", r.undated === 1 && stored.find((d) => d.name === "Test Undated Party").createdDate === null);

    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, LEDGERS) });
    check("unchanged list -> no writes", r.ok && r.unchanged === true && r.written === 0);
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, force: true, ...fetchOk(GROUPS, LEDGERS) });
    check("--force rewrites an unchanged list", r.ok && r.unchanged === false);

    const renamedList = LEDGERS.map((l) => (l.guid.value.endsWith("a001") ? { ...ledger("Test Party One Renamed", "Sundry Debtors", "a001", 201, "20250403") } : l));
    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, renamedList) });
    const afterRename = await LedgerMaster.find({ tenantId: T1, ledgerGuid: `${CG}-a001` }).lean();
    check("rename updates the SAME document (keyed by GUID)", r.ok && afterRename.length === 1 && afterRename[0].name === "Test Party One Renamed" && (await LedgerMaster.countDocuments({ tenantId: T1 })) === 5);

    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, renamedList.slice(0, 4)) });
    const gone = await LedgerMaster.findOne({ tenantId: T1, ledgerGuid: `${CG}-a005` }).lean();
    check("ledger missing from Tally -> marked removedAt, not deleted", r.ok && r.removed === 1 && gone && gone.removedAt instanceof Date);

    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, renamedList.slice(0, 1)) });
    check("removal of more than half the stored ledgers -> refused, nothing changed", !r.ok && (await LedgerMaster.countDocuments({ tenantId: T1, removedAt: null })) === 4, r.reason);

    r = await refreshLedgerMasters({ tenantId: T1, companyGuid: CG, ...fetchOk(GROUPS, renamedList) });
    check("re-appearing ledger is restored (removedAt cleared)", r.ok && (await LedgerMaster.findOne({ tenantId: T1, ledgerGuid: `${CG}-a005` }).lean()).removedAt === null);

    r = await refreshLedgerMasters({ tenantId: T2, companyGuid: CG, ...fetchOk(GROUPS, LEDGERS) });
    check("same ledgers under a second tenant: no collision, T1 untouched", r.ok && (await LedgerMaster.countDocuments({ tenantId: T2 })) === 5 && (await LedgerMaster.countDocuments({ tenantId: T1 })) === 5);
    await LedgerMaster.deleteMany({ tenantId: { $in: ALL_T } });

    // ============================================================ C
    section("C. schema + validator");
    const plan = (over = {}) => ({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-10-01", to: "2025-10-31" }, metrics: ["invoiceAmount"], groupBy: [{ dim: "customer" }], sort: [{ by: "invoiceAmount", dir: "desc" }], filters: [{ dim: "customer", op: "new_in_period", value: "period" }], ...over });
    check("schema accepts new_in_period on customer", parseQueryPlan(plan()).ok);
    check("schema rejects any other value", !parseQueryPlan(plan({ filters: [{ dim: "customer", op: "new_in_period", value: "Acme" }] })).ok);
    check("schema rejects new_in_period on product", !parseQueryPlan(plan({ filters: [{ dim: "product", op: "new_in_period", value: "period" }] })).ok);
    check("schema accepts new_in_period on supplier (purchase)", parseQueryPlan(plan({ entity: "purchase", metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "purchaseAmount", dir: "desc" }], filters: [{ dim: "supplier", op: "new_in_period", value: "period" }] })).ok);
    let v = validateQueryPlan(plan());
    check("validator: ok + ledger-created-date assumption", v.ok && v.assumptions.some((a) => a.code === "new_party_by_ledger_created_date"));
    v = validateQueryPlan(plan({ period: { kind: "all_time" } }));
    check("validator: all_time refused", !v.ok && v.errors.some((e) => e.code === "new_party_needs_period"));
    v = validateQueryPlan(plan({ period: { kind: "current_month" }, compare: { mode: "full_previous" } }), { referenceDate: new Date(2025, 9, 20, 12) });
    check("validator: a comparison is refused", !v.ok && v.errors.some((e) => e.code === "new_party_comparison_unsupported"));

    // ============================================================ E
    section("E. executor end-to-end (synthetic Mongo)");
    await LedgerMaster.insertMany([
      lm(T1, "Old Customer", "2023-01-01"),
      lm(T1, "New Customer A", "2025-10-03"),
      lm(T1, "New Customer B", "2025-10-20"),
      lm(T1, "Recreated Customer", "2025-10-05"),
      lm(T1, "Dup Name", "2025-10-07"),
      lm(T1, "Dup Name", "2020-06-01"),
      lm(T1, "New No Trade", "2025-10-09"),
      lm(T1, "Undated Customer", null),
      lm(T1, "Removed New", "2025-10-02", { removedAt: new Date() }),
      lm(T1, "New Supplier", "2025-10-11", { partyRole: "creditor" }),
      lm(T2, "Old Customer", "2025-10-15"), // other tenant: must never make T1's Old Customer new
    ]);
    await Sale.insertMany([
      voucher(T1, "2025-10-04", "Old Customer", 100),
      voucher(T1, "2025-10-06", "New Customer A", 200),
      voucher(T1, "2025-10-08", "New Customer A", 999, "cancelled"),
      voucher(T1, "2025-10-25", "New Customer B", 300),
      voucher(T1, "2025-09-10", "Recreated Customer", 70),
      voucher(T1, "2025-10-12", "Recreated Customer", 50),
      voucher(T1, "2025-10-13", "Dup Name", 40),
      voucher(T1, "2025-10-14", "Removed New", 10),
      voucher(T1, "2025-10-14", "Undated Customer", 15),
      voucher(T1, "2025-11-02", "New Customer B", 500), // after the period
      voucher(T2, "2025-10-16", "Old Customer", 777),
    ]);
    await Purchase.insertMany([voucher(T1, "2025-10-12", "New Supplier", 900), voucher(T1, "2025-10-12", "Old Customer", 60)]);

    // count reads on the master, to prove the resolution is a fixed number of queries (no N+1)
    let masterReads = 0;
    const onQuery = () => (masterReads += 1);
    mongoose.set("debug", (coll) => { if (coll === LedgerMaster.collection.collectionName) onQuery(); });
    let aggCalls = 0;
    const countingAggregate = async (model, pipeline, options) => {
      aggCalls += 1;
      return (model === "Sale" ? Sale : Purchase).aggregate(pipeline).option({ maxTimeMS: options.maxTimeMS }).exec();
    };

    let res = await executeQuery(plan(), { tenantId: T1, runAggregate: countingAggregate });
    const got = res.ok ? res.rows.map((row) => [row.key.customer, row.values.invoiceAmount]) : res;
    const oracle = [["New Customer B", 300], ["New Customer A", 200], ["Recreated Customer", 50]];
    check("engine = oracle: new customers in Oct (excludes old, removed, ambiguous, undated, cancelled, other tenant, after-period)", res.ok && same(got, oracle), JSON.stringify(got));
    mongoose.set("debug", false);
    const codes = res.ok ? res.warnings.map((w) => w.code) : [];
    check("discloses a party that traded before its ledger was created", codes.includes("new_party_traded_before_ledger") && res.warnings.find((w) => w.code === "new_party_traded_before_ledger").message.includes("Recreated Customer"));
    check("discloses ambiguous same-name ledgers", codes.includes("new_party_ambiguous_names"));
    check("discloses undated ledgers", codes.includes("new_party_undated_ledgers"));
    check("no stale-master note when the refresh is after the period", !codes.includes("ledger_master_as_of"));
    check("assumption states the definition", res.ok && res.assumptions.some((a) => a.code === "new_party_by_ledger_created_date"));
    check("no N+1: fixed master reads (<=4) and 2 aggregates, regardless of party count", masterReads >= 1 && masterReads <= 4 && res.ok && aggCalls === res.diagnostics.queryCount + 1, `master=${masterReads} agg=${aggCalls}`);

    res = await executeQuery(plan({ entity: "purchase", metrics: ["purchaseAmount"], groupBy: [{ dim: "supplier" }], sort: [{ by: "purchaseAmount", dir: "desc" }], filters: [{ dim: "supplier", op: "new_in_period", value: "period" }] }), { tenantId: T1 });
    check("new suppliers in Oct = [New Supplier 900] (role from the transaction side)", res.ok && same(res.rows.map((row) => [row.key.supplier, row.values.purchaseAmount]), [["New Supplier", 900]]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery(plan({ period: { kind: "custom", from: "2025-10-01", to: "2025-10-10" } }), { tenantId: T1 });
    check("narrower period changes the set (B created 20-Oct is excluded)", res.ok && same(res.rows.map((row) => row.key.customer), ["New Customer A"]), JSON.stringify(res.rows || res.errors));

    res = await executeQuery(plan(), { tenantId: T_EMPTY });
    check("no ledger master for the tenant -> refused (ledger_master_missing), never 'everyone is new'", !res.ok && res.errors[0].code === "ledger_master_missing");

    res = await executeQuery(plan(), {
      tenantId: T1,
      findNewParties: async () => ({ masterMissing: false, names: ["New Customer A", "New Customer B"], ambiguous: [], bulkDays: [{ day: "2025-10-03", names: ["New Customer A", "X"] }], undated: 0, syncedAt: new Date("2025-10-15T00:00:00Z") }),
    });
    check("bulk-created batch containing a traded party is disclosed", res.ok && res.warnings.some((w) => w.code === "new_party_bulk_created_ledgers" && w.message.includes("1 of these")));
    check("master refreshed before the period end -> as-of disclosure", res.ok && res.warnings.some((w) => w.code === "ledger_master_as_of"));

    res = await executeQuery(plan(), { tenantId: T1, findNewParties: async () => ({ masterMissing: false, names: new Array(6000).fill(0).map((_, i) => `N${i}`), ambiguous: [], bulkDays: [], undated: 0, syncedAt: new Date() }) });
    check("too many new ledgers -> refused, not truncated", !res.ok && res.errors[0].code === "result_too_large");
  } catch (error) {
    fail += 1;
    console.log("  FAIL - unexpected error:", error && error.stack);
  } finally {
    await cleanup();
    await mongoose.disconnect();
  }
  console.log(`\nverify-ledger-master: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
