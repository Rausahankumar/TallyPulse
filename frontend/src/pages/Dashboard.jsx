import { DollarSign, ShoppingBag, TrendingUp, Users } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import MockDataBanner from "../components/ui/MockDataBanner";
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
import { formatCompactCurrency } from "../lib/format";
import {
  getSalesSummary,
  getPurchaseSummary,
  getSalesComparison,
  getPurchaseComparison,
  getTopProducts,
} from "../api/analytics";
import { MOCK_SALES_VS_PURCHASES, MOCK_SALES_TREND, MOCK_RECENT_ACTIVITY } from "../mock/mockData";

// Real (Analytics Engine, via REST): Total Sales, Total Purchases, and
// their growth deltas, plus the Top 5 Products donut. Freshness badge
// reflects the Sales checkpoint (the same signal the "Run Sales Sync
// Now" button on Sync & Data acts on).
//
// Still sample: Gross Profit and Total Customers (no such calculation
// exists in the Analytics Engine — no cost/COGS data is captured, and
// there's no "distinct customer count" function — see
// salesAnalytics.js), and the Sales-vs-Purchases / Sales Trend charts
// and Recent Activity feed (the engine has no monthly-breakdown or
// activity-log capability, only period summaries and two-period
// comparisons). Each is labeled inline rather than hidden.
async function loadDashboard() {
  const [salesSummary, purchaseSummary, salesComparison, purchaseComparison, topProducts] =
    await Promise.all([
      getSalesSummary(),
      getPurchaseSummary(),
      getSalesComparison(),
      getPurchaseComparison(),
      getTopProducts({ limit: 5 }),
    ]);

  return { salesSummary, purchaseSummary, salesComparison, purchaseComparison, topProducts };
}

const REAL_STATES = new Set(["valid_data", "stale_data"]);

export default function Dashboard() {
  const { activeCompany } = useCompany();
  const { data, loading, error } = useAsync(loadDashboard, [activeCompany?.tenantId]);

  const salesReal = data && REAL_STATES.has(data.salesSummary.state);
  const purchaseReal = data && REAL_STATES.has(data.purchaseSummary.state);
  const topProductsReal = data && REAL_STATES.has(data.topProducts.state);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Here's what's happening with your business today."
        action={data && <FreshnessBadge freshness={data.salesSummary.freshness} />}
      />

      <MockDataBanner label="Gross Profit, Total Customers, trend charts and Recent Activity are sample data" />

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
              icon={DollarSign}
              tone="brand"
            />
            <KpiCard
              label="Total Purchases"
              value={purchaseReal ? formatCompactCurrency(data.purchaseSummary.data.totalPurchases) : "—"}
              delta={purchaseReal ? data.purchaseComparison.data?.growthPercentage ?? null : null}
              icon={ShoppingBag}
              tone="violet"
            />
            <KpiCard label="Gross Profit" value="Not available" delta={null} icon={TrendingUp} tone="success" />
            <KpiCard label="Total Customers" value="Not available" delta={null} icon={Users} tone="warning" />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div>
              <ComparisonBarChart
                title="Sales vs Purchases"
                subtitle="Sample data — no monthly breakdown endpoint exists yet"
                data={MOCK_SALES_VS_PURCHASES}
                series={[
                  { key: "sales", name: "Sales", color: "#3269ea" },
                  { key: "purchases", name: "Purchases", color: "#b9d2ff" },
                ]}
              />
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
            <LineTrendChart
              title="Sales Trend"
              subtitle="Sample data — no monthly breakdown endpoint exists yet"
              seriesName="Sales"
              data={MOCK_SALES_TREND}
            />
            <RecentActivity items={MOCK_RECENT_ACTIVITY} />
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
