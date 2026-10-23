import { ArrowDownRight, ArrowUpRight, Minus, SearchX } from "lucide-react";
import DataTable from "./DataTable";
import { RankingChart, TrendChart, ComparisonChart } from "./charts";
import { cn } from "../../../lib/cn";

// Renders the backend's presentation model (message.visualization, v1). Pure and local: no request, no AI
// call, no calculation - every number shown is a string the backend produced from the engine result.
function Header({ p }) {
  return (
    <div className="space-y-1.5">
      <p className="flex flex-wrap items-baseline gap-x-2 text-[13.5px] font-semibold text-ink-900">
        {/* a KPI card carries its own metric name, so the title would only repeat it */}
        {p.kind === "kpi" ? <span>{p.period.label}</span> : <><span>{p.title}</span><span className="font-medium text-ink-500">· {p.period.label}</span></>}
        {p.dimension && <span className="font-medium text-ink-500">· by {p.dimension.toLowerCase()}</span>}
      </p>
      {p.scope.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {p.scope.map((s, i) => (
            <span key={i} className="max-w-full break-words rounded-full border border-surface-border bg-white px-2 py-0.5 text-[11.5px] text-ink-700">
              <span className="text-ink-500">{s.label}:</span> {s.value}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Footer({ p, extra = [] }) {
  const lines = [...extra, ...p.basis, ...p.notes];
  if (!lines.length) return null;
  return (
    <ul className="space-y-0.5 text-[11.5px] leading-snug text-ink-500">
      {lines.map((n, i) => (
        <li key={i}>• {n}</li>
      ))}
    </ul>
  );
}

function MetricCard({ p }) {
  return (
    <div className="rounded-xl border border-surface-border bg-white px-4 py-3">
      <p className="text-[12.5px] font-medium text-ink-500">{p.headline.label}</p>
      <p className="mt-1 break-words text-[26px] font-semibold leading-tight tracking-tight text-ink-900 tabular-nums">{p.headline.display}</p>
      {p.secondary.length > 0 && (
        <p className="mt-1 flex flex-wrap gap-x-3 text-[13px] text-ink-700">
          {p.secondary.map((s) => (
            <span key={s.id} className="tabular-nums">
              {s.display} {s.unit || s.label.toLowerCase()}
            </span>
          ))}
        </p>
      )}
      {p.period.range && <p className="mt-2 text-[12px] text-ink-500">{p.period.range}</p>}
    </div>
  );
}

const DIRECTION = {
  up: { icon: ArrowUpRight, cls: "bg-success-50 text-success-600" },
  down: { icon: ArrowDownRight, cls: "bg-danger-50 text-danger-600" },
  flat: { icon: Minus, cls: "bg-surface-alt text-ink-500" },
};

function ChangeCard({ changes, primary }) {
  const ordered = [...changes].sort((a, b) => (b.metric === primary) - (a.metric === primary));
  return (
    <div className="rounded-xl border border-surface-border bg-white px-4 py-3">
      <p className="text-[12.5px] font-medium text-ink-500">Change</p>
      <div className="mt-1 space-y-2">
        {ordered.map((c, i) => {
          const d = DIRECTION[c.direction];
          return (
            <div key={c.metric} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={cn("tabular-nums text-ink-900", i === 0 ? "text-[20px] font-semibold" : "text-[13px] font-medium")}>{c.display}</span>
              <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums", d.cls)}>
                <d.icon className="h-3.5 w-3.5" />
                {c.pct}
              </span>
              {ordered.length > 1 && <span className="text-[12px] text-ink-500">{c.label}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Empty({ p }) {
  return (
    <div className="rounded-xl border border-surface-border bg-white px-4 py-5 text-center">
      <SearchX className="mx-auto h-5 w-5 text-ink-400" />
      <p className="mt-2 text-[13.5px] font-medium text-ink-800">No matching records found.</p>
      <dl className="mt-2 space-y-0.5 text-[12.5px] text-ink-500">
        <div>
          <dt className="inline">Period: </dt>
          <dd className="inline text-ink-700">{p.period.label}</dd>
        </div>
        {p.scope.map((s, i) => (
          <div key={i}>
            <dt className="inline">{s.label}: </dt>
            <dd className="inline break-words text-ink-700">{s.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const MoreRows = ({ more }) => {
  if (!more) return null;
  const text =
    more.total && more.total > more.shown
      ? `Showing ${more.shown} of ${more.total} rows returned.${more.truncated ? " More exist beyond the query limit." : ""}`
      : `Showing the first ${more.shown} results; more exist.`;
  return <p className="text-[11.5px] text-ink-500">{text}</p>;
};

export default function PresentationView({ presentation: p }) {
  if (p.kind === "empty") {
    return (
      <div className="space-y-2.5">
        {/* the card itself lists period and scope, so no header (it would repeat them) */}
        <Empty p={p} />
        <Footer p={{ ...p, basis: [] }} />
      </div>
    );
  }
  const derived = (p.columns || []).filter((c) => c.derived && c.hint).map((c) => `* ${c.label}: ${c.hint}.`);
  return (
    <div className="space-y-2.5">
      <Header p={p} />
      {p.kind === "kpi" && <MetricCard p={p} />}
      {p.kind === "comparison" && (
        <>
          <DataTable columns={p.columns} rows={p.rows} highlightCurrent />
          <ChangeCard changes={p.changes} primary={p.primary} />
          {p.chart && (
            <div className="rounded-xl border border-surface-border bg-white px-2 py-2">
              <ComparisonChart chart={p.chart} />
            </div>
          )}
        </>
      )}
      {(p.kind === "ranking" || p.kind === "trend") && p.chart && (
        <div className="rounded-xl border border-surface-border bg-white px-2 py-2">
          {p.kind === "trend" ? <TrendChart chart={p.chart} /> : <RankingChart chart={p.chart} />}
        </div>
      )}
      {(p.kind === "ranking" || p.kind === "trend" || p.kind === "table") && <DataTable columns={p.columns} rows={p.rows} totals={p.totals} />}
      {p.moreRows && <MoreRows more={p.moreRows} />}
      {p.truncated && <p className="text-[11.5px] text-ink-500">More rows exist beyond the query limit.</p>}
      <Footer p={p} extra={derived} />
    </div>
  );
}
