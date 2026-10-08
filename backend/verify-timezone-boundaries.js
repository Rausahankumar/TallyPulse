"use strict";

/**
 * Period boundaries vs stored voucher dates must not depend on the server's time zone.
 *
 * The contract being verified (docs/PROJECT_CONTEXT.md, "Date boundaries"):
 *   - a voucher's date is stored as UTC midnight of its Tally calendar date (parseTallyDate), whatever the server's zone;
 *   - "today" and every period are calendar days of the server's calendar (periodEngine builds them from local dates);
 *   - so for a given calendar reference day, the SAME business dates must fall inside "Aug 1-31", "this month", "last
 *     FY"... in every zone. Before the fix, west of UTC an Aug 1 voucher fell before the "Aug 1" start (04:00Z in New York)
 *     and an Aug 21 voucher fell inside "Aug 20" (ends Aug 21 03:59Z).
 *
 * Every zone runs in its own child process (TZ is read at process start). Each worker builds the SAME synthetic
 * UTC-midnight voucher dates, resolves periods through the real validator + compiler + analytics scope, evaluates the
 * compiled first $match stage against those dates in memory, and compares with an independent oracle that only compares
 * calendar-date strings. Pure: no database, no network, no Tally, no Claude (the child env has a dead Mongo URI).
 *
 * Run: node verify-timezone-boundaries.js
 */

