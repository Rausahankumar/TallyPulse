import { DollarSign, ShoppingBag, Receipt, Users } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import FreshnessBadge from "../components/ui/FreshnessBadge";
import KpiCard from "../components/ui/KpiCard";
import { KpiCardSkeleton, ChartCardSkeleton } from "../components/ui/Skeleton";
import ComparisonBarChart from "../components/charts/ComparisonBarChart";
import DonutChart from "../components/charts/DonutChart";
import LineTrendChart from "../components/charts/LineTrendChart";
import RecentActivity from "../components/dashboard/RecentActivity";
import AnalyticsNotice from "../components/ui/AnalyticsNotice";
import { useCompany } from "../context/useCompany";
import { useAsync } from "../lib/useAsync";
import { formatCompactCurrency, formatCurrency, formatNumber, formatRelativeTime } from "../lib/format";
import { buildReportsLink, calendarDatesOf, formatIsoRange } from "../lib/period";
import {
  getSalesSummary,
  getPurchaseSummary,
  getSalesComparison,
  getPurchaseComparison,
  getTopProducts,
  getSalesTrend,
  getCustomerCounts,
} from "../api/analytics";
import { getSyncStatus } from "../api/sync";

// Real (Analytics Engine + sync status, via REST), all anchored to this
// tenant's own most recent synced voucher date rather than the wall
// clock (see backend referenceDate.js — a tenant whose Tally sync is
// months behind the system clock would otherwise show an empty
// "current month" forever, which is misleading, not honest):
//   - Total Sales / Total Purchases + growth deltas
//   - Avg Invoice Value (Sales Summary's own averageOrderValue — no
//     extra call needed)
//   - Total Customers: distinct header.partyName across this tenant's
//     ENTIRE Sale history (Sale.distinct, all-time, unbounded)
//   - Sales vs Purchases: previous vs current anchored period
//   - Top 5 Products (Sales), by amount
//   - Sales Trend: real monthly totals, last 6 months of actual data
//   - Recent Activity: the 10 most-recently-updated vouchers
//
// Deliberately NOT implemented: Gross Profit. Sale.inventory only
// stores the SELLING rate/amount — no cost-of-goods field is captured
// anywhere in the parser/mapper/schema, and approximating "cost" from a
// Purchase voucher's rate for the same item name would assume FIFO/
// specific-lot matching that Tally itself isn't telling us — that's a
// fabricated number wearing a real label, which the product must never
// show. Avg Invoice Value occupies that KPI slot instead: a real,
// always-derivable metric from the same data Total Sales already uses.
async function loadDashboard() {
  const [
    salesSummary,
    purchaseSummary,
    salesComparison,
    purchaseComparison,
    topProducts,
    salesTrend,
    customerCounts,
    syncStatus,
  ] = await Promise.all([
    getSalesSummary(),
    getPurchaseSummary(),
    getSalesComparison(),
    getPurchaseComparison(),
    getTopProducts({ limit: 5 }),
    getSalesTrend(),
    getCustomerCounts(),
    getSyncStatus(),
  ]);

  return {
    salesSummary,
    purchaseSummary,
    salesComparison,
    purchaseComparison,
    topProducts,
    salesTrend,
    customerCounts,
    syncStatus,
  };
}

function buildRecentActivity(syncStatus) {
  const sales = (syncStatus.recentSales || []).map((v) => ({
    text: `Sale to ${v.partyName || "Unknown"} — ${formatCompactCurrency(v.amount)}`,
    at: v.updatedAt,
    tone: "brand",
  }));
  const purchases = (syncStatus.recentPurchases || []).map((v) => ({
    text: `Purchase from ${v.partyName || "Unknown"} — ${formatCompactCurrency(v.amount)}`,
    at: v.updatedAt,
    tone: "warning",
  }));
  return [...sales, ...purchases]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 6)
    .map((item) => ({ text: item.text, tone: item.tone, time: formatRelativeTime(item.at) }));
}

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// A short, honest caption for why a KPI shows "—" instead of a number -
// never invents a reason, just clarifies the backend's own state. The
// Dashboard's "current month" is anchored to this tenant's own latest
// synced voucher (see loadDashboard's comment above), so a zero_result
// here means there's genuinely no data in that most-recent period, not
// that the query missed real data - not an error. Other states show the
// backend's own message unchanged.
function kpiHint(envelope, seeScreenLabel) {
  if (envelope.state === "zero_result") {
    return `No data in the most recent synced period — see ${seeScreenLabel} for your full history.`;
  }
  return envelope.message || null;
}

// {to, label} for a KPI's report link, or undefined when the envelope carries no usable period (the card then
// stays a plain, non-clickable card).
function reportLink(tab, reportName, envelope) {
  const dates = calendarDatesOf(envelope?.data?.period);
  if (!dates) return undefined;
  return { to: buildReportsLink(tab, dates), label: `Open ${reportName} for ${formatIsoRange(dates.from, dates.to)}` };
}

