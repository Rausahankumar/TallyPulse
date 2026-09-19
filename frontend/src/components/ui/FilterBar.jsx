import { useEffect, useRef, useState } from "react";
import { CalendarRange, RotateCcw } from "lucide-react";
import Select from "./Select";
import Button from "./Button";
import { formatRangeLabel, parseDateInputValue, toDateInputValue } from "../../lib/mockDateRange";

// A real, controlled date-range filter. It only has sample data to
// filter (see MockDataBanner on every page that uses this — no
// analytics API exists yet), but the control itself is fully
// functional: changing the dates or the financial year updates state,
// which the page re-derives its displayed figures from, and Reset
// restores the default range.
export default function FilterBar({ fy = "fy2025-26", onFyChange, range, onRangeChange, onReset }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(toDateInputValue(range.from));
  const [draftTo, setDraftTo] = useState(toDateInputValue(range.to));
  const ref = useRef(null);

  useEffect(() => {
    setDraftFrom(toDateInputValue(range.from));
    setDraftTo(toDateInputValue(range.to));
  }, [range]);

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function applyRange() {
    const from = parseDateInputValue(draftFrom);
    const to = parseDateInputValue(draftTo);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) return;
    onRangeChange({ from, to });
    setOpen(false);
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2.5">
      <Select value={fy} onChange={(e) => onFyChange?.(e.target.value)} className="!h-9 w-auto min-w-[110px]">
        <option value="fy2025-26">FY 2025-26</option>
        <option value="fy2024-25">FY 2024-25</option>
      </Select>

      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex h-9 items-center gap-2 rounded-lg border border-surface-border bg-white px-3 text-[13px] text-ink-600 hover:bg-surface-alt"
        >
          <CalendarRange className="h-3.5 w-3.5 text-ink-400" />
          {formatRangeLabel(range)}
        </button>

        {open && (
          <div className="absolute left-0 z-30 mt-2 w-72 rounded-xl border border-surface-border bg-white p-4 shadow-card-lg">
            <div className="space-y-3">
              <label className="block text-[12px] font-medium text-ink-700">
                From
                <input
                  type="date"
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-surface-border px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              </label>
              <label className="block text-[12px] font-medium text-ink-700">
                To
                <input
                  type="date"
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-surface-border px-2.5 text-[13px] focus:outline-none focus:ring-2 focus:ring-brand-200"
                />
              </label>
              <Button size="sm" className="w-full" onClick={applyRange}>
                Apply
              </Button>
            </div>
          </div>
        )}
      </div>

      <Button variant="secondary" size="sm" icon={RotateCcw} onClick={onReset}>
        Reset
      </Button>
    </div>
  );
}
