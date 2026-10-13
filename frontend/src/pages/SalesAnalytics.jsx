import { useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import MiniStatCard from "../components/ui/MiniStatCard";
import Tabs from "../components/ui/Tabs";
import Card, { CardHeader } from "../components/ui/Card";
import Table from "../components/ui/Table";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import LineTrendChart from "../components/charts/LineTrendChart";
import { useCompany } from "../context/useCompany";
import { useAsync } from "../lib/useAsync";
import { usePersistedRange } from "../lib/usePersistedRange";
import { formatCompactCurrency, formatCurrency, formatNumber } from "../lib/format";
import { DEFAULT_RANGE, toDateInputValue } from "../lib/dateRange";
import {
  getSalesSummary,
  getSalesComparison,
  getTopProducts,
  getTopCustomers,
  getSalesTrend,
  getDiscountSummary,
} from "../api/analytics";
import { listSalesVouchers } from "../api/vouchers";
import VoucherRegister from "../components/vouchers/VoucherRegister";

const TABS = [
  { key: "trend", label: "Trend" },
  { key: "customers", label: "Top Customers" },
  { key: "products", label: "Top Products" },
  { key: "discounts", label: "Discounts" },
  { key: "invoices", label: "Invoices" },
];

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Real (Analytics Engine, via REST): Total Sales, Total Invoices, Avg
// Invoice Value (all from Sales Summary, scoped to the date range
// picked above), Top Customers and Top Products (same range). Growth
// compares this month to last month — the Analytics Engine only
// supports fixed month-over-month/year-over-year comparisons, not an
// arbitrary-range-vs-arbitrary-range one, so it does not follow the
// picker above (noted inline).
//
// The Trend tab is real too: monthly totals from GET
// /analytics/sales/trend, scoped to the exact same picked range as
// everything else on this page. The Invoices tab is real, server-side
// paginated and searched (GET /api/vouchers/sales via VoucherRegister)
// - it does NOT follow the date-range picker above (voucher lists show
// the full history by design, same as a real Sales Register; only the
// KPI summary/comparison/top-N/trend tabs are date-scoped).
async function loadSalesAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);

  // The discount calls are additive: if the server does not have them yet (older backend), the rest of the page still loads.
  const optional = (promise) => promise.catch(() => null);
  const [summary, comparison, topProducts, topCustomers, trend, discountByCustomer, discountByProduct] = await Promise.all([
    getSalesSummary({ from, to }),
    getSalesComparison(),
    getTopProducts({ from, to, limit: 10 }),
    getTopCustomers({ from, to, limit: 10 }),
    getSalesTrend({ from, to }),
    optional(getDiscountSummary({ from, to, by: "customer", limit: 10 })),
    optional(getDiscountSummary({ from, to, by: "product", limit: 10 })),
  ]);

  return { summary, comparison, topProducts, topCustomers, trend, discountByCustomer, discountByProduct };
}

