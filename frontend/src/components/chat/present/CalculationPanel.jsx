import { useEffect, useRef } from "react";
import { X } from "lucide-react";

// "View calculation": shows the calculation record the backend saved with a single-query answer
// (backend calculation.js, visualization.calculation v1). Read-only and local: no request, no AI call, no
// recalculation - every figure is a number from the record, only formatted here (Indian grouping, 2 decimals).

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || "");
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : null;
};
const range = (p) => (p && p.from && p.to ? (p.from === p.to ? day(p.from) : `${day(p.from)} – ${day(p.to)}`) : null);
const money = (n) => `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plainNum = (n) => `${n < 0 ? "−" : ""}${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const pct = (n) => `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(1)}%`;

const OPS = { eq_ci: "is", in_ci: "is one of", contains_ci: "contains", new_in_period: "is new in this period" };
const RULES = { sum: "Sum", distinct: "Count of different names", count: "Count" };
const VALUE_REASONS = {
  no_matching_records: "No matching records were found, so there is nothing to calculate.",
  total_not_returned: "No overall total was returned for this answer (not the same as zero).",
  invoice_list_has_no_total: "This answer is a list of invoices; no total was calculated.",
};
const INCOMPLETE = {
  partly_outside_synced_data: "Part of the period is outside the data synced from Tally.",
  period_to_date: "The period is still running (to date).",
  period_ends_after_latest_voucher: "The period ends after the latest voucher in the data.",
};
const UNAVAILABLE = { source_records: "the source invoices", request_id: "a request reference", data_version: "the data version", record_count: "the number of records counted" };
const FRESH = { fresh: "Up to date", stale: "May be out of date", sync_failed: "Last sync failed", never_synced: "Never synced" };

function Section({ title, children }) {
  return (
    <section className="space-y-1.5 border-t border-surface-border pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-500">{title}</h3>
      <div className="space-y-1.5 text-[13px] leading-6 text-ink-800">{children}</div>
    </section>
  );
}
function Row({ label, value, strong }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-600">{label}</span>
      <span className={strong ? "font-semibold tabular-nums text-ink-900" : "tabular-nums"}>{value}</span>
    </div>
  );
}

function ruleText(m) {
  const r = m.rule;
  if (!r) return null;
  if (r.op === "ratio") return `${r.numerator.label} ÷ ${r.denominator.label}${r.whenDenominatorZero === 0 ? " (0 when there are none)" : ""}`;
  return `${RULES[r.op] || r.op} per ${r.per}`;
}

function MetricValues({ v, metric, compare, period }) {
  const isMoney = !!(metric && metric.basis);
  const fmt = (n) => (typeof n === "number" ? (isMoney ? money(n) : plainNum(n)) : "—");
  return (
    <div className="space-y-1 rounded-lg bg-surface-alt px-3 py-2">
      <p className="text-[12px] font-medium text-ink-700">{metric ? metric.label : v.metric}</p>
      {v.change ? <Row label={compare ? compare.label || range(compare) : "Previous period"} value={fmt(v.previous)} /> : null}
      <Row label={period ? period.label || range(period) : "This period"} value={fmt(v.current)} strong={!v.change} />
      {v.change && (
        <>
          <Row label={`Change = ${v.change.formula}`} value={fmt(v.change.value)} strong />
          {v.changePct && v.changePct.available === false ? (
            <p className="text-[12px] text-ink-600">% change: not defined, because the previous value is 0.</p>
          ) : v.changePct ? (
            <Row
              label={
                <>
                  % change = <span className="whitespace-nowrap">{fmt(v.changePct.inputs.change)}</span> ÷ <span className="whitespace-nowrap">|{fmt(v.changePct.inputs.previous)}|</span> × 100
                </>
              }
              value={pct(v.changePct.value)}
              strong
            />
          ) : null}
        </>
      )}
      {v.ratioInputs && v.ratioInputs.available === false && <p className="text-[12px] text-ink-600">Its inputs were not measured in this answer.</p>}
    </div>
  );
}

