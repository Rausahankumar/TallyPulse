import { useState } from "react";
import { AlertTriangle, CheckCircle2, PlugZap, RefreshCw } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import Card, { CardHeader } from "../components/ui/Card";
import Badge from "../components/ui/Badge";
import Button from "../components/ui/Button";
import Input from "../components/ui/Input";
import Table from "../components/ui/Table";
import Tabs from "../components/ui/Tabs";
import EmptyState from "../components/ui/EmptyState";
import { TableSkeleton } from "../components/ui/Skeleton";
import { importTallyLive } from "../api/imports";
import { getSyncStatus } from "../api/sync";
import { ApiError } from "../api/client";
import { useAsync } from "../lib/useAsync";
import { useTallyConnectionTest } from "../lib/useTallyConnectionTest";
import { useCompany } from "../context/CompanyContext";
import { formatCurrency } from "../lib/format";
import { toDateInputValue, parseDateInputValue, formatRangeLabel } from "../lib/mockDateRange";

// Three real backend calls power this page now:
//   - GET /api/odbc/company  -> "Test Tally Connection"
//   - POST /api/import/tally-live?fromDate&toDate -> "Run Sales Sync Now"
//   - GET /api/sync/status -> real SyncCheckpoint/ReconciliationCheckpoint
//     rows and the actual synced Sale/Purchase records for this tenant
// Nothing on this page is sample data anymore. A checkpoint that hasn't
// run yet for this tenant comes back as null from the backend and is
// shown honestly as "Not synced yet", not a fabricated placeholder.

// Local midnight for "today" — never toISOString()/UTC, which would
// silently shift the default range back a day for anyone east of UTC
// (the exact bug already found and fixed on the Analytics pages'
// FilterBar). This is what makes "today" genuinely the user's local
// today, not a UTC-shifted one.
function todayLocal() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function formatTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function IncrementalStatusBadge({ checkpoint }) {
  if (!checkpoint) return <Badge tone="neutral" dot>Not synced yet</Badge>;
  if (checkpoint.lastRunStatus === "failed") return <Badge tone="danger" dot>Failed</Badge>;
  if (checkpoint.isRunning) return <Badge tone="brand" dot>Running</Badge>;
  return <Badge tone="success" dot>Synced</Badge>;
}

function ReconciliationStatusBadge({ checkpoint }) {
  if (!checkpoint || checkpoint.lastRunStatus === "never_run") {
    return <Badge tone="neutral" dot>Not run yet</Badge>;
  }
  if (checkpoint.lastRunStatus === "aborted_unsafe") return <Badge tone="warning" dot>Needs review</Badge>;
  if (checkpoint.lastRunStatus === "failed") return <Badge tone="danger" dot>Failed</Badge>;
  return <Badge tone="success" dot>Completed</Badge>;
}

const VOUCHER_COLUMNS = [
  { key: "voucherNo", header: "Voucher No" },
  { key: "voucherDate", header: "Date", render: (r) => (r.voucherDate ? new Date(r.voucherDate).toLocaleDateString("en-GB") : "—") },
  { key: "partyName", header: "Party" },
  { key: "amount", header: "Amount", align: "right", render: (r) => formatCurrency(r.amount) },
  {
    key: "voucherStatus",
    header: "Status",
    render: (r) => (
      <Badge tone={r.voucherStatus === "active" ? "success" : r.voucherStatus === "cancelled" ? "warning" : "danger"}>
        {r.voucherStatus}
      </Badge>
    ),
  },
  { key: "updatedAt", header: "Last Updated", render: (r) => formatTimestamp(r.updatedAt) || "—" },
];

const RECORD_TABS = [
  { key: "sales", label: "Sales" },
  { key: "purchases", label: "Purchases" },
];

