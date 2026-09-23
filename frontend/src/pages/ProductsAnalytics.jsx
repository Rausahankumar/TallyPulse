import { useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import Tabs from "../components/ui/Tabs";
import Badge from "../components/ui/Badge";
import Card, { CardHeader } from "../components/ui/Card";
import Table from "../components/ui/Table";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import SimpleBarChart from "../components/charts/SimpleBarChart";
import { TableSkeleton, ChartCardSkeleton } from "../components/ui/Skeleton";
import { useCompany } from "../context/useCompany";
import { useAsync } from "../lib/useAsync";
import { usePersistedRange } from "../lib/usePersistedRange";
import { formatCurrency } from "../lib/format";
import { DEFAULT_RANGE, toDateInputValue } from "../lib/mockDateRange";
import { getTopProducts, getGrowingProducts, getDecliningProducts } from "../api/analytics";

const TABS = [
  { key: "top", label: "Top Products" },
  { key: "growing", label: "Growing Products" },
  { key: "declining", label: "Declining Products" },
];

const REAL_STATES = new Set(["valid_data", "stale_data"]);

// Real (Analytics Engine, via REST): Top Products follows the date
// range picked above (period=custom). Growing/Declining Products
// compare this month to last month — the Analytics Engine's growth
// comparisons are fixed month-over-month, not tied to an arbitrary
// picked range, so those two tabs don't move with the picker (noted
// inline). Product Performance below reuses the same Top Products
// result — no separate chart-only calculation exists or is needed.
async function loadProductsAnalytics(range) {
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);

  const [top, growing, declining] = await Promise.all([
    getTopProducts({ from, to, limit: 10 }),
    getGrowingProducts({ limit: 10 }),
    getDecliningProducts({ limit: 10 }),
  ]);

  return { top, growing, declining };
}

// Normalizes the three tabs' different real shapes into one row shape:
//   Top Products:        {itemName, totalAmount, totalQuantity, orderCount}
//   Growing/Declining:   {itemName, current, previous, growthAmount, growthPercentage, isNew}
function normalizeRows(tab, envelope) {
  if (!envelope || !REAL_STATES.has(envelope.state)) return [];

  if (tab === "top") {
    return envelope.data.items.map((p) => ({
      itemName: p.itemName,
      amount: p.totalAmount,
      quantity: p.totalQuantity,
      growthPercentage: null,
      isNew: false,
    }));
  }

  return envelope.data.items.map((p) => ({
    itemName: p.itemName,
    amount: p.current,
    quantity: null,
    growthPercentage: p.growthPercentage,
    isNew: p.isNew,
  }));
}

const COLUMNS = [
  { key: "rank", header: "#", render: (_, i) => i + 1 },
  { key: "itemName", header: "Product Name" },
  { key: "amount", header: "Sales Amount", align: "right", render: (r) => formatCurrency(r.amount) },
  { key: "quantity", header: "Quantity", align: "right", render: (r) => (r.quantity == null ? "—" : r.quantity) },
  {
    key: "growthPercentage",
    header: "Growth",
    align: "right",
    render: (r) => {
      if (r.isNew) return <Badge tone="brand">New</Badge>;
      if (r.growthPercentage === null || r.growthPercentage === undefined) return "—";
      return (
        <span className={r.growthPercentage >= 0 ? "text-success-600" : "text-danger-600"}>
          {r.growthPercentage >= 0 ? "+" : ""}
          {r.growthPercentage.toFixed(1)}%
        </span>
      );
    },
  },
];

export default function ProductsAnalytics() {
  const { activeCompany } = useCompany();
  const [tab, setTab] = useState("top");
  const { range, setRange, reset: resetRange } = usePersistedRange("tp:range:products", DEFAULT_RANGE);
  const { data, loading, error } = useAsync(
    () => loadProductsAnalytics(range),
    [activeCompany?.tenantId, range.from.getTime(), range.to.getTime()]
  );

  const activeEnvelope = data ? { top: data.top, growing: data.growing, declining: data.declining }[tab] : null;
  const rows = data ? normalizeRows(tab, activeEnvelope) : [];

  return (
    <div>
      <PageHeader title="Products Analytics" subtitle="Discover your best and underperforming products." />
      <FilterBar range={range} onRangeChange={setRange} onReset={resetRange} />
      <p className="mb-4 text-[12px] text-ink-400">
        Top Products uses the date range above. Growing/Declining Products compare this month to
        last month (the Analytics Engine's growth comparisons are fixed month-over-month).
      </p>
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {error ? (
        <div className="rounded-2xl border border-surface-border bg-white p-10 text-center text-sm text-danger-600">
          Couldn't load products analytics: {error.message}
        </div>
      ) : loading || !data ? (
        <div className="space-y-4">
          <Card>
            <TableSkeleton />
          </Card>
          <ChartCardSkeleton />
        </div>
      ) : (
        <div className="space-y-4">
          {activeEnvelope.state === "stale_data" && <StaleDataBanner message={activeEnvelope.message} />}
          <Card>
            <CardHeader
              title={{ top: "Top Products", growing: "Growing Products", declining: "Declining Products" }[tab]}
            />
            {!REAL_STATES.has(activeEnvelope.state) ? (
              <AnalyticsNotice state={activeEnvelope.state} message={activeEnvelope.message} />
            ) : rows.length === 0 ? (
              <AnalyticsNotice state="zero_result" message="Nothing in this category for the selected range." />
            ) : (
              <Table rowKey="itemName" rows={rows} columns={COLUMNS} />
            )}
          </Card>

          {REAL_STATES.has(data.top.state) && data.top.data.items.length > 0 && (
            <SimpleBarChart
              title="Product Performance"
              subtitle="Top products by sales amount, same range as the Top Products tab"
              data={data.top.data.items.map((p) => ({ label: p.itemName, value: p.totalAmount }))}
            />
          )}
        </div>
      )}
    </div>
  );
}
