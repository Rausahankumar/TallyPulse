import { useState } from "react";
import PageHeader from "../components/ui/PageHeader";
import FilterBar from "../components/ui/FilterBar";
import Tabs from "../components/ui/Tabs";
import Badge from "../components/ui/Badge";
import Card, { CardHeader } from "../components/ui/Card";
import Table from "../components/ui/Table";
import AnalyticsNotice, { StaleDataBanner } from "../components/ui/AnalyticsNotice";
import SimpleBarChart from "../components/charts/SimpleBarChart";
import ComparisonBarChart from "../components/charts/ComparisonBarChart";
import Select from "../components/ui/Select";
import { TableSkeleton, ChartCardSkeleton } from "../components/ui/Skeleton";
import { useCompany } from "../context/useCompany";
import { useAsync } from "../lib/useAsync";
import { usePersistedRange } from "../lib/usePersistedRange";
import { formatCurrency } from "../lib/format";
import { DEFAULT_RANGE, toDateInputValue } from "../lib/dateRange";
import { getTopProducts, getGrowingProducts, getDecliningProducts, getProductMargin, getProductTrend } from "../api/analytics";

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

// Margin sort choices: [sortBy, order] sent to /analytics/products/margin.
const MARGIN_SORTS = [
  { value: "profit:desc", label: "Highest profit first", sortBy: "profit", order: "desc" },
  { value: "profit:asc", label: "Lowest profit / losses first", sortBy: "profit", order: "asc" },
  { value: "marginPct:desc", label: "Highest margin % first", sortBy: "marginPct", order: "desc" },
  { value: "marginPct:asc", label: "Lowest margin % first", sortBy: "marginPct", order: "asc" },
];

