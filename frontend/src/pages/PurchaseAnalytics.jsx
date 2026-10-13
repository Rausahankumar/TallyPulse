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
  getSupplierRates,
  getDiscountSummary,
} from "../api/analytics";
import { listPurchaseVouchers } from "../api/vouchers";
import VoucherRegister from "../components/vouchers/VoucherRegister";

const TABS = [
  { key: "trend", label: "Trend" },
  { key: "suppliers", label: "Top Suppliers" },
  { key: "rates", label: "Best Rates" },
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

  // The rate and discount calls are additive: if the server does not have them yet, the rest of the page still loads.
  const optional = (promise) => promise.catch(() => null);
  const [summary, comparison, topSuppliers, trend, supplierRates, discountReceived] = await Promise.all([
    getPurchaseSummary({ from, to }),
    getPurchaseComparison(),
    getTopSuppliers({ from, to, limit: 10 }),
    getPurchaseTrend({ from, to }),
    optional(getSupplierRates({ from, to, limit: 15 })),
    optional(getDiscountSummary({ from, to, entity: "purchase" })),
  ]);

  return { summary, comparison, topSuppliers, trend, supplierRates, discountReceived };
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
  const received = data?.discountReceived;
  const receivedTotals = received && REAL_STATES.has(received.state) && received.data?.hasData ? received.data.totals : null;

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

          {receivedTotals && (
            <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <MiniStatCard label="List Value (before discount)" value={formatCompactCurrency(receivedTotals.grossAmount)} delta={null} />
              <MiniStatCard label="Discount Received" value={formatCompactCurrency(receivedTotals.discountAmount)} delta={null} />
              <MiniStatCard label="Avg Discount" value={`${receivedTotals.discountPct.toFixed(1)}%`} delta={null} />
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

          {tab === "rates" && (
            <Card>
              <CardHeader
                title="Best Purchase Rate by Product"
                subtitle="Cheapest regular supplier per product (rate = billed amount ÷ quantity, after discount, before tax), scoped to the date range above"
              />
              {!data.supplierRates ? (
                <AnalyticsNotice state="analytics_error" message="Supplier rates are not available from the server yet. Restart the backend with the latest code." />
              ) : !REAL_STATES.has(data.supplierRates.state) ? (
                <AnalyticsNotice state={data.supplierRates.state} message={data.supplierRates.message} />
              ) : data.supplierRates.data.rows.length === 0 ? (
                <AnalyticsNotice state="zero_result" message="No purchases in this range." />
              ) : (
                <>
                  <Table
                    rowKey="product"
                    rows={data.supplierRates.data.rows}
                    columns={[
                      {
                        key: "product",
                        header: "Product",
                        render: (r) => (
                          <span>
                            {r.product}
                            {r.unitWarning && (
                              <span title="Line rates differ more than 5x: the unit of measure may differ between bills" className="ml-1 text-warning-600">
                                ⚠
                              </span>
                            )}
                          </span>
                        ),
                      },
                      { key: "bestSupplier", header: "Best Supplier" },
                      { key: "bestRate", header: "Best Rate", align: "right", render: (r) => formatCurrency(r.bestRate) },
                      { key: "avgRate", header: "Avg Rate", align: "right", render: (r) => formatCurrency(r.avgRate) },
                      { key: "savingIfAllAtBest", header: "Saving if all at best", align: "right", render: (r) => formatCurrency(r.savingIfAllAtBest) },
                      {
                        key: "suppliers",
                        header: "Suppliers (avg rate)",
                        render: (r) =>
                          r.suppliers
                            .slice(0, 4)
                            .map((s) => `${s.supplier} ${formatCurrency(s.avgRate)}${s.lowVolume ? "*" : ""}`)
                            .join(" · "),
                      },
                    ]}
                  />
                  <p className="mt-3 text-[12px] text-ink-400">
                    * a very small share of the volume (under 5%), so it is not treated as the best rate. "Saving if all at best" is
                    indicative: it assumes the best supplier could supply the whole quantity. {data.supplierRates.data.disclosures?.[0]}
                  </p>
                </>
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