export default function Dashboard() {
  const { activeCompany } = useCompany();
  const { data, loading, error } = useAsync(loadDashboard, [activeCompany?.tenantId]);

  const salesReal = data && REAL_STATES.has(data.salesSummary.state);
  const purchaseReal = data && REAL_STATES.has(data.purchaseSummary.state);
  const topProductsReal = data && REAL_STATES.has(data.topProducts.state);
  const salesTrendReal = data && REAL_STATES.has(data.salesTrend.state);
  const customerCountsReal = data && REAL_STATES.has(data.customerCounts.state);
  const comparisonReal =
    data && REAL_STATES.has(data.salesComparison.state) && REAL_STATES.has(data.purchaseComparison.state);

  // The KPI's own period, exactly as the backend resolved it for the figure shown (summary.data.period) - the
  // one source of truth. Clicking a KPI opens that report for the SAME days; nothing is recalculated here.
  const salesLink = reportLink("sales", "Sales Report", data?.salesSummary);
  const purchaseLink = reportLink("purchase", "Purchase Report", data?.purchaseSummary);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Here's what's happening with your business today."
        action={data && <FreshnessBadge freshness={data.salesSummary.freshness} />}
      />

      {error ? (
        <div className="rounded-2xl border border-surface-border bg-white p-10 text-center text-sm text-danger-600">
          Couldn't load the dashboard: {error.message}
        </div>
      ) : loading ? (
        <DashboardSkeleton />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard
              label="Total Sales"
              value={salesReal ? formatCompactCurrency(data.salesSummary.data.totalSales) : "—"}
              delta={salesReal ? data.salesComparison.data?.growthPercentage ?? null : null}
              hint={salesReal ? null : kpiHint(data.salesSummary, "Sales Analytics")}
              icon={DollarSign}
              tone="brand"
              to={salesLink?.to}
              linkLabel={salesLink?.label}
            />
            <KpiCard
              label="Total Purchases"
              value={purchaseReal ? formatCompactCurrency(data.purchaseSummary.data.totalPurchases) : "—"}
              delta={purchaseReal ? data.purchaseComparison.data?.growthPercentage ?? null : null}
              hint={purchaseReal ? null : kpiHint(data.purchaseSummary, "Purchase Analytics")}
              icon={ShoppingBag}
              tone="violet"
              to={purchaseLink?.to}
              linkLabel={purchaseLink?.label}
            />
            <KpiCard
              label="Avg Invoice Value"
              value={salesReal ? formatCurrency(data.salesSummary.data.averageOrderValue) : "—"}
              delta={null}
              hint={salesReal ? null : kpiHint(data.salesSummary, "Sales Analytics")}
              icon={Receipt}
              tone="success"
            />
            <KpiCard
              label="Total Customers"
              value={customerCountsReal ? formatNumber(data.customerCounts.data.totalCustomers) : "—"}
              delta={null}
              hint={customerCountsReal ? "All-time distinct customers you've sold to" : kpiHint(data.customerCounts, "Customers Analytics")}
              icon={Users}
              tone="warning"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div>
              {comparisonReal ? (
                <ComparisonBarChart
                  title="Sales vs Purchases"
                  subtitle="Previous period vs current period"
                  data={[
                    {
                      label: "Previous",
                      sales: data.salesComparison.data.previous.totalSales,
                      purchases: data.purchaseComparison.data.previous.totalPurchases,
                    },
                    {
                      label: "Current",
                      sales: data.salesComparison.data.current.totalSales,
                      purchases: data.purchaseComparison.data.current.totalPurchases,
                    },
                  ]}
                  series={[
                    { key: "sales", name: "Sales", color: "#3269ea" },
                    { key: "purchases", name: "Purchases", color: "#b9d2ff" },
                  ]}
                />
              ) : (
                <div className="rounded-2xl border border-surface-border bg-white p-4">
                  <p className="mb-3 text-[15px] font-semibold text-ink-900">Sales vs Purchases</p>
                  <AnalyticsNotice
                    state={data.salesComparison.state}
                    message={data.salesComparison.message || data.purchaseComparison.message}
                  />
                </div>
              )}
            </div>

            {topProductsReal && data.topProducts.data.items.length > 0 ? (
              <DonutChart
                title="Top 5 Products (Sales)"
                centerLabel="Total Sales"
                centerValue={formatCompactCurrency(
                  data.topProducts.data.items.reduce((s, p) => s + p.totalAmount, 0)
                )}
                data={data.topProducts.data.items.map((p) => ({ name: p.itemName, value: p.totalAmount }))}
              />
            ) : (
              <div className="rounded-2xl border border-surface-border bg-white p-4">
                <p className="mb-3 text-[15px] font-semibold text-ink-900">Top 5 Products (Sales)</p>
                <AnalyticsNotice state={data.topProducts.state} message={data.topProducts.message} />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
            {salesTrendReal && data.salesTrend.data.items.length > 0 ? (
              <LineTrendChart
                title="Sales Trend"
                subtitle="Real monthly totals, most recent months of synced data"
                data={data.salesTrend.data.items.map((i) => ({ label: i.label, value: i.totalSales }))}
                seriesName="Sales"
              />
            ) : (
              <div className="rounded-2xl border border-surface-border bg-white p-4">
                <p className="mb-3 text-[15px] font-semibold text-ink-900">Sales Trend</p>
                <AnalyticsNotice state={data.salesTrend.state} message={data.salesTrend.message} />
              </div>
            )}
            <RecentActivity items={buildRecentActivity(data.syncStatus)} />
          </div>
        </div>
      )}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <KpiCardSkeleton key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
        <ChartCardSkeleton />
        <ChartCardSkeleton />
      </div>
    </div>
  );
}