/** The record's sections; pure (no state), so it can be checked without a browser. */
export function CalculationView({ calculation: c }) {
  const metricById = Object.fromEntries((c.metrics || []).map((m) => [m.id, m]));
  const notes = [
    ...(c.rulesApplied || []).map((r) => r.text),
    ...(c.limitations || []).map((l) => l.text),
    ...((c.incomplete && c.incomplete.reasons) || []).map((r) => INCOMPLETE[r]).filter(Boolean),
  ];
  const fresh = c.data && c.data.freshness;
  return (
    <div className="space-y-4">
      <Section title="Data and period">
        {c.records && <p>{c.records}</p>}
        {c.period && <Row label="Period" value={[c.period.label, range(c.period)].filter(Boolean).join(" · ") || "All time"} />}
        {c.compare && <Row label="Compared with" value={[c.compare.label, range(c.compare)].filter(Boolean).join(" · ")} />}
      </Section>

      <Section title="Filters">
        {(c.filters || []).length ? (
          <ul className="space-y-1">
            {c.filters.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5">
                <span>
                  {f.label} {OPS[f.op] || f.op} {f.op === "new_in_period" ? "" : <strong className="font-medium">{[].concat(f.value).join(", ")}</strong>}
                </span>
                {f.origin === "same_as_previous" && <span className="rounded-full bg-brand-50 px-2 text-[11px] text-brand-700">Same as your previous question</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p>No filters: the whole company.</p>
        )}
      </Section>

      <Section title="What was measured">
        {(c.metrics || []).map((m) => (
          <div key={m.id}>
            <p className="font-medium text-ink-900">{m.label}</p>
            {ruleText(m) && <p className="text-[12.5px] text-ink-600">{ruleText(m)}</p>}
            {m.basis && <p className="text-[12.5px] text-ink-600">Basis: {m.basis.text}</p>}
          </div>
        ))}
      </Section>

      <Section title="Calculation">
        {Array.isArray(c.values) ? (
          c.values.map((v) => <MetricValues key={v.metric} v={v} metric={metricById[v.metric]} compare={c.compare} period={c.period} />)
        ) : (
          <p>{(c.values && VALUE_REASONS[c.values.reason]) || "No total is available for this answer."}</p>
        )}
        {c.rows && (
          <p className="text-[12.5px] text-ink-600">
            {c.rows.shown} {c.rows.shown === 1 ? "row" : "rows"} listed in the answer{c.rows.truncated ? ` (limit ${c.rows.rowLimit}; more exist)` : ""}.
            {c.rows.note ? ` ${c.rows.note}` : ""}
            {c.totalCovers && Array.isArray(c.values) ? " The total above covers all matching records." : ""}
          </p>
        )}
      </Section>

      <Section title="Data freshness and limits">
        {fresh && fresh.state && <Row label="Data" value={`${FRESH[fresh.state] || fresh.state}${fresh.dataAsOf ? ` · as of ${new Date(fresh.dataAsOf).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}` : ""}`} />}
        {c.data && c.data.latestVoucher && <Row label="Latest voucher" value={day(c.data.latestVoucher)} />}
        {notes.length > 0 && (
          <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-ink-700">
            {notes.map((n, i) => <li key={i}>{n}</li>)}
          </ul>
        )}
        {(c.interpretation || []).map((a, i) => (
          <p key={i} className="text-[12.5px] text-ink-600">Interpretation (AI-assisted): {a.text}</p>
        ))}
        {(c.unavailable || []).length > 0 && (
          <p className="text-[12px] text-ink-500">Not recorded for this answer: {c.unavailable.map((u) => UNAVAILABLE[u] || u).join(", ")}.</p>
        )}
      </Section>
    </div>
  );
}

/** A right-side panel over the page (full width on phones): Escape, the backdrop or ✕ closes it; focus moves in and back. */
export default function CalculationPanel({ calculation, open, onClose, returnFocusRef }) {
  const panelRef = useRef(null);
  const headingRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    headingRef.current?.focus();
    const back = returnFocusRef && returnFocusRef.current;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab" && panelRef.current) {
        // keep keyboard focus inside the open panel
        const items = [...panelRef.current.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])')];
        if (!items.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === headingRef.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      back?.focus();
    };
  }, [open, onClose, returnFocusRef]);
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calculation-panel-title"
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-white shadow-xl sm:max-w-md"
      >
        <div className="flex items-center gap-2 border-b border-surface-border px-4 py-3">
          <h2 id="calculation-panel-title" ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 text-[14px] font-semibold text-ink-900 outline-none">
            How this was calculated{calculation.entity ? ` · ${calculation.entity.label}` : ""}
          </h2>
          <button type="button" onClick={onClose} className="rounded-md p-1 text-ink-500 hover:bg-surface-alt" aria-label="Close calculation">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <CalculationView calculation={calculation} />
        </div>
      </div>
    </>
  );
}
