import { useState } from "react";
import { cn } from "../../../lib/cn";

// Long tables open with the first rows and a "Show all" toggle; a list only a little longer than that is shown whole.
const COLLAPSED_ROWS = 10;
const COLLAPSE_FROM = 13;

// Exact-value table for a presentation model. Every cell is a string the backend already formatted (Indian
// grouping, currency, signs); nothing is re-computed or re-formatted here. Names wrap instead of truncating;
// numeric columns are right-aligned and never wrap; the wrapper scrolls horizontally on narrow screens.
export default function DataTable({ columns, rows, totals, highlightCurrent = false }) {
  const [expanded, setExpanded] = useState(false);
  const collapsible = rows.length >= COLLAPSE_FROM;
  const visibleRows = collapsible && !expanded ? rows.slice(0, COLLAPSED_ROWS) : rows;
  const head = "px-2 py-2 sm:px-3 text-[11.5px] font-medium uppercase tracking-wide text-ink-500";
  return (
    <div className="space-y-1.5">
      <div className="overflow-x-auto rounded-lg border border-surface-border bg-white">
        <table className="w-full border-collapse text-[13px]">
          <thead className="bg-surface-alt">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  title={c.hint || undefined}
                  className={cn(head, c.align === "right" ? "text-right whitespace-nowrap" : "text-left", c.narrow && "w-8")}
                >
                  {c.label}
                  {c.derived ? " *" : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => (
              <tr key={i} className={cn("border-t border-surface-border align-top", highlightCurrent && r.current && "bg-brand-50 font-semibold")}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-2 py-2 text-ink-800 sm:px-3",
                      c.align === "right" ? "whitespace-nowrap text-right tabular-nums" : "min-w-[8rem] break-words text-left",
                      c.key === "rank" && "text-ink-500"
                    )}
                  >
                    {r.cells[c.key] ?? "—"}
                    {c.key === "name" && r.flag && <span className="mt-0.5 block text-[11.5px] font-normal text-ink-500">{r.flag}</span>}
                    {c.key === "period" && r.range && <span className="mt-0.5 block text-[11.5px] font-normal text-ink-500">{r.range}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {totals && (
            <tfoot>
              <tr className="border-t-2 border-surface-border bg-surface-alt font-semibold">
                {columns.map((c) => (
                  <td key={c.key} className={cn("px-2 py-2 text-ink-900 sm:px-3", c.align === "right" ? "whitespace-nowrap text-right tabular-nums" : "text-left")}>
                    {totals.cells[c.key] ?? ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className="text-[12.5px] font-medium text-brand-600 hover:underline"
        >
          {expanded ? "Show fewer rows" : `Show all ${rows.length} rows`}
        </button>
      )}
    </div>
  );
}
