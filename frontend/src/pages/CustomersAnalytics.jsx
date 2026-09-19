import { useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import MiniStatCard from "../components/ui/MiniStatCard";
import Card, { CardHeader } from "../components/ui/Card";
import Table from "../components/ui/Table";
import DonutChart from "../components/charts/DonutChart";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import { useCompany } from "../context/CompanyContext";
import { useAsync } from "../lib/useAsync";
import { formatCurrency } from "../lib/format";
import { DEFAULT_RANGE, toDateInputValue } from "../lib/mockDateRange";
import { getTopCustomers } from "../api/analytics";
import { MOCK_CUSTOMER_SEGMENTS } from "../mock/mockData";

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Real (Analytics Engine, via REST): Top Customers by Sales, scoped to
// the date range above. Still sample: Total/Active/New Customers
// summary counts and the Customer Distribution donut — no "distinct
// customer count" or "customer segmentation" capability exists in the
// Analytics Engine (getTopCustomers only ranks the top N by sales in a
// period, it isn't a total count).
async function loadCustomersAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);
  const topCustomers = await getTopCustomers({ from, to, limit: 10 });
  return { topCustomers };
}

export default function CustomersAnalytics() {
  const { activeCompany } = useCompany();
  const [fy, setFy] = useState("fy2025-26");
  const [range, setRange] = useState(DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadCustomersAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  return (
    <div>
      <PageHeader title="Customers Analytics" subtitle="Know your customers better." />
      <FilterBar
        fy={fy}
        onFyChange={setFy}
        range={range}
        onRangeChange={setRange}
        onReset={() => setRange(DEFAULT_RANGE)}
      />

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
            <MiniStatCard label="Total Customers" value="Not available" delta={null} />
            <MiniStatCard label="Active Customers" value="Not available" delta={null} />
            <MiniStatCard label="New Customers" value="Not available" delta={null} />
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

            <DonutChart
              title="Customer Distribution"
              subtitle="Sample data — no segmentation endpoint exists yet"
              centerLabel="Total"
              centerValue="—"
              data={MOCK_CUSTOMER_SEGMENTS}
            />
          </div>
        </div>
      )}
    </div>
  );
}