export default function SyncData() {
  const { activeCompany } = useCompany();
  const {
    status: tallyStatus,
    detail: tallyDetail,
    run: handleTestConnection,
  } = useTallyConnectionTest(activeCompany?.companyName);

  const { data: syncStatus, loading: statusLoading, error: statusError, reload: reloadStatus } = useAsync(
    getSyncStatus,
    [activeCompany?.tenantId]
  );

  const [fromDate, setFromDate] = useState(() => toDateInputValue(todayLocal()));
  const [toDate, setToDate] = useState(() => toDateInputValue(todayLocal()));
  const [liveImportStatus, setLiveImportStatus] = useState(null); // null | 'running' | 'ok' | 'empty' | 'error'
  const [liveImportMessage, setLiveImportMessage] = useState(null);
  const [lastRun, setLastRun] = useState(null); // real, client-observed: { at, fromDate, toDate }
  const [recordTab, setRecordTab] = useState("sales");

  const rangeInvalid =
    !!fromDate && !!toDate && parseDateInputValue(fromDate) > parseDateInputValue(toDate);

  async function handleRunSalesNow() {
    if (rangeInvalid) return;

    setLiveImportStatus("running");
    try {
      const result = await importTallyLive({ fromDate, toDate });
      setLiveImportMessage(result.message || "Sales sync completed.");
      setLiveImportStatus("ok");
      setLastRun({ at: new Date(), fromDate, toDate });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Sales sync failed.";
      setLiveImportMessage(message);
      // "No Tally voucher data found..." is a real, well-formed answer
      // from Tally (nothing changed in the requested range) - not a
      // failure. Keep it visually distinct from an actual error.
      setLiveImportStatus(
        err instanceof ApiError && err.status === 400 && message.includes("No Tally voucher data found")
          ? "empty"
          : "error"
      );
      setLastRun({ at: new Date(), fromDate, toDate });
    } finally {
      // Real refresh, regardless of outcome — a successful run may have
      // created/updated records, and even a failed one may reflect a
      // freshly-changed checkpoint (e.g. the background worker ticking
      // in parallel), so the panels below should never show stale state.
      reloadStatus();
    }
  }

  const incrementalSales = syncStatus?.incremental?.sales ?? null;
  const incrementalPurchase = syncStatus?.incremental?.purchase ?? null;
  const reconciliationSales = syncStatus?.reconciliation?.sales ?? null;
  const reconciliationPurchase = syncStatus?.reconciliation?.purchase ?? null;

  const overallProblem =
    incrementalSales?.lastRunStatus === "failed" ||
    incrementalPurchase?.lastRunStatus === "failed" ||
    reconciliationSales?.lastRunStatus === "aborted_unsafe" ||
    reconciliationSales?.lastRunStatus === "failed" ||
    reconciliationPurchase?.lastRunStatus === "aborted_unsafe" ||
    reconciliationPurchase?.lastRunStatus === "failed";

  const records = recordTab === "sales" ? syncStatus?.recentSales : syncStatus?.recentPurchases;

  return (
    <div>
      <PageHeader title="Sync & Data" subtitle="Monitor your data synchronization and system health." />

      <Card className="mb-5">
        <CardHeader
          title="TallyPrime Connection"
          subtitle="Real check against the backend's /api/odbc/company endpoint"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" icon={PlugZap} loading={tallyStatus === "checking"} onClick={handleTestConnection}>
            Test Connection
          </Button>
          {tallyStatus === "ok" && <Badge tone="success" dot>Connected</Badge>}
          {tallyStatus === "mismatch" && <Badge tone="warning" dot>Wrong company</Badge>}
          {tallyStatus === "ambiguous" && <Badge tone="warning" dot>Multiple companies open</Badge>}
          {tallyStatus === "no_company" && <Badge tone="warning" dot>No company data</Badge>}
          {tallyStatus === "error" && <Badge tone="danger" dot>Unreachable</Badge>}
          {tallyDetail && <span className="text-[13px] text-ink-500">{tallyDetail}</span>}
        </div>
      </Card>

      {statusError && (
        <div className="mb-5 rounded-xl border border-danger-50 bg-danger-50 px-4 py-3 text-[13px] text-danger-600">
          Couldn't load sync status: {statusError.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Incremental Sync" action={<IncrementalStatusBadge checkpoint={incrementalSales} />} />
          <dl className="space-y-2.5 text-[13px]">
            <Row label="Last Run (Sales)" value={formatTimestamp(incrementalSales?.lastSyncedAt) || "Not synced yet"} />
            <Row label="Last Run (Purchase)" value={formatTimestamp(incrementalPurchase?.lastSyncedAt) || "Not synced yet"} />
            <Row label="Sales Vouchers" value={<IncrementalStatusBadge checkpoint={incrementalSales} />} />
            <Row label="Purchase Vouchers" value={<IncrementalStatusBadge checkpoint={incrementalPurchase} />} />
            <Row label="Runs automatically" value="every ~60 seconds" />
          </dl>
          {incrementalSales?.lastRunStatus === "failed" && incrementalSales?.lastError && (
            <p className="mt-2 text-[12px] text-danger-600">{incrementalSales.lastError}</p>
          )}

          <div className="mt-4 grid grid-cols-2 gap-2.5">
            <Input
              label="From Date"
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(e) => setFromDate(e.target.value)}
            />
            <Input
              label="To Date"
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
          {rangeInvalid && (
            <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-danger-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              From date must be on or before To date.
            </p>
          )}

          <Button
            variant="secondary"
            size="sm"
            icon={RefreshCw}
            loading={liveImportStatus === "running"}
            disabled={rangeInvalid}
            onClick={handleRunSalesNow}
            className="mt-3"
          >
            Run Sales Sync Now
          </Button>
          {liveImportMessage && (
            <p
              className={`mt-2 text-[12.5px] ${
                liveImportStatus === "error"
                  ? "text-danger-600"
                  : liveImportStatus === "empty"
                    ? "text-warning-600"
                    : "text-success-600"
              }`}
            >
              {liveImportMessage}
            </p>
          )}
          {lastRun && (
            <p className="mt-1 text-[11.5px] text-ink-400">
              Last request: {formatRangeLabel({ from: parseDateInputValue(lastRun.fromDate), to: parseDateInputValue(lastRun.toDate) })}
              {" · "}
              sent at {lastRun.at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </p>
          )}
          <p className="mt-1.5 text-[11.5px] text-ink-400">
            Purchase has no manual trigger on the backend today — it only syncs via the automatic
            worker.
          </p>
        </Card>

        <Card>
          <CardHeader title="Reconciliation Sync" action={<ReconciliationStatusBadge checkpoint={reconciliationSales} />} />
          <dl className="space-y-2.5 text-[13px]">
            <Row label="Last Run (Sales)" value={formatTimestamp(reconciliationSales?.lastRunAt) || "Not run yet"} />
            <Row label="Last Run (Purchase)" value={formatTimestamp(reconciliationPurchase?.lastRunAt) || "Not run yet"} />
            <Row label="Sales Reconciliation" value={<ReconciliationStatusBadge checkpoint={reconciliationSales} />} />
            <Row label="Purchase Reconciliation" value={<ReconciliationStatusBadge checkpoint={reconciliationPurchase} />} />
            <Row label="Runs automatically" value="every ~20 minutes" />
          </dl>
          {reconciliationSales?.lastRunStatus === "aborted_unsafe" && reconciliationSales?.lastError && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {reconciliationSales.lastError}
            </p>
          )}
          {reconciliationPurchase?.lastRunStatus === "aborted_unsafe" && reconciliationPurchase?.lastError && (
            <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {reconciliationPurchase.lastError}
            </p>
          )}
          <Button variant="secondary" size="sm" icon={RefreshCw} disabled className="mt-4">
            Run Now
          </Button>
          <p className="mt-1.5 text-[11.5px] text-ink-400">
            No manual-trigger endpoint exists for reconciliation on the backend yet.
          </p>
        </Card>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Recently Synced Records"
          subtitle={`Real documents from this company's tenant · ${syncStatus?.totalSales ?? 0} sales, ${syncStatus?.totalPurchases ?? 0} purchases total`}
        />
        <Tabs tabs={RECORD_TABS} active={recordTab} onChange={setRecordTab} />
        {statusLoading ? (
          <TableSkeleton />
        ) : !records || records.length === 0 ? (
          <EmptyState
            title="No synced records yet"
            description="Once TallyPrime syncs a voucher for this company, it will show up here."
          />
        ) : (
          <Table rowKey="tallyGuid" rows={records} columns={VOUCHER_COLUMNS} />
        )}
      </Card>

      <div
        className={`mt-5 flex items-center gap-2 rounded-xl border px-4 py-3 text-[13px] ${
          overallProblem
            ? "border-warning-50 bg-warning-50 text-warning-600"
            : "border-success-50 bg-success-50 text-success-600"
        }`}
      >
        {overallProblem ? <AlertTriangle className="h-4.5 w-4.5" /> : <CheckCircle2 className="h-4.5 w-4.5" />}
        {overallProblem
          ? "One or more sync/reconciliation jobs need attention — see the details above."
          : "No sync or reconciliation failures reported for this company right now."}
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-500">{label}</dt>
      <dd className="font-medium text-ink-800">{value}</dd>
    </div>
  );
}
