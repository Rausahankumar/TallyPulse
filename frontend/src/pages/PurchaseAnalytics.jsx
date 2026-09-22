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
import { getPurchaseSummary, getPurchaseComparison } from "../api/analytics";
import { MOCK_SALES_VS_PURCHASES, MOCK_TOP_SUPPLIERS } from "../mock/mockData";

const TABS = [
  { key: "trend", label: "Trend" },
  { key: "suppliers", label: "Top Suppliers" },
  { key: "bills", label: "Bills" },
];

const MOCK_BILLS = [
  { date: "12 Oct 2025", supplier: "ADC Supplies", amount: 21400 },
  { date: "11 Oct 2025", supplier: "National Traders", amount: 18600 },
  { date: "11 Oct 2025", supplier: "Shree Enterprises", amount: 12200 },
  { date: "10 Oct 2025", supplier: "Metro Corp", amount: 9600 },
  { date: "09 Oct 2025", supplier: "Om Traders", amount: 6700 },
];

const MOCK_TREND = MOCK_SALES_VS_PURCHASES.map((d) => ({ label: d.label, value: d.purchases }));

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Real (Analytics Engine, via REST): Total Purchases, Total Bills, Avg
// Bill Value (from Purchase Summary, scoped to the date range above)
// and Growth (Purchase Comparison, fixed vs last month — same
// month-over-month-only limitation as Sales Analytics).
//
// Still sample: Trend chart, Top Suppliers (no "top parties by
// purchase" function exists — only getTopPurchasedProducts, which is
// per-item, not per-supplier), and Bills (no per-voucher list
// capability).
async function loadPurchaseAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);

  const [summary, comparison] = await Promise.all([
    getPurchaseSummary({ from, to }),
    getPurchaseComparison(),
  ]);

  return { summary, comparison };
}

export default function PurchaseAnalytics() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState("trend");
  const [fy, setFy] = useState("fy2025-26");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadPurchaseAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  const summaryReal = data && REAL_STATES.has(data.summary.state);
  const summaryStale = data?.summary.state === "stale_data";

  return (
    <div>
      <PageHeader title="Purchase Analytics" subtitle="Analyze your procurement and supplier performance." />
      <FilterBar
        fy={fy}
        onFyChange={setFy}
        range={range}
        onRangeChange={setRange}
        onReset={() => setRange(DEFAULT_RANGE)}
      />

      {error ? (
        <div className="rounded-2xl border border-surface-border bg-white p-10 text-center text-sm text-danger-600">
          Couldn't load purchase analytics: {error.message}
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
                label="Total Purchases"
                value={formatCompactCurrency(data.summary.data.totalPurchases)}
                delta={null}
              />
              <MiniStatCard label="Total Bills" value={formatNumber(data.summary.data.orderCount)} delta={null} />
              <MiniStatCard label="Avg Bill Value" value={formatCurrency(data.summary.data.averageOrderValue)} delta={null} />
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
              title="Purchase Trend"
              subtitle="Sample data — no monthly breakdown endpoint exists yet"
              seriesName="Purchases"
              data={MOCK_TREND}
              height={300}
            />
          )}

          {tab === "suppliers" && (
            <Card>
              <CardHeader title="Top Suppliers" subtitle="Sample data — no top-supplier analytics endpoint exists yet" />
              <Table
                rowKey="supplierName"
                rows={MOCK_TOP_SUPPLIERS}
                columns={[
                  { key: "rank", header: "#", render: (_, i) => i + 1 },
                  { key: "supplierName", header: "Supplier Name" },
                  { key: "totalAmount", header: "Purchase Amount", align: "right", render: (r) => formatCurrency(r.totalAmount) },
                  { key: "orderCount", header: "Bills", align: "right" },
                ]}
              />
            </Card>
          )}

          {tab === "bills" && (
            <Card>
              <CardHeader title="Recent Purchase Bills" subtitle="Sample data — no per-voucher analytics endpoint exists yet" />
              <Table
                rowKey="date"
                rows={MOCK_BILLS}
                columns={[
                  { key: "date", header: "Date" },
                  { key: "supplier", header: "Supplier" },
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
