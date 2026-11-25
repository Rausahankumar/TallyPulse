import { AlertTriangle, ArrowRight, ListChecks, Search } from "lucide-react";
import PresentationView, { Fold, PlainSummary } from "./PresentationView";
import { DIRECTION } from "./direction";
import DataTable from "./DataTable";
import MarkdownMessage from "../MarkdownMessage";
import { cn } from "../../../lib/cn";

// Renders the backend's analysis presentation (message.visualization, kind "analysis"): headline, the visuals, KPI cards,
// labelled findings, what is not established, suggested next actions, then Details (interpretation, every step). Pure and
// local like PresentationView: every number and sentence is the backend's own (step results and the evidence record);
// nothing is calculated or reworded here. Each step's chart/table is the single-query view of that step.

const stepRef = (steps) => (steps && steps.length ? `${steps.length > 1 ? "steps" : "step"} ${steps.join(", ")}` : null);

function StepRef({ steps }) {
  const ref = stepRef(steps);
  if (!ref) return null;
  return <span className="ml-1.5 whitespace-nowrap rounded-full bg-surface-alt px-1.5 py-0.5 align-middle text-[11px] font-medium text-ink-500">{ref}</span>;
}

function KpiCards({ kpis }) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {kpis.cards.map((c) => {
          const d = c.direction ? DIRECTION[c.direction] : null;
          return (
            <div key={c.id} className="min-w-0 rounded-xl border border-surface-border bg-white px-3 py-2.5">
              <p className="truncate text-[11.5px] font-medium text-ink-500" title={c.label}>
                {c.label}
              </p>
              <p className={cn("mt-1 flex items-center gap-1 break-words text-[17px] font-semibold leading-tight tabular-nums", d ? (c.direction === "down" ? "text-danger-600" : c.direction === "up" ? "text-success-600" : "text-ink-700") : "text-ink-900")}>
                {d && <d.icon className="h-4 w-4 shrink-0" />}
                {c.display}
              </p>
            </div>
          );
        })}
      </div>
      {/* the cards' step is named in Details; their basis is listed once with the others */}
    </div>
  );
}

