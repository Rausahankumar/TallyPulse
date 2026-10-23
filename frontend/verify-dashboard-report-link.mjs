/**
 * Dashboard KPI -> Reports deep link: proves the period hand-off helpers and the clickable KPI card.
 *  - calendarDatesOf() turns the backend's period instants into the exact calendar days, identically in every
 *    browser timezone (the process is re-run under several TZ values)
 *  - the Reports link carries only tab/from/to/source; readReportsDeepLink() rejects anything else and never
 *    returns a tenant/company
 *  - KpiCard renders as one real link only when given a destination, with an accessible name
 * No network, no database, no tenant data.
 *
 * Run: node verify-dashboard-report-link.mjs
 */
import { execFileSync } from "node:child_process";
import { createServer } from "vite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

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

const { calendarDatesOf, isIsoDay, formatIsoDay, formatIsoRange, buildReportsLink, readReportsDeepLink } = await import("./src/lib/period.js");

// the periods the backend actually produces (dateRanges: local start/end of day), for servers in different zones
const PERIODS = {
  "IST month (Aug 2025)": [{ from: "2025-07-31T18:30:00.000Z", to: "2025-08-31T18:29:59.999Z" }, "2025-08-01", "2025-08-31"],
  "IST single day (1 Oct 2026, month to date)": [{ from: "2026-09-30T18:30:00.000Z", to: "2026-10-01T18:29:59.999Z" }, "2026-10-01", "2026-10-01"],
  "IST financial year": [{ from: "2025-03-31T18:30:00.000Z", to: "2026-03-31T18:29:59.999Z" }, "2025-04-01", "2026-03-31"],
  "IST month to date: `to` is the reference date (voucher day, UTC midnight) - the Dashboard KPI case": [{ from: "2025-11-30T18:30:00.000Z", to: "2025-12-08T00:00:00.000Z" }, "2025-12-01", "2025-12-08"],
  "UTC server month": [{ from: "2025-08-01T00:00:00.000Z", to: "2025-08-31T23:59:59.999Z" }, "2025-08-01", "2025-08-31"],
  "US-Eastern (UTC-4) server month": [{ from: "2025-08-01T04:00:00.000Z", to: "2025-09-01T03:59:59.999Z" }, "2025-08-01", "2025-08-31"],
  "Auckland (UTC+12) server day": [{ from: "2025-08-14T12:00:00.000Z", to: "2025-08-15T11:59:59.999Z" }, "2025-08-15", "2025-08-15"],
};

section("calendarDatesOf: exact days from the backend's instants");
for (const [name, [period, from, to]] of Object.entries(PERIODS)) {
  const r = calendarDatesOf(period);
  check(`${name} -> ${from} .. ${to}`, r && r.from === from && r.to === to, JSON.stringify(r));
}
check("no period / partial period / garbage -> null", calendarDatesOf(null) === null && calendarDatesOf({}) === null && calendarDatesOf({ from: "x", to: "y" }) === null && calendarDatesOf({ from: "2025-08-01T00:00:00.000Z" }) === null);
check("a reversed range -> null", calendarDatesOf({ from: "2025-08-31T00:00:00.000Z", to: "2025-08-01T23:59:59.999Z" }) === null);

section("the same answer in every browser timezone");
{
  const probe = `import("${new URL("./src/lib/period.js", import.meta.url).href}").then((m) => console.log(JSON.stringify(${JSON.stringify(Object.values(PERIODS).map((p) => p[0]))}.map((p) => m.calendarDatesOf(p)))))`;
  const expected = JSON.stringify(Object.values(PERIODS).map((p) => ({ from: p[1], to: p[2] })));
  for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles", "Pacific/Auckland", "Pacific/Kiritimati"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, TZ: tz } }).toString().trim();
    check(`TZ=${tz}: identical result`, out === expected, out.slice(0, 200));
  }
}

section("date helpers");
check("isIsoDay accepts real days only", isIsoDay("2025-08-31") && isIsoDay("2024-02-29") && !isIsoDay("2025-02-30") && !isIsoDay("2025-13-01") && !isIsoDay("2025-8-1") && !isIsoDay("08/01/2025") && !isIsoDay(null) && !isIsoDay("2025-08-01T00:00:00Z"));
check("a day is formatted as that calendar day (no shift)", formatIsoDay("2025-08-01") === "01 Aug 2025" && formatIsoRange("2025-08-01", "2025-08-31") === "01 Aug 2025 – 31 Aug 2025");
{
  const probe = `import("${new URL("./src/lib/period.js", import.meta.url).href}").then((m) => console.log(m.formatIsoDay("2025-08-01")))`;
  const west = execFileSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...process.env, TZ: "America/Los_Angeles" } }).toString().trim();
  check("...also in a browser west of UTC (a naive new Date('2025-08-01') would print 31 Jul)", west === "01 Aug 2025", west);
}

