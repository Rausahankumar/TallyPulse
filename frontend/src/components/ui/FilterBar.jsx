import { useEffect, useRef, useState } from "react";
import { CalendarRange, RotateCcw } from "lucide-react";
import Button from "./Button";
import DateInput from "./DateInput";
import { formatRangeLabel } from "../../lib/dateRange";

// A controlled date-range filter: changing the dates updates state, which
// the page re-derives its displayed figures from, and Reset restores the
// default range.
export default function FilterBar({ range, onRangeChange, onReset }) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(range.from);
  const [draftTo, setDraftTo] = useState(range.to);
  // Resets the draft inputs whenever the parent's range changes (e.g.
  // Reset button, financial-year switch) - adjusted during render rather
  // than in an effect, so a range change and the draft reset land in the
  // same commit instead of a stale draft flashing for one extra render.
  const [prevRange, setPrevRange] = useState(range);
  if (range !== prevRange) {
    setPrevRange(range);
    setDraftFrom(range.from);
    setDraftTo(range.to);
  }
  const ref = useRef(null);

  useEffect(() => {
    function onClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  function applyRange() {
    if (draftFrom > draftTo) return;
    onRangeChange({ from: draftFrom, to: draftTo });
    setOpen(false);
  }

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2.5">
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
                <DateInput value={draftFrom} onChange={setDraftFrom} className="mt-1" />
              </label>
              <label className="block text-[12px] font-medium text-ink-700">
                To
                <DateInput value={draftTo} onChange={setDraftTo} className="mt-1" />
              </label>
              <p className="text-[11px] text-ink-400">Type a date like "1-May-2025", or use the calendar icon.</p>
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