export default function SalesAnalytics() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState("trend");
  // Persisted per page (localStorage) - a browser refresh restores the
  // last range the user picked here instead of resetting to the
  // default.
  const { range, setRange, reset: resetRange } = usePersistedRange("tp:range:sales", DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadSalesAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  const summaryReal = data && REAL_STATES.has(data.summary.state);
  const summaryStale = data?.summary.state === "stale_data";
  const discount = data?.discountByCustomer;
  const discountReal = !!discount && REAL_STATES.has(discount.state) && discount.data?.hasData;
  const discountTotals = discountReal ? discount.data.totals : null;

  return (
    <div>
      <PageHeader title="Sales Analytics" subtitle="Understand your sales performance and trends." />
      <FilterBar range={range} onRangeChange={setRange} onReset={resetRange} />

      {error ? (
        <div className="rounded-2xl border border-surface-border bg-white p-10 text-center text-sm text-danger-600">
          Couldn't load sales analytics: {error.message}
        </div>
      ) : loading || !data ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} className="h-24 animate-pulse bg-surface-alt" />
          ))}
        </div>
      ) : (
        <>
          {summaryStale && <StaleDataBanner message={data.summary.message} />}

          {!summaryReal ? (
            <Card className="mb-5">
              <AnalyticsNotice state={data.summary.state} message={data.summary.message} />
            </Card>
          ) : (
            <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <MiniStatCard
                label="Total Sales"
                value={formatCompactCurrency(data.summary.data.totalSales)}
                delta={null}
              />
              <MiniStatCard label="Total Invoices" value={formatNumber(data.summary.data.orderCount)} delta={null} />
              <MiniStatCard label="Avg Invoice Value" value={formatCurrency(data.summary.data.averageOrderValue)} delta={null} />
              <MiniStatCard
                label="Growth (vs last month)"
                value={
                  data.comparison.data?.growthPercentage === null || data.comparison.data?.growthPercentage === undefined
                    ? "—"
                    : `${data.comparison.data.growthPercentage.toFixed(1)}%`
                }
                delta={data.comparison.data?.growthPercentage ?? null}
              />
            </div>
          )}

          {discountTotals && (
            <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <MiniStatCard label="List Value (before discount)" value={formatCompactCurrency(discountTotals.grossAmount)} delta={null} />
              <MiniStatCard label="Discount Given" value={formatCompactCurrency(discountTotals.discountAmount)} delta={null} />
              <MiniStatCard label="Avg Discount" value={`${discountTotals.discountPct.toFixed(1)}%`} delta={null} />
            </div>
          )}

          <Tabs tabs={TABS} active={tab} onChange={setTab} />

          {tab === "trend" && (
            REAL_STATES.has(data.trend.state) && data.trend.data.items.length > 0 ? (
              <LineTrendChart
                title="Sales Trend"
                subtitle="Real monthly totals, scoped to the date range above"
                data={data.trend.data.items.map((i) => ({ label: i.label, value: i.totalSales }))}
                seriesName="Sales"
              />
            ) : (
              <Card>
                <CardHeader title="Sales Trend" />
                <AnalyticsNotice state={data.trend.state} message={data.trend.message} />
              </Card>
            )
          )}

          {tab === "customers" && (
            <Card>
              <CardHeader title="Top Customers by Sales" subtitle="Real data, scoped to the date range above" />
              {!REAL_STATES.has(data.topCustomers.state) ? (
                <AnalyticsNotice state={data.topCustomers.state} message={data.topCustomers.message} />
              ) : (
                <Table
                  rowKey="customerName"
                  rows={data.topCustomers.data.customers}
                  columns={[
                    { key: "rank", header: "#", render: (_, i) => i + 1 },
                    { key: "customerName", header: "Customer Name" },
                    { key: "totalAmount", header: "Sales Amount", align: "right", render: (r) => formatCurrency(r.totalAmount) },
                    { key: "orderCount", header: "Invoices", align: "right" },
                  ]}
                />
              )}
            </Card>
          )}

          {tab === "products" && (
            <Card>
              <CardHeader title="Top Products by Sales" subtitle="Real data, scoped to the date range above" />
              {!REAL_STATES.has(data.topProducts.state) ? (
                <AnalyticsNotice state={data.topProducts.state} message={data.topProducts.message} />
              ) : (
                <Table
                  rowKey="itemName"
                  rows={data.topProducts.data.items}
                  columns={[
                    { key: "itemName", header: "Product Name" },
                    { key: "totalAmount", header: "Sales Amount", align: "right", render: (r) => formatCurrency(r.totalAmount) },
                    { key: "totalQuantity", header: "Quantity", align: "right" },
                  ]}
                />
              )}
            </Card>
          )}

          {tab === "discounts" && (
            <div className="space-y-4">
              {[
                ["by customer", data.discountByCustomer, "Customer"],
                ["by product", data.discountByProduct, "Product"],
              ].map(([title, envelope, label]) => (
                <Card key={title}>
                  <CardHeader title={`Discount ${title}`} subtitle="Largest discounts first, scoped to the date range above" />
                  {!envelope ? (
                    <AnalyticsNotice state="analytics_error" message="Discount figures are not available from the server yet. Restart the backend with the latest code." />
                  ) : !REAL_STATES.has(envelope.state) ? (
                    <AnalyticsNotice state={envelope.state} message={envelope.message} />
                  ) : envelope.data.rows.length === 0 ? (
                    <AnalyticsNotice state="zero_result" message="No discounted lines in this range." />
                  ) : (
                    <Table
                      rowKey="key"
                      rows={envelope.data.rows}
                      columns={[
                        { key: "rank", header: "#", render: (_, i) => i + 1 },
                        { key: "key", header: label },
                        { key: "grossAmount", header: "List Value", align: "right", render: (r) => formatCurrency(r.grossAmount) },
                        { key: "discountAmount", header: "Discount", align: "right", render: (r) => formatCurrency(r.discountAmount) },
                        { key: "discountPct", header: "Discount %", align: "right", render: (r) => `${r.discountPct.toFixed(1)}%` },
                        { key: "discountedLines", header: "Discounted Lines", align: "right", render: (r) => formatNumber(r.discountedLines) },
                      ]}
                    />
                  )}
                </Card>
              ))}
              {discount?.data?.disclosures?.[0] && <p className="text-[12px] text-ink-400">{discount.data.disclosures[0]}</p>}
            </div>
          )}

          {tab === "invoices" && (
            <Card>
              <CardHeader title="Sales Invoices" subtitle="Real data — search across your full sales history" />
              <VoucherRegister
                fetcher={listSalesVouchers}
                partyLabel="Customer"
                emptyMessage="No sales vouchers have synced for this company yet."
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