const signed = (n) => (n >= 0 ? `+${formatCurrency(n)}` : `-${formatCurrency(Math.abs(n))}`);
const tone = (n) => (n >= 0 ? "text-success-600" : "text-danger-600");
// a net quantity of exactly zero is neither good nor bad
const qtyTone = (n) => (n > 0 ? "text-success-600" : n < 0 ? "text-danger-600" : "text-ink-500");
const signedQty = (n) => (n > 0 ? `+${n}` : `${n}`);

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

  // Margin and trend are additive calls: if the server does not have them yet (older backend), the rest of the page still loads.
  const [marginSort, setMarginSort] = useState("profit:desc");
  const [trendProduct, setTrendProduct] = useState(null);
  const from = toDateInputValue(range.from);
  const to = toDateInputValue(range.to);
  const sortChoice = MARGIN_SORTS.find((s) => s.value === marginSort) || MARGIN_SORTS[0];
  const margin = useAsync(
    () => getProductMargin({ from, to, limit: 15, sortBy: sortChoice.sortBy, order: sortChoice.order }).catch(() => null),
    [activeCompany?.tenantId, from, to, marginSort]
  );
  const trend = useAsync(
    () => (trendProduct ? getProductTrend({ product: trendProduct, from, to }).catch((e) => ({ failed: e })) : null),
    [activeCompany?.tenantId, from, to, trendProduct]
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

          <Card>
            <CardHeader
              title="Margin by Product (indicative)"
              subtitle="Average sale rate vs average purchase cost per unit in the date range above (after discount, before tax). Click a product to see its monthly trend."
              action={
                <Select aria-label="Sort margin" value={marginSort} onChange={(e) => setMarginSort(e.target.value)}>
                  {MARGIN_SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              }
            />
            {margin.loading && !margin.data ? (
              <TableSkeleton />
            ) : !margin.data ? (
              <AnalyticsNotice state="analytics_error" message="Margins are not available from the server yet. Restart the backend with the latest code." />
            ) : !REAL_STATES.has(margin.data.state) ? (
              <AnalyticsNotice state={margin.data.state} message={margin.data.message} />
            ) : margin.data.data.rows.length === 0 ? (
              <AnalyticsNotice state="zero_result" message="No sales in this range." />
            ) : (
              <>
                <p className="mb-3 text-[13px] text-ink-600">
                  Indicative profit <strong className={tone(margin.data.data.summary.indicativeProfit)}>{formatCurrency(margin.data.data.summary.indicativeProfit)}</strong>{" "}
                  on {formatCurrency(margin.data.data.summary.costedSaleAmount)} of sales that have a cost
                  {margin.data.data.summary.marginPct == null ? "" : ` (${margin.data.data.summary.marginPct}%)`}.{" "}
                  {margin.data.data.summary.withoutCost} of {margin.data.data.summary.products} products sold have no purchase cost to compare with;{" "}
                  {margin.data.data.summary.belowCost} sell below cost. The table shows {margin.data.data.rows.length} of them.
                </p>
                <Table
                  rowKey="product"
                  rows={margin.data.data.rows}
                  columns={[
                    {
                      key: "product",
                      header: "Product",
                      render: (r) => (
                        <span>
                          <button type="button" className="text-left font-medium text-brand-600 hover:underline" onClick={() => setTrendProduct(r.product)}>
                            {r.product}
                          </button>
                          {r.unitWarning && (
                            <span title="Line rates differ more than 5x: the unit of measure may differ between vouchers" className="ml-1 text-warning-600">
                              ⚠
                            </span>
                          )}
                          {r.belowCost && (
                            <Badge tone="danger" className="ml-2">
                              Below cost
                            </Badge>
                          )}
                        </span>
                      ),
                    },
                    { key: "soldQty", header: "Sold Qty", align: "right", render: (r) => r.soldQty },
                    { key: "saleRate", header: "Sold at (avg)", align: "right", render: (r) => formatCurrency(r.saleRate) },
                    {
                      key: "costRate",
                      header: "Cost (avg purchase)",
                      align: "right",
                      render: (r) =>
                        r.costRate == null ? (
                          "—"
                        ) : (
                          <span>
                            {formatCurrency(r.costRate)}
                            {r.costSource === "earlier" && (
                              <span title="Nothing was bought in this range: the average purchase rate of the 12 months before it" className="ml-1 text-ink-400">
                                *
                              </span>
                            )}
                          </span>
                        ),
                    },
                    { key: "unitMargin", header: "Margin / unit", align: "right", render: (r) => (r.unitMargin == null ? "—" : <span className={tone(r.unitMargin)}>{signed(r.unitMargin)}</span>) },
                    { key: "marginPct", header: "Margin %", align: "right", render: (r) => (r.marginPct == null ? "—" : <span className={tone(r.marginPct)}>{r.marginPct}%</span>) },
                    {
                      key: "indicativeProfit",
                      header: "Indicative profit",
                      align: "right",
                      render: (r) => (r.indicativeProfit == null ? "—" : <span className={tone(r.indicativeProfit)}>{signed(r.indicativeProfit)}</span>),
                    },
                  ]}
                />
                <p className="mt-3 text-[12px] text-ink-400">
                  * cost taken from the 12 months before the range (nothing was bought in it). {margin.data.data.disclosures?.[0]}
                </p>
              </>
            )}
          </Card>

          <Card>
            <CardHeader
              title={trendProduct ? `Monthly trend: ${trendProduct}` : "Monthly trend"}
              subtitle="Quantity bought and sold per month in the date range above. Pick a longer range for more months."
              action={
                trendProduct ? (
                  <button type="button" className="text-[13px] text-ink-500 hover:underline" onClick={() => setTrendProduct(null)}>
                    Clear
                  </button>
                ) : null
              }
            />
            {!trendProduct ? (
              <p className="py-6 text-center text-sm text-ink-500">Click a product in the margin table above to see how much of it was bought and sold each month.</p>
            ) : trend.loading && !trend.data ? (
              <TableSkeleton />
            ) : trend.error || !trend.data || trend.data.failed ? (
              <AnalyticsNotice state="analytics_error" message="The monthly trend is not available from the server yet. Restart the backend with the latest code." />
            ) : !REAL_STATES.has(trend.data.state) ? (
              <AnalyticsNotice state={trend.data.state} message={trend.data.message} />
            ) : trend.data.data.rows.length === 0 ? (
              <AnalyticsNotice state="zero_result" message="Nothing of this product was bought or sold in this range." />
            ) : (
              <>
                <p className="mb-3 text-[13px] text-ink-600">
                  Bought {trend.data.data.totals.purchaseQty}, sold {trend.data.data.totals.saleQty}; net movement{" "}
                  <strong className={qtyTone(trend.data.data.totals.netQty)}>{signedQty(trend.data.data.totals.netQty)}</strong>.
                </p>
                <div>
                  <Table
                    rowKey="month"
                    rows={trend.data.data.rows}
                    columns={[
                      { key: "month", header: "Month" },
                      { key: "purchaseQty", header: "Bought Qty", align: "right", render: (r) => r.purchaseQty },
                      { key: "purchaseRate", header: "Bought at (avg)", align: "right", render: (r) => (r.purchaseRate == null ? "—" : formatCurrency(r.purchaseRate)) },
                      { key: "saleQty", header: "Sold Qty", align: "right", render: (r) => r.saleQty },
                      { key: "saleRate", header: "Sold at (avg)", align: "right", render: (r) => (r.saleRate == null ? "—" : formatCurrency(r.saleRate)) },
                      { key: "netQty", header: "Net movement", align: "right", render: (r) => <span className={qtyTone(r.netQty)}>{signedQty(r.netQty)}</span> },
                      { key: "cumulativeNetQty", header: "Running total", align: "right", render: (r) => r.cumulativeNetQty },
                    ]}
                  />
                </div>
                <p className="mt-3 text-[12px] text-ink-400">{trend.data.data.disclosures?.[0]}</p>
              </>
            )}
          </Card>

          {trendProduct && trend.data && !trend.data.failed && REAL_STATES.has(trend.data.state) && trend.data.data.rows.length > 0 && (
            <ComparisonBarChart
              title={`Bought vs sold (quantity): ${trendProduct}`}
              subtitle="Per month, same range as the table above"
              data={trend.data.data.rows.map((r) => ({ label: r.month, bought: r.purchaseQty, sold: r.saleQty }))}
              series={[
                { key: "bought", name: "Bought", color: "#b9d2ff" },
                { key: "sold", name: "Sold", color: "#3269ea" },
              ]}
              valueFormat="number"
            />
          )}

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