section("the Reports link");
{
  const url = buildReportsLink("sales", { from: "2025-08-01", to: "2025-08-31" });
  const u = new URL(url, "http://x");
  check("sales link: /reports with tab, from, to, source only", u.pathname === "/reports" && [...u.searchParams.keys()].sort().join() === "from,source,tab,to" && u.searchParams.get("tab") === "sales" && u.searchParams.get("from") === "2025-08-01" && u.searchParams.get("to") === "2025-08-31");
  const pu = new URL(buildReportsLink("purchase", { from: "2025-08-01", to: "2025-08-31" }), "http://x");
  check("purchase link uses the Reports tab key 'purchase'", pu.searchParams.get("tab") === "purchase");
  check("no tenant / company in the URL", !/tenant|company/i.test(url));
  const parse = (q) => readReportsDeepLink(new URLSearchParams(q));
  const ok = parse(u.search);
  check("round trip", ok && ok.tab === "sales" && ok.from === "2025-08-01" && ok.to === "2025-08-31" && ok.source === "dashboard");
  check("only tab/from/to/source are ever returned", Object.keys(ok).sort().join() === "from,source,tab,to");
  check("extra params (tenantId / companyId) are ignored, never returned", Object.keys(parse("tab=sales&from=2025-08-01&to=2025-08-31&tenantId=abc&companyId=1")).sort().join() === "from,source,tab,to" && !JSON.stringify(parse("tab=sales&from=2025-08-01&to=2025-08-31&tenantId=abc")).includes("abc"));
  check("an unknown source is dropped", parse("tab=sales&from=2025-08-01&to=2025-08-31&source=evil").source === null);
  for (const bad of ["tab=products&from=2025-08-01&to=2025-08-31", "tab=sales&from=2025-08-31&to=2025-08-01", "tab=sales&from=2025-02-30&to=2025-03-01", "tab=sales&from=2025-08-01", "tab=sales&to=2025-08-01", "from=2025-08-01&to=2025-08-31", "tab=sales&from=2025-08-01&to=%3Cscript%3E", "tab=sales&from=2025-08-01T00:00:00Z&to=2025-08-31", ""]) {
    check(`rejected -> normal Reports screen: "${bad}"`, parse(bad) === null);
  }
}

section("KpiCard: one real link, only when it has a destination");
{
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom", logLevel: "error" });
  const { default: KpiCard } = await vite.ssrLoadModule("/src/components/ui/KpiCard.jsx");
  const { MemoryRouter } = await import("react-router-dom");
  const render = (props) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(KpiCard, { label: "Total Sales", value: "₹43.45L", delta: -22.7, ...props })));
  const to = buildReportsLink("sales", { from: "2025-08-01", to: "2025-08-31" });
  const linked = render({ to, linkLabel: "Open Sales Report for 01 Aug 2025 – 31 Aug 2025" });
  check("an <a> to the Reports URL, with an accessible name", linked.includes("<a ") && linked.includes(`href="${to.replace(/&/g, "&amp;")}"`) && linked.includes('aria-label="Open Sales Report for 01 Aug 2025 – 31 Aug 2025"'));
  check("hover / focus / active affordances present", linked.includes("group-hover:") && linked.includes("focus-visible:ring-2") && linked.includes("active:scale") && linked.includes("View report"));
  check("the KPI content is unchanged inside the link", linked.includes("Total Sales") && linked.includes("₹43.45L") && linked.includes("22.7%") && linked.includes("vs previous period"));
  const plain = render({});
  check("without a destination it is the plain card (no link, no hint)", !plain.includes("<a ") && !plain.includes("View report") && plain.includes("₹43.45L"));
  await vite.close();
}

section("source guards (the period is passed through, never recalculated)");
{
  const dash = fs.readFileSync(fileURLToPath(new URL("./src/pages/Dashboard.jsx", import.meta.url)), "utf8");
  check("Dashboard builds the link from the summary envelope's own period", /calendarDatesOf\(envelope\?\.data\?\.period\)/.test(dash) && /reportLink\("sales"/.test(dash) && /reportLink\("purchase"/.test(dash));
  check("Dashboard adds no period math of its own", !/startOfMonth|endOfMonth|currentMonth|new Date\(/.test(dash.replace(/formatRelativeTime|new Date\(b\.at\)|new Date\(a\.at\)/g, "")));
  const rep = fs.readFileSync(fileURLToPath(new URL("./src/pages/Reports.jsx", import.meta.url)), "utf8");
  check("Reports reads the link once and never sends tenant/company", /readReportsDeepLink\(searchParams\)/.test(rep) && !/searchParams\.get\(["'](tenant|company)/i.test(rep));
  check("Reports export and summary still use the generated report's own from/to", /exportSalesReport\(filters\)/.test(rep) && /fetchSummary\(\{ from: generated\.from, to: generated\.to \}\)/.test(rep));
}

console.log(`\nverify-dashboard-report-link: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
