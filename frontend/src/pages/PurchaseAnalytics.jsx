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
  getPurchaseSummary,
  getPurchaseComparison,
  getTopSuppliers,
  getPurchaseTrend,
} from "../api/analytics";
import { listPurchaseVouchers } from "../api/vouchers";
import VoucherRegister from "../components/vouchers/VoucherRegister";

const TABS = [
  { key: "trend", label: "Trend" },
  { key: "suppliers", label: "Top Suppliers" },
  { key: "bills", label: "Bills" },
];

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Real (Analytics Engine, via REST): Total Purchases, Total Bills, Avg
// Bill Value (from Purchase Summary, scoped to the date range above),
// Growth (Purchase Comparison, fixed vs last month — same
// month-over-month-only limitation as Sales Analytics), Top Suppliers
// (getTopSuppliers, mirrors Sales' getTopCustomers on the Purchase
// collection's party/supplier ledger name), and a real monthly Trend
// (GET /analytics/purchases/trend, mirrors Sales' trend endpoint on the
// Purchase collection). The Bills tab is real, server-side paginated
// and searched (GET /api/vouchers/purchases via VoucherRegister) — like
// Sales Invoices, it shows the full history and does not follow the
// date-range picker above.
async function loadPurchaseAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);

  const [summary, comparison, topSuppliers, trend] = await Promise.all([
    getPurchaseSummary({ from, to }),
    getPurchaseComparison(),
    getTopSuppliers({ from, to, limit: 10 }),
    getPurchaseTrend({ from, to }),
  ]);

  return { summary, comparison, topSuppliers, trend };
}

export default function PurchaseAnalytics() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState("trend");
  const { range, setRange, reset: resetRange } = usePersistedRange("tp:range:purchases", DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadPurchaseAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  const summaryReal = data && REAL_STATES.has(data.summary.state);
  const summaryStale = data?.summary.state === "stale_data";

  return (
    <div>
      <PageHeader title="Purchase Analytics" subtitle="Analyze your procurement and supplier performance." />
      <FilterBar range={range} onRangeChange={setRange} onReset={resetRange} />

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
            REAL_STATES.has(data.trend.state) && data.trend.data.items.length > 0 ? (
              <LineTrendChart
                title="Purchase Trend"
                subtitle="Real monthly totals, scoped to the date range above"
                data={data.trend.data.items.map((i) => ({ label: i.label, value: i.totalPurchases }))}
                seriesName="Purchases"
              />
            ) : (
              <Card>
                <CardHeader title="Purchase Trend" />
                <AnalyticsNotice state={data.trend.state} message={data.trend.message} />
              </Card>
            )
          )}

          {tab === "suppliers" && (
            <Card>
              <CardHeader title="Top Suppliers" subtitle="Real data, scoped to the date range above" />
              {!REAL_STATES.has(data.topSuppliers.state) ? (
                <AnalyticsNotice state={data.topSuppliers.state} message={data.topSuppliers.message} />
              ) : (
                <Table
                  rowKey="supplierName"
                  rows={data.topSuppliers.data.suppliers}
                  columns={[
                    { key: "rank", header: "#", render: (_, i) => i + 1 },
                    { key: "supplierName", header: "Supplier Name" },
                    { key: "totalAmount", header: "Purchase Amount", align: "right", render: (r) => formatCurrency(r.totalAmount) },
                    { key: "orderCount", header: "Bills", align: "right" },
                  ]}
                />
              )}
            </Card>
          )}

          {tab === "bills" && (
            <Card>
              <CardHeader title="Purchase Bills" subtitle="Real data — search across your full purchase history" />
              <VoucherRegister
                fetcher={listPurchaseVouchers}
                partyLabel="Supplier"
                emptyMessage="No purchase vouchers have synced for this company yet."
              />
            </Card>
          )}
        </>
      )}
    </div>
  );
}
