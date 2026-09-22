import { useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import MiniStatCard from "../components/ui/MiniStatCard";
import Tabs from "../components/ui/Tabs";
import Card, { CardHeader } from "../components/ui/Card";
import Table from "../components/ui/Table";
import LineTrendChart from "../components/charts/LineTrendChart";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import { useCompany } from "../context/useCompany";
import { useAsync } from "../lib/useAsync";
import { formatCompactCurrency, formatCurrency, formatNumber } from "../lib/format";
import { DEFAULT_RANGE, toDateInputValue } from "../lib/mockDateRange";
import { getSalesSummary, getSalesComparison, getTopProducts, getTopCustomers } from "../api/analytics";
import { MOCK_SALES_TREND, MOCK_RECENT_SALES_INVOICES } from "../mock/mockData";

const TABS = [
  { key: "trend", label: "Trend" },
  { key: "customers", label: "Top Customers" },
  { key: "products", label: "Top Products" },
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
// Still sample: the Trend chart (no monthly-breakdown endpoint exists)
// and the Invoices tab (no "list of vouchers" analytics capability —
// only aggregated summaries).
async function loadSalesAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);

  const [summary, comparison, topProducts, topCustomers] = await Promise.all([
    getSalesSummary({ from, to }),
    getSalesComparison(),
    getTopProducts({ from, to, limit: 10 }),
    getTopCustomers({ from, to, limit: 10 }),
  ]);

  return { summary, comparison, topProducts, topCustomers };
}

export default function SalesAnalytics() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState("trend");
  const [fy, setFy] = useState("fy2025-26");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadSalesAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  const summaryReal = data && REAL_STATES.has(data.summary.state);
  const summaryStale = data?.summary.state === "stale_data";

  return (
    <div>
      <PageHeader title="Sales Analytics" subtitle="Understand your sales performance and trends." />
      <FilterBar
        fy={fy}
        onFyChange={setFy}
        range={range}
        onRangeChange={setRange}
        onReset={() => setRange(DEFAULT_RANGE)}
      />

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

          <Tabs tabs={TABS} active={tab} onChange={setTab} />

          {tab === "trend" && (
            <LineTrendChart
              title="Sales Trend"
              subtitle="Sample data — no monthly breakdown endpoint exists yet"
              seriesName="Sales"
              data={MOCK_SALES_TREND}
              height={300}
            />
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

          {tab === "invoices" && (
            <Card>
              <CardHeader title="Recent Sales Invoices" subtitle="Sample data — no per-voucher analytics endpoint exists yet" />
              <Table
                rowKey="date"
                rows={MOCK_RECENT_SALES_INVOICES}
                columns={[
                  { key: "date", header: "Date" },
                  { key: "customer", header: "Customer" },
                  { key: "amount", header: "Amount", align: "right", render: (r) => formatCurrency(r.amount) },
                ]}
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
