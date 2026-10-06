import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Download, PlayCircle, PackageSearch } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import Tabs from "../components/ui/Tabs";
import Card, { CardHeader } from "../components/ui/Card";
import Button from "../components/ui/Button";
import MiniStatCard from "../components/ui/MiniStatCard";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import EmptyState from "../components/ui/EmptyState";
import ReportTable from "../components/reports/ReportTable";
import VoucherRegister from "../components/vouchers/VoucherRegister";
import { useCompany } from "../context/useCompany";
import { usePersistedRange } from "../lib/usePersistedRange";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { formatCompactCurrency, formatCurrency, formatNumber } from "../lib/format";
import { DEFAULT_RANGE, parseDateInputValue, toDateInputValue } from "../lib/dateRange";
import { formatIsoRange, readReportsDeepLink } from "../lib/period";
import { getSalesSummary, getPurchaseSummary } from "../api/analytics";
import { listSalesVouchers, listPurchaseVouchers } from "../api/vouchers";
import {
  getProductReport,
  getCustomerReport,
  exportSalesReport,
  exportPurchaseReport,
  exportProductReport,
  exportCustomerReport,
} from "../api/reports";

const TABS = [
  { key: "sales", label: "Sales Report" },
  { key: "purchase", label: "Purchase Report" },
  { key: "product", label: "Product Report" },
  { key: "customer", label: "Customer Report" },
  { key: "stock", label: "Stock Summary" },
];

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Real, generated on demand from the same Analytics Engine/voucher
// infrastructure every other screen uses — nothing here is precomputed
// or sample data. Sales/Purchase Report reuse the existing summary
// endpoints (GET /analytics/sales|purchases/summary) for the header KPIs
// and the existing paginated/searched voucher listing
// (GET /api/vouchers/sales|purchases, via VoucherRegister) for the line
// items — no new backend work needed for either. Product/Customer Report
// are genuinely new (GET /api/reports/products|customers): a company can
// have thousands of distinct product names, so a real paginated,
// searchable listing was needed — "top N" (already used elsewhere) isn't
// the same thing as a full report.
//
// Stock Summary is NOT implemented: the current Tally sync captures only
// Sales/Purchase VOUCHERS, never a stock ledger or opening/closing
// balances, so there is no reliable way to compute current stock-on-hand
// — approximating it from (purchases − sales) would ignore stock
// journals, opening balances and any other movement type Tally itself
// isn't telling this system about. Shown as an honest, explicit
// not-available state rather than a fabricated number.
export default function Reports() {
  const { activeCompany } = useCompany();
  // Dashboard KPI deep link (/reports?tab=sales|purchase&from=YYYY-MM-DD&to=YYYY-MM-DD): read ONCE, strictly
  // validated (anything unexpected -> null = the normal screen). Only tab and dates travel in the URL; the
  // company/tenant always comes from the authenticated session on the server, never from here.
  const [searchParams, setSearchParams] = useSearchParams();
  const [link] = useState(() => readReportsDeepLink(searchParams));
  const [reportType, setReportType] = useState(link ? link.tab : "sales");
  const { range, setRange, reset: resetRange } = usePersistedRange(
    "tp:range:reports",
    DEFAULT_RANGE,
    link ? { from: parseDateInputValue(link.from), to: parseDateInputValue(link.to) } : null
  );

  // The exact filters last used to GENERATE the currently-shown report —
  // deliberately separate from `range`/`reportType` so changing the date
  // picker or switching tabs doesn't silently regenerate anything; only
  // clicking Generate does (see Phase 4's required flow).
  const [generated, setGenerated] = useState(link ? { type: link.tab, from: link.from, to: link.to } : null);

  // The link has been consumed: drop it from the address bar so later manual changes and a refresh follow the
  // normal Reports behaviour (the range is stored like any picked range).
  const linkConsumed = useRef(false);
  useEffect(() => {
    if (link && !linkConsumed.current) {
      linkConsumed.current = true;
      setSearchParams({}, { replace: true });
    }
  }, [link, setSearchParams]);
  const fromDashboard =
    link && link.source === "dashboard" && generated && generated.type === link.tab && generated.from === link.from && generated.to === link.to;

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [searchInput, setSearchInput] = useState("");
  const debouncedSearch = useDebouncedValue(searchInput, 350);

  const [summary, setSummary] = useState({ envelope: null, loading: false, error: null });
  const [tableState, setTableState] = useState({ data: [], pagination: null, loading: false, error: null, envelope: null });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  // Never let a generated report survive a company switch — a stale
  // report from the previous tenant must not linger on screen (Phase 6).
  // Adjusted during render (same pattern as FilterBar's prevRange), not
  // in an effect, so the switch and the reset land in the same commit
  // instead of a stale report flashing for one extra render.
  const [prevTenantId, setPrevTenantId] = useState(activeCompany?.tenantId);
  if (activeCompany?.tenantId !== prevTenantId) {
    setPrevTenantId(activeCompany?.tenantId);
    setGenerated(null);
    setSummary({ envelope: null, loading: false, error: null });
    setTableState({ data: [], pagination: null, loading: false, error: null, envelope: null });
    setExportError(null);
  }

  function handleTabChange(key) {
    setReportType(key);
    setGenerated(null);
    setExportError(null);
  }

  function handleGenerate() {
    if (range.from > range.to) return;
    setPage(1);
    setSearchInput("");
    setExportError(null);
    setGenerated({ type: reportType, from: toDateInputValue(range.from), to: toDateInputValue(range.to) });
  }

  // Sales/Purchase summary — fetched once per Generate click.
  useEffect(() => {
    if (!generated || (generated.type !== "sales" && generated.type !== "purchase")) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect
    setSummary({ envelope: null, loading: true, error: null });
    const fetchSummary = generated.type === "sales" ? getSalesSummary : getPurchaseSummary;
    fetchSummary({ from: generated.from, to: generated.to })
      .then((envelope) => {
        if (!cancelled) setSummary({ envelope, loading: false, error: null });
      })
      .catch((error) => {
        if (!cancelled) setSummary({ envelope: null, loading: false, error });
      });
    return () => {
      cancelled = true;
    };
  }, [generated]);

  // Product/Customer report page — fetched on Generate and on every
  // page/limit/search change after that.
  useEffect(() => {
    if (!generated || (generated.type !== "product" && generated.type !== "customer")) return;
    let cancelled = false;
    // oxlint-disable-next-line react/set-state-in-effect
    setTableState((s) => ({ ...s, loading: true, error: null }));
    const fetchReport = generated.type === "product" ? getProductReport : getCustomerReport;
    fetchReport({ from: generated.from, to: generated.to, page, limit, search: debouncedSearch || undefined })
      .then((envelope) => {
        if (cancelled) return;
        const real = REAL_STATES.has(envelope.state);
        setTableState({
          data: real ? envelope.data.items : [],
          pagination: real ? envelope.data.pagination : null,
          loading: false,
          error: null,
          envelope,
        });
      })
      .catch((error) => {
        if (!cancelled) setTableState({ data: [], pagination: null, loading: false, error, envelope: null });
      });
    return () => {
      cancelled = true;
    };
  }, [generated, page, limit, debouncedSearch]);

  async function handleExport() {
    if (!generated) return;
    setExporting(true);
    setExportError(null);
    try {
      const filters = { from: generated.from, to: generated.to };
      if (generated.type === "sales") await exportSalesReport(filters);
      else if (generated.type === "purchase") await exportPurchaseReport(filters);
      else if (generated.type === "product")
        await exportProductReport({ ...filters, search: debouncedSearch || undefined });
      else if (generated.type === "customer")
        await exportCustomerReport({ ...filters, search: debouncedSearch || undefined });
    } catch (error) {
      setExportError(error.message || "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  const summaryReal = summary.envelope && REAL_STATES.has(summary.envelope.state);

  return (
    <div>
      <PageHeader title="Reports" subtitle="Generate real reports from your company's synced Tally data." />
      <Tabs tabs={TABS} active={reportType} onChange={handleTabChange} />

      {fromDashboard && (
        <p role="status" className="mt-3 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[13px] text-ink-700">
          Opened from the Dashboard's <strong className="font-semibold text-ink-900">{link.tab === "sales" ? "Total Sales" : "Total Purchases"}</strong>: the
          same period, <strong className="font-semibold text-ink-900">{formatIsoRange(link.from, link.to)}</strong>.
        </p>
      )}

      {reportType === "stock" ? (
        <Card className="mt-4">
          <EmptyState
            icon={PackageSearch}
            title="Stock Summary isn't available"
            description="The Tally sync captures Sales and Purchase vouchers only — no stock ledger or opening/closing balances. Estimating stock-on-hand from purchases minus sales would ignore stock journals and any other movement Tally isn't telling this system about, so it isn't shown rather than shown wrong. See Product Report for real sales and purchase quantities per item."
          />
        </Card>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <FilterBar range={range} onRangeChange={setRange} onReset={resetRange} />
            <Button icon={PlayCircle} onClick={handleGenerate} disabled={range.from > range.to}>
              Generate Report
            </Button>
          </div>

          {!generated || generated.type !== reportType ? (
            <Card>
              <EmptyState
                title="No report generated yet"
                description="Pick a date range above and click Generate Report to run this report against your real synced data."
              />
            </Card>
          ) : (
            <div className="space-y-4">
              {(generated.type === "sales" || generated.type === "purchase") && (
                <>
                  {summary.loading ? (
                    <Card className="h-24 animate-pulse bg-surface-alt" />
                  ) : summary.error ? (
                    <div className="rounded-2xl border border-surface-border bg-white p-10 text-center text-sm text-danger-600">
                      Couldn't load the report: {summary.error.message}
                    </div>
                  ) : !summaryReal ? (
                    <Card>
                      <AnalyticsNotice state={summary.envelope?.state} message={summary.envelope?.message} />
                    </Card>
                  ) : (
                    <>
                      {summary.envelope.state === "stale_data" && (
                        <StaleDataBanner message={summary.envelope.message} />
                      )}
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                        {generated.type === "sales" ? (
                          <>
                            <MiniStatCard
                              label="Total Sales"
                              value={formatCompactCurrency(summary.envelope.data.totalSales)}
                              delta={null}
                            />
                            <MiniStatCard
                              label="Total Invoices"
                              value={formatNumber(summary.envelope.data.orderCount)}
                              delta={null}
                            />
                            <MiniStatCard
                              label="Avg Invoice Value"
                              value={formatCurrency(summary.envelope.data.averageOrderValue)}
                              delta={null}
                            />
                          </>
                        ) : (
                          <>
                            <MiniStatCard
                              label="Total Purchases"
                              value={formatCompactCurrency(summary.envelope.data.totalPurchases)}
                              delta={null}
                            />
                            <MiniStatCard
                              label="Total Bills"
                              value={formatNumber(summary.envelope.data.orderCount)}
                              delta={null}
                            />
                            <MiniStatCard
                              label="Avg Bill Value"
                              value={formatCurrency(summary.envelope.data.averageOrderValue)}
                              delta={null}
                            />
                          </>
                        )}
                      </div>
                    </>
                  )}

                  <Card>
                    <CardHeader
                      title={generated.type === "sales" ? "Sales Vouchers" : "Purchase Vouchers"}
                      subtitle={`Real data, scoped to ${formatIsoRange(generated.from, generated.to)}`}
                      action={
                        <Button variant="secondary" size="sm" icon={Download} loading={exporting} onClick={handleExport}>
                          Export CSV
                        </Button>
                      }
                    />
                    <VoucherRegister
                      fetcher={(args) =>
                        (generated.type === "sales" ? listSalesVouchers : listPurchaseVouchers)({
                          ...args,
                          from: generated.from,
                          to: generated.to,
                        })
                      }
                      partyLabel={generated.type === "sales" ? "Customer" : "Supplier"}
                      emptyMessage={`No ${generated.type === "sales" ? "sales" : "purchase"} vouchers in this range.`}
                    />
                  </Card>
                </>
              )}

              {(generated.type === "product" || generated.type === "customer") && (
                <Card>
                  <CardHeader
                    title={generated.type === "product" ? "Product Report" : "Customer Report"}
                    subtitle={`Real data, scoped to ${formatIsoRange(generated.from, generated.to)}`}
                    action={
                      <Button variant="secondary" size="sm" icon={Download} loading={exporting} onClick={handleExport}>
                        Export CSV
                      </Button>
                    }
                  />

                  {REAL_STATES.has(tableState.envelope?.state) && tableState.envelope.data.summary && (
                    <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                      {generated.type === "product" ? (
                        <>
                          <MiniStatCard
                            label="Products"
                            value={formatNumber(tableState.envelope.data.summary.totalProducts)}
                            delta={null}
                          />
                          <MiniStatCard
                            label="Total Sales Amount"
                            value={formatCompactCurrency(tableState.envelope.data.summary.grandSalesAmount)}
                            delta={null}
                            hint="Item-level subtotal, before tax/freight/rounding — see Sales Report for the corrected voucher total"
                          />
                          <MiniStatCard
                            label="Total Sales Quantity"
                            value={formatNumber(tableState.envelope.data.summary.grandSalesQuantity)}
                            delta={null}
                          />
                        </>
                      ) : (
                        <>
                          <MiniStatCard
                            label="Customers"
                            value={formatNumber(tableState.envelope.data.summary.totalCustomers)}
                            delta={null}
                          />
                          <MiniStatCard
                            label="Total Sales Amount"
                            value={formatCompactCurrency(tableState.envelope.data.summary.grandTotalAmount)}
                            delta={null}
                          />
                          <MiniStatCard
                            label="Total Invoices"
                            value={formatNumber(tableState.envelope.data.summary.grandOrderCount)}
                            delta={null}
                          />
                        </>
                      )}
                    </div>
                  )}

                  {!REAL_STATES.has(tableState.envelope?.state) && !tableState.loading && !tableState.error ? (
                    <AnalyticsNotice state={tableState.envelope?.state} message={tableState.envelope?.message} />
                  ) : (
                    <ReportTable
                      rowKey={generated.type === "product" ? "itemName" : "customerName"}
                      columns={
                        generated.type === "product"
                          ? [
                              { key: "itemName", header: "Product" },
                              { key: "salesQuantity", header: "Sales Qty", align: "right", render: (r) => formatNumber(r.salesQuantity) },
                              { key: "salesAmount", header: "Sales Amount", align: "right", render: (r) => formatCurrency(r.salesAmount) },
                              { key: "purchaseQuantity", header: "Purchase Qty", align: "right", render: (r) => (r.purchaseQuantity == null ? "—" : formatNumber(r.purchaseQuantity)) },
                              { key: "purchaseAmount", header: "Purchase Amount", align: "right", render: (r) => (r.purchaseAmount == null ? "—" : formatCurrency(r.purchaseAmount)) },
                            ]
                          : [
                              { key: "customerName", header: "Customer" },
                              { key: "orderCount", header: "Invoices", align: "right", render: (r) => formatNumber(r.orderCount) },
                              { key: "totalAmount", header: "Sales Amount", align: "right", render: (r) => formatCurrency(r.totalAmount) },
                            ]
                      }
                      searchPlaceholder={generated.type === "product" ? "Search by product name…" : "Search by customer name…"}
                      emptyTitle={generated.type === "product" ? "No products in this range" : "No customers in this range"}
                      emptyMessage="Nothing matches this date range for this company."
                      search={searchInput}
                      onSearchChange={(v) => {
                        setSearchInput(v);
                        setPage(1);
                      }}
                      limit={limit}
                      onLimitChange={(v) => {
                        setLimit(v);
                        setPage(1);
                      }}
                      page={page}
                      onPageChange={setPage}
                      state={tableState}
                    />
                  )}
                </Card>
              )}

              {exportError && (
                <p className="text-[12.5px] text-danger-600">Export failed: {exportError}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
