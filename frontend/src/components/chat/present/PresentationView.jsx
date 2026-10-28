import { SearchX } from "lucide-react";
import DataTable from "./DataTable";
import { DIRECTION } from "./direction";
import { RankingChart, TrendChart, ComparisonChart, PairedChart } from "./charts";
import { cn } from "../../../lib/cn";

// Renders the backend's presentation model (message.visualization, v1). Pure and local: no request, no AI
// call, no calculation - every number shown is a string the backend produced from the engine result.

// The plain-language opening (backend plainAnswer.js, in the question's language): the first line is the main result; a
// line ending in ":" introduces the lines after it. Every sentence and figure is the backend's own.
export function PlainSummary({ plain }) {
  return (
    <div className="space-y-1.5" lang={plain.language === "hi" ? "hi" : plain.language === "en" ? "en" : "hi-Latn"}>
      {plain.lines.map((line, i) =>
        i === 0 ? (
          <p key={i} className="text-[15px] font-semibold leading-7 text-ink-900">{line}</p>
        ) : /:$/.test(line) ? (
          <p key={i} className="pt-1 text-[13px] font-semibold text-ink-900">{line}</p>
        ) : (
          <p key={i} className="text-[14px] leading-6 text-ink-800">{line}</p>
        )
      )}
    </div>
  );
}
// a single-query view opens with its plain sentences when the backend sent them (an analysis step's view never has them)
const hasPlain = (p) => !!(p.plain && Array.isArray(p.plain.lines) && p.plain.lines.length);

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

// hideBasis: an analysis view states each accounting basis once for all its steps, so a step's own footer leaves it out.
function Footer({ p, extra = [], hideBasis = false }) {
  const lines = [...extra, ...(hideBasis ? [] : p.basis), ...p.notes];
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

// A folded section (closed by default): what the user did not ask to see first, one click away.
export function Fold({ label, children }) {
  return (
    <details className="group rounded-xl border border-surface-border bg-white">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-[12.5px] font-medium text-brand-600 [&::-webkit-details-marker]:hidden">
        <span className="transition-transform group-open:rotate-90">›</span>
        {label}
      </summary>
      <div className="border-t border-surface-border p-2">{children}</div>
    </details>
  );
}

const chartBox = (el) => <div className="rounded-xl border border-surface-border bg-white px-2 py-2">{el}</div>;

// A top group against all the others (kind "groups"): one caption line, the two-bar chart, the group table (totals, shares,
// counts), then the members of the top group folded. Every figure is the backend's own string, from one executed result.
function GroupsView({ p }) {
  return (
    <>
      <p className="text-[13.5px] leading-6 text-ink-800">{p.caption || p.summary}</p>
      {p.chart && chartBox(<ComparisonChart chart={p.chart} />)}
      <DataTable columns={p.columns} rows={p.rows} totals={p.totals} />
      {p.members && p.members.rows.length > 0 && (
        <Fold label={p.members.label}>
          <DataTable columns={p.members.columns} rows={p.members.rows} />
        </Fold>
      )}
    </>
  );
}

// display is the user's own "chart" / "table" request (read by the backend from the question): "chart" puts the chart first
// and folds the exact figures, "table" puts the table first and folds the chart, none keeps the default order. Without a
// chart nothing is folded: the table is shown and says why there is no chart. hideChange: the analysis view already shows
// this comparison's change as KPI cards above it.
export default function PresentationView({ presentation: p, display = p.display || null, hideChange = false, hideBasis = false }) {
  if (p.kind === "empty") {
    return (
      <div className="space-y-2.5">
        {hasPlain(p) && <PlainSummary plain={p.plain} />}
        {/* the card itself lists period and scope, so no header (it would repeat them) */}
        <Empty p={p} />
        <Footer p={{ ...p, basis: [] }} />
      </div>
    );
  }
  if (p.kind === "groups") {
    return (
      <div className="space-y-2.5">
        <Header p={p} />
        <GroupsView p={p} />
        <Footer p={p} hideBasis={hideBasis} />
      </div>
    );
  }
  if (p.kind === "paired") {
    // sales and purchases of the same products, aligned by name; a dash is a value not in that side's list, never a zero
    return (
      <div className="space-y-2.5">
        <Header p={p} />
        <p className="text-[12.5px] text-ink-600">{p.summary}</p>
        {p.chart && chartBox(<PairedChart chart={p.chart} />)}
        <DataTable columns={p.columns} rows={p.rows} />
        <Footer p={p} hideBasis={hideBasis} />
      </div>
    );
  }
  const derived = (p.columns || []).filter((c) => c.derived && c.hint).map((c) => `* ${c.label}: ${c.hint}.`);
  const tabular = ["comparison", "ranking", "trend", "table"].includes(p.kind);
  const CHARTS = { comparison: ComparisonChart, trend: TrendChart, ranking: RankingChart };
  const Chart = p.chart ? CHARTS[p.kind] : null;
  const chart = Chart ? chartBox(<Chart chart={p.chart} />) : null;
  const table = !tabular ? null : p.kind === "comparison" ? <DataTable columns={p.columns} rows={p.rows} highlightCurrent /> : <DataTable columns={p.columns} rows={p.rows} totals={p.totals} />;
  const changes = p.kind === "comparison" && !hideChange ? <ChangeCard changes={p.changes} primary={p.primary} /> : null;
  let body;
  if (display === "chart" && tabular && chart) {
    body = (
      <>
        {changes}
        {chart}
        <Fold label="Show exact figures">{table}</Fold>
      </>
    );
  } else if (display === "chart" && tabular) {
    body = (
      <>
        <p className="text-[12.5px] text-ink-500">There are too few values for a chart, so here are the exact figures.</p>
        {table}
        {changes}
      </>
    );
  } else if (display === "table" && tabular) {
    body = (
      <>
        {table}
        {changes}
        {chart && <Fold label="Show chart">{chart}</Fold>}
      </>
    );
  } else {
    body = p.kind === "comparison" ? <>{table}{changes}{chart}</> : <>{chart}{table}</>;
  }
  return (
    <div className="space-y-2.5">
      {hasPlain(p) && <PlainSummary plain={p.plain} />}
      <Header p={p} />
      {p.kind === "kpi" && <MetricCard p={p} />}
      {p.caption && <p className="text-[13px] leading-6 text-ink-800">{p.caption}</p>}
      {body}
      {p.moreRows && <MoreRows more={p.moreRows} />}
      {p.truncated && <p className="text-[11.5px] text-ink-500">More rows exist beyond the query limit.</p>}
      <Footer p={p} extra={derived} hideBasis={hideBasis} />
    </div>
  );
}
