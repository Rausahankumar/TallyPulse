"use strict";

/**
 * The PARITY SUITE (verify-query-parity.js) on synthetic data, so it runs in CI.
 *
 * verify-query-parity.js compares the generic Query Engine with the existing analytics (salesAnalytics,
 * purchaseAnalytics, stockGroupAnalytics) and with independently written JS oracles. Its comparisons are data-driven
 * (customer/product names, periods and rankings all come from the tenant's own vouchers), but its real-data run needs
 * the WE FOUR tenant, so it is NOT RUN in CI. This suite seeds two synthetic tenants into the isolated test database
 * and runs the SAME runParity() - every parity, ranking and assertion case unchanged - on them:
 *   - a large tenant (extended run): 140 Sales + 90 Purchase vouchers over Apr-Oct 2025, mapped and unmapped items,
 *     ~4% cancelled vouchers (must be excluded), purchase item amounts stored negative (Tally's sign), and four vouchers
 *     on the edges of the fixed August-2025 window (31 Jul, 1 Aug, 31 Aug, 1 Sep);
 *   - a small tenant whose customer names never overlap (cross-tenant isolation cases).
 * The reference date is the tenant's latest voucher, so the relative periods are deterministic.
 *
 * What this does NOT prove: that the engine matches real WE FOUR data shapes. The real-data run of
 * verify-query-parity.js stays as it is, for local runs against real data.
 *
 * Synthetic data only, isolated test database only (src/config/db.js refuses anything but a loopback
 * tallypulse_ci / tallypulse_test* database). No Tally, no Claude. Cleans up only its own records.
 *
 * Run: node verify-query-parity-synthetic.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("./src/config/db");

const Sale = require("./src/models/sales.model");
const Purchase = require("./src/models/purchase.model");
const StockItemMaster = require("./src/models/stockItemMaster.model");
const Company = require("./src/models/company");
const SyncCheckpoint = require("./src/models/syncCheckpoint.model");
const { runParity } = require("./verify-query-parity");

let fail = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  PASS - ${label}`);
  else {
    fail += 1;
    console.log(`  FAIL - ${label}${detail !== undefined ? ` (${String(detail).slice(0, 300)})` : ""}`);
  }
}

const BIG = { name: "Synthetic Parity Big Co", tenantId: "TEST-TENANT-parity-synthetic-big", guid: "verify-parity-synthetic-big", sales: 140, purchases: 90, suffix: "" };
const SMALL = { name: "Synthetic Parity Small Co", tenantId: "TEST-TENANT-parity-synthetic-small", guid: "verify-parity-synthetic-small", sales: 25, purchases: 15, suffix: " (Small Co)" };
const TENANTS = [BIG, SMALL];

// Deterministic pseudo-random sequence: the same fixture on every run.
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const utc = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (date, n) => new Date(date.getTime() + n * 86400000);

const ITEMS = ["Alpha Widget", "Beta Widget", "Gamma Cable", "Delta Cable", "Epsilon Box", "Zeta Box", "Eta Pipe", "Theta Pipe", "Iota Gear", "Kappa Gear", "Lambda Tape", "Mu Tape", "Nu Paint", "Xi Paint", "Unmapped Item One", "Unmapped Item Two"];
// The last two items have no stock group (unmapped lines are excluded from group breakdowns and disclosed).
const GROUPS = { "Alpha Widget": "Widgets", "Beta Widget": "Widgets", "Gamma Cable": "Cables", "Delta Cable": "Cables", "Epsilon Box": "Boxes", "Zeta Box": "Boxes", "Eta Pipe": "Pipes", "Theta Pipe": "Pipes", "Iota Gear": "Gears", "Kappa Gear": "Gears", "Lambda Tape": "Tapes", "Mu Tape": "Tapes", "Nu Paint": "Paints", "Xi Paint": "Paints" };
const CUSTOMERS = ["Synthetic Customer A", "Synthetic Customer B", "Synthetic Customer C", "Synthetic Customer D", "Synthetic Customer E", "Synthetic Customer F", "Synthetic Customer G"];
const SUPPLIERS = ["Synthetic Supplier P", "Synthetic Supplier Q", "Synthetic Supplier R", "Synthetic Supplier S"];

let guidSeq = 0;
function voucher(tenantId, kind, date, suffix, status) {
  guidSeq += 1;
  const lines = [];
  const n = 1 + Math.floor(rnd() * 3);
  let sum = 0;
  for (let l = 0; l < n; l += 1) {
    const qty = 1 + Math.floor(rnd() * 40);
    const rate = 10 + Math.floor(rnd() * 90);
    const amt = qty * rate;
    sum += amt;
    lines.push({ itemName: pick(ITEMS), quantity: qty, rate, amount: kind === "purchase" ? -amt : amt });
  }
  return {
    tenantId,
    tallyGuid: `syn-${tenantId}-${kind}-${guidSeq}`,
    tallyAlterId: guidSeq,
    voucherStatus: status || (rnd() < 0.04 ? "cancelled" : "active"),
    header: {
      voucherNo: `${kind === "purchase" ? "P" : "S"}-${guidSeq}`,
      voucherDate: date,
      voucherType: kind === "purchase" ? "Purchase" : "Invoice",
      voucherTotalAmount: Math.round(sum * 1.18 * 100) / 100,
      narration: "",
      partyName: pick(kind === "purchase" ? SUPPLIERS : CUSTOMERS) + suffix,
    },
    inventory: lines,
    ledgers: [],
  };
}

function vouchers(t, kind, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(voucher(t.tenantId, kind, addDays(utc(2025, 3, 1), Math.floor(rnd() * 200)), t.suffix));
  return out;
}

// Active vouchers exactly on and just outside the edges of the fixed custom_aug_2025 window (2025-08-01 .. 2025-08-31).
const BOUNDARY_DAYS = [utc(2025, 6, 31), utc(2025, 7, 1), utc(2025, 7, 31), utc(2025, 8, 1)];

async function cleanup() {
  const tenantIds = TENANTS.map((t) => t.tenantId);
  await Promise.all([
    Sale.deleteMany({ tenantId: { $in: tenantIds } }),
    Purchase.deleteMany({ tenantId: { $in: tenantIds } }),
    StockItemMaster.deleteMany({ tenantId: { $in: tenantIds } }),
    SyncCheckpoint.deleteMany({ tenantId: { $in: tenantIds } }),
  ]);
  await Company.deleteMany({ companyGuid: { $in: TENANTS.map((t) => t.guid) } });
}

async function seedTenant(t, extraSales = []) {
  await Company.create({ companyName: t.name, sourceType: "tally", companyGuid: t.guid, tenantId: t.tenantId, isActive: true });
  for (const voucherType of ["Sales", "Purchase", "Credit Note", "Debit Note"]) {
    await SyncCheckpoint.create({ tenantId: t.tenantId, companyGuid: t.guid, voucherType, lastAlterId: 1000, lastSyncedAt: new Date(), lastRunStatus: "success" });
  }
  await StockItemMaster.insertMany(Object.entries(GROUPS).map(([itemName, stockGroupName]) => ({ tenantId: t.tenantId, itemName, stockGroupName, tallyGuid: `syn-m-${t.tenantId}-${itemName}`, syncedAt: new Date() })));
  await Sale.insertMany([...vouchers(t, "sales", t.sales), ...extraSales]);
  await Purchase.insertMany(vouchers(t, "purchase", t.purchases));
}

(async () => {
  await connectDB();
  await cleanup();
  let parityFailures = 1;
  try {
    console.log("\n=== Seeding two synthetic tenants ===");
    await seedTenant(BIG, BOUNDARY_DAYS.map((d) => voucher(BIG.tenantId, "sales", d, BIG.suffix, "active")));
    await seedTenant(SMALL);

    const count = async (Model, t, extra = {}) => Model.countDocuments({ tenantId: t.tenantId, ...extra });
    check("large tenant: 144 Sales (140 + 4 boundary) and 90 Purchase vouchers seeded", (await count(Sale, BIG)) === 144 && (await count(Purchase, BIG)) === 90);
    check("small tenant: 25 Sales and 15 Purchase vouchers seeded", (await count(Sale, SMALL)) === 25 && (await count(Purchase, SMALL)) === 15);
    check("the fixture contains cancelled vouchers (active-only scope is exercised)", (await count(Sale, BIG, { voucherStatus: "cancelled" })) > 0);
    check("purchase item amounts are stored negative, as Tally sends them", (await Purchase.countDocuments({ tenantId: BIG.tenantId, "inventory.amount": { $gt: 0 } })) === 0);
    const perBoundaryDay = await Promise.all(BOUNDARY_DAYS.map((d) => Sale.countDocuments({ tenantId: BIG.tenantId, voucherStatus: "active", "header.voucherDate": d })));
    check("every August-window boundary day (31 Jul, 1 Aug, 31 Aug, 1 Sep) has an active Sales voucher", perBoundaryDay.every((n) => n >= 1), JSON.stringify(perBoundaryDay));
    const bigNames = new Set(await Sale.distinct("header.partyName", { tenantId: BIG.tenantId }));
    const smallNames = await Sale.distinct("header.partyName", { tenantId: SMALL.tenantId });
    check("the two tenants share no customer name (precondition of the cross-tenant cases)", smallNames.length > 0 && smallNames.every((n) => !bigNames.has(n)));

    console.log("\n=== Parity suite on the synthetic tenants (same cases as verify-query-parity.js) ===");
    parityFailures = await runParity({
      big: { tenantId: BIG.tenantId, name: BIG.name },
      other: { tenantId: SMALL.tenantId, name: SMALL.name },
    });
    check("the parity suite reports zero failed cases on the synthetic tenants", parityFailures === 0, `${parityFailures} failed`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL - unexpected error: ${e && e.stack ? e.stack : e}`);
  } finally {
    await cleanup();
    await mongoose.connection.close();
  }
  console.log(`\nverify-query-parity-synthetic: ${fail === 0 ? "all checks passed" : `${fail} failed`}`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error(e);
  try { await mongoose.connection.close(); } catch (_) {}
  process.exit(1);
});