function FindingList({ title, icon: Icon, items, tone = "default", note }) {
  if (!items.length) return null;
  return (
    <section className={cn("rounded-xl border px-4 py-3", tone === "caution" ? "border-warning-600/30 bg-warning-50" : "border-surface-border bg-white")}>
      <h4 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
        <Icon className={cn("h-4 w-4", tone === "caution" ? "text-warning-600" : "text-brand-600")} />
        {title}
      </h4>
      {note && <p className="mt-0.5 text-[12px] text-ink-500">{note}</p>}
      <ul className="mt-2 space-y-1.5 text-[13.5px] leading-6 text-ink-800">
        {items.map((f, i) => (
          <li key={i} className="flex gap-2">
            <span className="mt-2.5 h-1 w-1 shrink-0 rounded-full bg-ink-400" />
            <span className="min-w-0">
              {f.label && <span className="font-medium text-ink-900">{f.label}: </span>}
              {f.text}
              {f.because && <span className="mt-0.5 block text-[12px] leading-5 text-ink-500">Because: {f.because}</span>}
              <StepRef steps={f.steps} />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function InsightStep({ insight }) {
  return (
    <div className="space-y-2">
      <p className="text-[13px] font-semibold text-ink-900">
        {insight.title}
        {insight.period && <span className="font-medium text-ink-500"> · {insight.period}</span>}
        {insight.product && <span className="font-medium text-ink-500"> · {insight.product}</span>}
      </p>
      {insight.summary && <p className="text-[13px] text-ink-800">{insight.summary}</p>}
      {insight.rows.length > 0 ? (
        <DataTable columns={insight.columns} rows={insight.rows} />
      ) : (
        !insight.summary && <p className="text-[12.5px] text-ink-500">No matching records in this period.</p>
      )}
      {insight.notes.length > 0 && (
        <ul className="space-y-0.5 text-[11.5px] leading-snug text-ink-500">
          {insight.notes.map((n, i) => (
            <li key={i}>• {n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const DETAILS_LABEL = { en: "Details: interpretation and each step", hinglish: "Details: poori jaankari aur har step", hi: "Details: पूरी जानकारी और हर चरण" };


function StepBody({ step, display, hideChange }) {
  if (step.kind === "not_run") return <p className="text-[12.5px] text-ink-500">Not run: {step.message}</p>;
  if (step.kind === "insight") return <InsightStep insight={step.insight} />;
  // the basis is stated once for the whole analysis (below), not under every step
  return step.view ? <PresentationView presentation={step.view} display={display} hideChange={hideChange} hideBasis /> : <MarkdownMessage text={step.facts} />;
}

// Default view: the visuals first (a sales/purchases pair, else the featured step; then any other part of a multi-part
// question), the KPI cards, then only the findings the visuals do not already show, and every accounting basis once.
// Interpretation lines, numbered steps, step references, the label legend and findings the KPI cards repeat are in Details.
export default function AnalysisView({ presentation: p }) {
  const pairs = p.pairs || [];
  const featured = p.steps.find((s) => s.n === p.featuredStep) || null;
  const kpiStep = p.kpis ? p.kpis.step : null;
  // the measured change of the KPI step is what the cards show: not repeated as a sentence
  const onCards = (f) => p.kpis && f.steps.length > 0 && f.steps.every((n) => n === kpiStep);
  const measured = [...p.findings.measured.filter((f) => !onCards(f)).map((f) => ({ ...f, label: p.findingLabels.measured })), ...p.findings.contributors.map((f) => ({ ...f, label: p.findingLabels.contributor }))];
  const repeated = p.findings.measured.filter(onCards);
  // the other parts of a multi-part question (e.g. sales by customer next to a product pair) are answers too: shown open
  const others = pairs.length ? p.steps.filter((s) => !s.paired && s.kind !== "not_run" && (s.insight || (s.view && s.view.kind !== "empty"))) : [];
  const notRun = p.steps.filter((s) => s.kind === "not_run");
  const shownAbove = (s) => s.kind !== "not_run" && (s.n === p.featuredStep || !!s.paired || others.includes(s));
  const plain = (items) => items.map(({ steps: _steps, ...f }) => f); // no step badges outside Details
  // the technical findings: shown open for older answers; behind Details when the answer has its plain-language opening
  const technical = (
    <>
      {p.headline && <p className="text-[15px] font-semibold leading-7 text-ink-900">{p.headline.text}</p>}
      {/* the overall result differs from what the steps looked for (e.g. a "decline" question while the total rose) */}
      {p.headline && p.headline.note && <p className="rounded-lg border border-warning-600/30 bg-warning-50 px-3 py-2 text-[13px] leading-6 text-ink-800">{p.headline.note}</p>}
      <FindingList title="What the data shows" icon={ListChecks} items={plain(measured)} />
      <FindingList title={p.findingLabels.possibleCause.replace(/^Possible cause/, "Possible causes")} icon={AlertTriangle} tone="caution" items={plain(p.findings.possibleCauses)} note="Consistent with the data, not proven." />
      <FindingList title="Not established by this data" icon={Search} items={plain(p.gaps)} />
      {/* prioritized (largest amount first): rank, how far it goes (action / check / possible option) and the finding behind it */}
      <FindingList title="Suggested next actions" icon={ArrowRight} items={p.recommendations.map((r, i) => ({ label: `${i + 1}. ${r.kindLabel || "Check"}`, text: r.text, because: r.because }))} note="Largest amount first. None follows from a confirmed cause." />
      {p.noAction && <FindingList title="Suggested next actions" icon={ArrowRight} items={[{ text: p.noAction }]} />}
    </>
  );
  return (
    <div className="space-y-4">
      {p.plain ? <PlainSummary plain={p.plain} /> : null}
      {!p.plain && p.headline && <p className="text-[15px] font-semibold leading-7 text-ink-900">{p.headline.text}</p>}
      {!p.plain && p.headline && p.headline.note && <p className="rounded-lg border border-warning-600/30 bg-warning-50 px-3 py-2 text-[13px] leading-6 text-ink-800">{p.headline.note}</p>}

      {p.unavailable && (
        <div className="rounded-xl border border-surface-border bg-surface-alt/60 px-3 py-2 text-[12.5px] text-ink-700">
          <MarkdownMessage text={p.unavailable} />
        </div>
      )}

      {pairs.map((pair, i) => (
        <PresentationView key={`pair-${i}`} presentation={pair} hideBasis />
      ))}
      {featured && <StepBody step={featured} display={p.display} hideChange={featured.n === kpiStep} />}
      {others.map((s) => (
        <StepBody key={s.n} step={s} display={p.display} />
      ))}
      {p.pairNote && <p className="text-[12px] text-ink-500">{p.pairNote}</p>}

      {p.kpis && <KpiCards kpis={p.kpis} />}

      {notRun.length > 0 && (
        <ul className="space-y-0.5 text-[12.5px] text-warning-600">
          {notRun.map((s) => (
            <li key={s.n}>⚠ Not run: {s.message}</li>
          ))}
        </ul>
      )}

      {!p.plain && technical}

      {p.basis.length > 0 && (
        <ul className="space-y-0.5 text-[11.5px] leading-snug text-ink-500">
          {p.basis.map((b, i) => (
            <li key={i}>• {b}</li>
          ))}
        </ul>
      )}

      <Fold label={DETAILS_LABEL[(p.plain && p.plain.language) || "en"] || DETAILS_LABEL.en}>
        <div className="space-y-3">
          {p.plain && technical}
          {p.assumptions.length > 0 && (
            <div className="space-y-1 text-[12.5px] text-ink-700">
              {[...new Set(p.assumptions)].map((a, i) => (
                <p key={i}>{a}</p>
              ))}
            </div>
          )}
          {repeated.length > 0 && <FindingList title="Measured (shown as the cards above)" icon={ListChecks} items={repeated} />}
          {p.steps.map((s) => (
            <div key={s.n} className="space-y-1.5 border-b border-surface-border pb-3 last:border-0 last:pb-0">
              <p className="text-[12.5px] font-semibold text-ink-700">
                Step {s.n}
                {s.kind !== "not_run" && <span className="font-normal text-ink-500"> · {s.title}</span>}
                {s.origin && <span className="font-normal text-ink-500"> · follow-up: {s.origin}</span>}
              </p>
              {shownAbove(s) ? <p className="text-[12px] text-ink-500">Shown above.</p> : <StepBody step={s} hideChange={s.n === kpiStep} />}
            </div>
          ))}
          {p.labelNote && <p className="text-[11.5px] text-ink-500">{p.labelNote}</p>}
        </div>
      </Fold>
    </div>
  );
}