const WORKER = process.env.TZ_BOUNDARY_WORKER === "1";
const ZONES = ["UTC", "Asia/Kolkata", "America/New_York", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kathmandu"];

if (!WORKER) {
  const { spawnSync } = require("child_process");
  let total = 0;
  let failed = 0;
  for (const zone of ZONES) {
    const r = spawnSync(process.execPath, [__filename], {
      env: { ...process.env, TZ: zone, TZ_BOUNDARY_WORKER: "1", MONGODB_URI: "mongodb://127.0.0.1:1/dead_never_used?serverSelectionTimeoutMS=500", AI_USAGE_PERSIST: "off", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "" },
      encoding: "utf8",
      timeout: 120000,
    });
    const out = (r.stdout || "") + (r.stderr || "");
    process.stdout.write(out.replace(/^[^\n]*injected env[^\n]*\n/gm, ""));
    const m = /ZONE_RESULT (\d+) (\d+)/.exec(out);
    if (!m) {
      failed += 1;
      console.log(`  FAIL - ${zone}: the worker did not finish (exit ${r.status})`);
    } else {
      total += Number(m[1]) + Number(m[2]);
      failed += Number(m[2]);
    }
  }
  console.log(`\n=== RESULT: ${total - failed} passed, ${failed} failed (${ZONES.length} zones) ===`);
  process.exitCode = failed ? 1 : 0;
} else {
  const dateRanges = require("./src/services/analytics/dateRanges");
  const { validateQueryPlan } = require("./src/services/query/validator");
  const { compileQuery } = require("./src/services/query/compile");
  const { buildVoucherMatchStage } = require("./src/services/analytics/analyticsScope");
  const { buildDateContext } = require("./src/services/analytics/referenceDate");
  const { assessCoverage } = require("./src/services/analytics/coverage");

  let pass = 0;
  let fail = 0;
  const zone = process.env.TZ;
  const check = (label, cond, detail) => {
    if (cond) {
      pass += 1;
      console.log(`  PASS - [${zone}] ${label}`);
    } else {
      fail += 1;
      console.log(`  FAIL - [${zone}] ${label}${detail !== undefined ? ` (${detail})` : ""}`);
    }
  };
  const section = (t) => console.log(`\n=== [${zone}] ${t} ===`);

  // ---- the synthetic business dates, stored exactly as parseTallyDate stores them
  const DAYS = ["2025-03-31", "2025-04-01", "2025-06-30", "2025-07-01", "2025-07-20", "2025-07-21", "2025-07-31", "2025-08-01", "2025-08-15", "2025-08-20", "2025-08-21", "2025-08-31", "2025-09-01", "2025-09-10"];
  const stored = (iso) => new Date(`${iso}T00:00:00.000Z`);
  // ---- independent oracle: calendar-date STRING comparison, nothing shared with the code under test
  const oracle = (fromIso, toIso) => DAYS.filter((d) => d >= fromIso && d <= toIso);
  // ---- evaluate a compiled $match on the stored dates, in memory
  const inMatch = (match) => {
    const r = match["header.voucherDate"] || {};
    return DAYS.filter((d) => {
      const t = stored(d).getTime();
      return (!r.$gte || t >= r.$gte.getTime()) && (!r.$lte || t <= r.$lte.getTime());
    });
  };
  const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const resolve = (period, ref, compare) => {
    const plan = { v: 1, entity: "sales", mode: "aggregate", period, metrics: ["invoiceAmount"], filters: [], ...(compare ? { compare } : {}) };
    const v = validateQueryPlan(plan, { referenceDate: ref });
    if (!v.ok) throw new Error(`invalid plan: ${v.errors.map((e) => e.code).join(",")}`);
    const c = compileQuery(v.normalized, { tenantId: "T" });
    const byKey = {};
    for (const q of c.queries) byKey[q.key] = inMatch(q.pipeline[0].$match);
    return { normalized: v.normalized, byKey, queries: c.queries };
  };
  const cur = (r) => r.byKey.current || r.byKey[Object.keys(r.byKey)[0]];

  // sanity: the worker really runs in the requested zone
  const offJan = new Date(2025, 0, 15).getTimezoneOffset();
  const offAug = new Date(2025, 7, 15).getTimezoneOffset();
  const EXPECTED_OFFSETS = { UTC: [0, 0], "Asia/Kolkata": [-330, -330], "America/New_York": [300, 240], "America/Los_Angeles": [480, 420], "Pacific/Auckland": [-780, -720], "Asia/Kathmandu": [-345, -345] };
  check(`the process runs in ${zone} (offsets Jan/Aug ${offJan}/${offAug} min)`, sameList(EXPECTED_OFFSETS[zone], [offJan, offAug]));

  // ---------------------------------------------------------------------------------------------------------------
  section("1. custom range: Aug 1-31 includes exactly the business dates Aug 1..Aug 31");
  {
    const REF = new Date(2025, 8, 10, 12, 0, 0);
    const r = resolve({ kind: "custom", from: "2025-08-01", to: "2025-08-31" }, REF);
    check("compiled match includes exactly 2025-08-01..2025-08-31", sameList(cur(r), oracle("2025-08-01", "2025-08-31")), JSON.stringify(cur(r)));
    check("the day before (Jul 31) and the day after (Sep 1) are outside", !cur(r).includes("2025-07-31") && !cur(r).includes("2025-09-01"));
    check("Aug 1 (first day) and Aug 31 (last day) are inside", cur(r).includes("2025-08-01") && cur(r).includes("2025-08-31"));
    const one = resolve({ kind: "custom", from: "2025-08-20", to: "2025-08-20" }, REF);
    check("a one-day range [Aug 20, Aug 20] matches only Aug 20", sameList(cur(one), ["2025-08-20"]), JSON.stringify(cur(one)));
    const direct = buildVoucherMatchStage({ tenantId: "T", from: dateRanges.customRange("2025-08-01", "2025-08-31").from, to: dateRanges.customRange("2025-08-01", "2025-08-31").to });
    check("the REST path (customRange -> buildVoucherMatchStage) selects the same dates", sameList(inMatch(direct), oracle("2025-08-01", "2025-08-31")));
    const strs = buildVoucherMatchStage({ tenantId: "T", from: "2025-08-01", to: "2025-08-31" });
    check("YYYY-MM-DD strings given to the scope builder are calendar days too", sameList(inMatch(strs), oracle("2025-08-01", "2025-08-31")));
    check("customRange reads a YYYY-MM-DD string as that calendar day (local midnight .. local 23:59:59.999)", (() => {
      const c = dateRanges.customRange("2025-08-01", "2025-08-31");
      return c.from.getFullYear() === 2025 && c.from.getMonth() === 7 && c.from.getDate() === 1 && c.from.getHours() === 0 && c.to.getMonth() === 7 && c.to.getDate() === 31 && c.to.getHours() === 23 && c.to.getMilliseconds() === 999;
    })());
  }

  // ---------------------------------------------------------------------------------------------------------------
  section("2. current_month around an Aug 20 reference (any time of the local day)");
  for (const [label, ref] of [["noon", new Date(2025, 7, 20, 12, 0, 0)], ["00:30", new Date(2025, 7, 20, 0, 30, 0)], ["23:30", new Date(2025, 7, 20, 23, 30, 0)], ["end of day", new Date(2025, 7, 20, 23, 59, 59, 999)]]) {
    const r = resolve({ kind: "current_month" }, ref);
    check(`reference Aug 20 ${label}: month to date = Aug 1..Aug 20`, sameList(cur(r), oracle("2025-08-01", "2025-08-20")), JSON.stringify(cur(r)));
  }
  {
    const r = resolve({ kind: "current_month" }, new Date(2025, 7, 20, 12, 0, 0));
    check("Aug 1 is inside and Jul 31 / Aug 21 are outside", cur(r).includes("2025-08-01") && !cur(r).includes("2025-07-31") && !cur(r).includes("2025-08-21"));
  }

  // ---------------------------------------------------------------------------------------------------------------
  section("3. other relative periods and comparisons");
  {
    const REF = new Date(2025, 8, 10, 12, 0, 0);
    check("previous_month on Sep 10 = Aug 1..Aug 31", sameList(cur(resolve({ kind: "previous_month" }, REF)), oracle("2025-08-01", "2025-08-31")));
    check("today (Sep 10) = Sep 10 only", sameList(cur(resolve({ kind: "today" }, REF)), ["2025-09-10"]));
    const fy = resolve({ kind: "current_fy" }, new Date(2025, 7, 20, 12, 0, 0));
    check("current_fy on Aug 20 2025 = Apr 1 2025..Aug 20 2025 (Mar 31 outside, Apr 1 inside)", sameList(cur(fy), oracle("2025-04-01", "2025-08-20")) && !cur(fy).includes("2025-03-31") && cur(fy).includes("2025-04-01"), JSON.stringify(cur(fy)));
    const cmp = resolve({ kind: "current_month" }, new Date(2025, 7, 20, 12, 0, 0), { mode: "like_for_like" });
    const prevKey = Object.keys(cmp.byKey).find((k) => k.endsWith("previous"));
    check("like-for-like comparison: current Aug 1..20, previous Jul 1..20 (Jul 21 outside)", sameList(cur(cmp), oracle("2025-08-01", "2025-08-20")) && sameList(cmp.byKey[prevKey], oracle("2025-07-01", "2025-07-20")), JSON.stringify(cmp.byKey));
    const fullPrev = resolve({ kind: "current_month" }, new Date(2025, 7, 20, 12, 0, 0), { mode: "full_previous" });
    const fpKey = Object.keys(fullPrev.byKey).find((k) => k.endsWith("previous"));
    check("complete-previous-month comparison: Jul 1..Jul 31", sameList(fullPrev.byKey[fpKey], oracle("2025-07-01", "2025-07-31")));
    const lastN = resolve({ kind: "last_30_days" }, new Date(2025, 7, 20, 12, 0, 0));
    check("last_30_days on Aug 20 = Jul 22..Aug 20 (Jul 21 outside)", sameList(cur(lastN), oracle("2025-07-22", "2025-08-20")), JSON.stringify(cur(lastN)));
  }

  // ---------------------------------------------------------------------------------------------------------------
  section("4. grouping stays on the business date (bucket keys are UTC, like the stored dates)");
  {
    const REF = new Date(2025, 8, 10, 12, 0, 0);
    const plan = (bucket) => ({ v: 1, entity: "sales", mode: "aggregate", period: { kind: "custom", from: "2025-08-01", to: "2025-08-31" }, metrics: ["invoiceAmount"], filters: [], groupBy: [{ dim: "date", bucket }], sort: [{ by: "date", dir: "asc" }] });
    for (const bucket of ["day", "week", "month", "quarter", "fy"]) {
      const v = validateQueryPlan(plan(bucket), { referenceDate: REF });
      const text = v.ok ? JSON.stringify(compileQuery(v.normalized, { tenantId: "T" }).queries.map((q) => q.pipeline)) : "";
      const specs = [...text.matchAll(/"timezone":"([^"]+)"/g)].map((m) => m[1]);
      check(`${bucket} bucket expression pins timezone UTC on every date operator (no server-zone dependence)`, v.ok && specs.length >= 1 && specs.every((s) => s === "UTC"), specs.join());
    }
    const { formatDateKey } = require("./src/services/query/execute");
    check("a stored Aug 1 00:00Z day bucket is the label 2025-08-01", formatDateKey("day", stored("2025-08-01")).label === "2025-08-01");
    check("a stored Aug 1 00:00Z month bucket is 2025-08", formatDateKey("month", stored("2025-08-01")).label === "2025-08");
    check("a stored Aug 4 00:00Z (Monday) week bucket is 'week of 2025-08-04'", formatDateKey("week", stored("2025-08-04")).label === "week of 2025-08-04");
  }

  // ---------------------------------------------------------------------------------------------------------------
  section("5. coverage window and the future-voucher check compare calendar days");
  {
    const wall = new Date(2025, 7, 20, 12, 0, 0);
    const bounds = (lastIso, firstIso = "2025-04-01") => ({ sales: { earliest: stored(firstIso), latest: stored(lastIso) }, purchase: { earliest: null, latest: null }, lastSyncedAt: null });
    const sameDay = buildDateContext(bounds("2025-08-20"), wall);
    check("a voucher dated TODAY (Aug 20) is not a future voucher", sameDay.futureVouchers === false);
    const tomorrow = buildDateContext(bounds("2025-08-21"), wall);
    check("a voucher dated TOMORROW (Aug 21) is a future voucher", tomorrow.futureVouchers === true);
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    check("the coverage window starts and ends on the stored calendar days (Apr 1 .. Aug 20)", ymd(sameDay.coverage.earliest) === "2025-04-01" && ymd(sameDay.coverage.latest) === "2025-08-20", `${ymd(sameDay.coverage.earliest)}..${ymd(sameDay.coverage.latest)}`);
    check("the reference date is the end of the local calendar day", ymd(sameDay.referenceDate) === "2025-08-20" && sameDay.referenceDate.getHours() === 23);
    const rangeAug = dateRanges.customRange("2025-08-01", "2025-08-20");
    check("Aug 1..Aug 20 against a window Apr 1..Aug 20 is fully covered", assessCoverage({ entity: "sales", period: rangeAug, comparison: null, coverage: sameDay.coverage }).status === "covered");
    const rangeSame = dateRanges.customRange("2025-04-01", "2025-08-20");
    check("a range that starts on the first synced day and ends on the last is fully covered (no phantom partial)", assessCoverage({ entity: "sales", period: rangeSame, comparison: null, coverage: sameDay.coverage }).status === "covered");
    const rangeAfter = dateRanges.customRange("2025-08-21", "2025-08-25");
    check("the day after the last synced day is outside the window", assessCoverage({ entity: "sales", period: rangeAfter, comparison: null, coverage: sameDay.coverage }).status === "outside");
    const rangeBefore = dateRanges.customRange("2025-03-01", "2025-03-31");
    check("the day before the first synced day is outside the window", assessCoverage({ entity: "sales", period: rangeBefore, comparison: null, coverage: sameDay.coverage }).status === "outside");
    const note = assessCoverage({ entity: "sales", period: dateRanges.customRange("2025-08-01", "2025-08-31"), comparison: null, coverage: sameDay.coverage });
    check("the coverage text names the stored last day (20 Aug 2025), not the day before", note.status === "partial" && note.notes.some((n) => /20 Aug 2025/.test(n)), JSON.stringify(note.notes));
  }

  // ---------------------------------------------------------------------------------------------------------------
  section("6. the stored <-> calendar helpers");
  {
    for (const iso of ["2025-01-01", "2025-08-01", "2025-08-31", "2025-12-31", "2024-02-29"]) {
      const day = dateRanges.calendarDayOfStored(stored(iso));
      const back = dateRanges.storedDayStart(day);
      check(`${iso}: stored -> calendar day -> stored is the identity`, back.getTime() === stored(iso).getTime() && day.getHours() === 0);
      check(`${iso}: the stored end of that day is 23:59:59.999Z`, dateRanges.storedDayEnd(day).getTime() === stored(iso).getTime() + 86399999);
    }
    check("a boundary with a time of day maps to its calendar day (noon Aug 20 -> Aug 20 00:00Z .. 23:59:59.999Z)", dateRanges.storedDayStart(new Date(2025, 7, 20, 12)).getTime() === stored("2025-08-20").getTime() && dateRanges.storedDayEnd(new Date(2025, 7, 20, 12)).getTime() === stored("2025-08-20").getTime() + 86399999);
  }

  console.log(`ZONE_RESULT ${pass} ${fail}`);
  process.exitCode = fail ? 1 : 0;
}
