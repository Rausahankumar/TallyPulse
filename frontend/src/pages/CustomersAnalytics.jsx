import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import MiniStatCard from "../components/ui/MiniStatCard";
import Card, { CardHeader } from "../components/ui/Card";
import Table from "../components/ui/Table";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import DonutChart from "../components/charts/DonutChart";
import { useCompany } from "../context/useCompany";
import { useAsync } from "../lib/useAsync";
import { usePersistedRange } from "../lib/usePersistedRange";
import { formatCurrency, formatNumber } from "../lib/format";
import { DEFAULT_RANGE, toDateInputValue } from "../lib/mockDateRange";
import { getTopCustomers, getCustomerCounts } from "../api/analytics";

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Exact definitions used below (deliberately explicit, all derived from
// Sale.header.partyName — no invented "customer" concept):
//   Total Customers  - distinct parties across this tenant's ENTIRE
//                       sales history (all-time, ignores the picker).
//   Active Customers - distinct parties with >=1 sale in the picked
//                       range.
//   New Customers    - of those active-in-range parties, how many had
//                       their first-ever sale (all-time) fall inside
//                       the picked range (i.e. acquired in this window).
//   Customer Distribution - New vs Returning, i.e. New Customers vs
//                       (Active Customers - New Customers), for the
//                       picked range. Replaces the old "segmentation"
//                       card, which asked for a capability (tiering by
//                       spend/behavior) the data genuinely can't support
//                       — this is the real split the data DOES support.
async function loadCustomersAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);
  const [topCustomers, customerCounts] = await Promise.all([
    getTopCustomers({ from, to, limit: 10 }),
    getCustomerCounts({ from, to }),
  ]);
  return { topCustomers, customerCounts };
}

export default function CustomersAnalytics() {
  const { activeCompany } = useCompany();
  const { range, setRange, reset: resetRange } = usePersistedRange("tp:range:customers", DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadCustomersAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  const countsReal = data && REAL_STATES.has(data.customerCounts.state);
  const counts = countsReal ? data.customerCounts.data : null;
  const distributionData =
    countsReal && counts.newCustomers !== null && counts.activeCustomers > 0
      ? [
          { name: "Returning", value: counts.returningCustomers },
          { name: "New", value: counts.newCustomers },
        ].filter((d) => d.value > 0)
      : [];

  return (
    <div>
      <PageHeader title="Customers Analytics" subtitle="Know your customers better." />
      <FilterBar range={range} onRangeChange={setRange} onReset={resetRange} />

      {error ? (
        <div className="rounded-2xl border border-surface-border bg-white p-10 text-center text-sm text-danger-600">
          Couldn't load customers analytics: {error.message}
        </div>
      ) : loading || !data ? (
        <div className="grid grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="h-24 animate-pulse bg-surface-alt" />
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <MiniStatCard
              label="Total Customers"
              value={countsReal ? formatNumber(counts.totalCustomers) : "—"}
              delta={null}
              hint={countsReal ? "All-time, across your full sales history" : data.customerCounts.message}
            />
            <MiniStatCard
              label="Active Customers"
              value={countsReal ? formatNumber(counts.activeCustomers) : "—"}
              delta={null}
              hint={countsReal ? "Made at least one sale in the selected range" : data.customerCounts.message}
            />
            <MiniStatCard
              label="New Customers"
              value={countsReal ? formatNumber(counts.newCustomers) : "—"}
              delta={null}
              hint={countsReal ? "First-ever sale falls in the selected range" : data.customerCounts.message}
            />
          </div>

          {data.topCustomers.state === "stale_data" && <StaleDataBanner message={data.topCustomers.message} />}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.4fr_1fr]">
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

            {distributionData.length > 0 ? (
              <DonutChart
                title="Customer Distribution"
                subtitle="New vs returning, scoped to the date range above"
                centerLabel="Active Customers"
                centerValue={formatNumber(counts.activeCustomers)}
                data={distributionData}
                valueFormatter={formatNumber}
              />
            ) : (
              <Card>
                <CardHeader title="Customer Distribution" subtitle="New vs returning, scoped to the date range above" />
                <AnalyticsNotice
                  state={countsReal ? "zero_result" : data.customerCounts.state}
                  message={countsReal ? "No active customers in this range." : data.customerCounts.message}
                />
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
