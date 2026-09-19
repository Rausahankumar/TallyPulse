import { Sparkles } from "lucide-react";
import { ResponsiveContainer, LineChart, Line, XAxis, Tooltip } from "recharts";
import Badge from "../ui/Badge";

// A pre-canned assistant turn used ONLY to preview the intended chat
// UX while the real Claude integration is pending (see
// AiNotConnectedNotice). Always rendered with a visible "Demo
// response" badge so it can never be mistaken for a live answer.
export default function DemoInsightCard({ turn, onFollowUp }) {
  return (
    <div className="flex gap-2.5">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600">
        <Sparkles className="h-4 w-4 text-white" />
      </span>
      <div className="max-w-[80%] space-y-3">
        <div className="rounded-2xl bg-surface-alt px-4 py-3">
          <Badge tone="brand" className="mb-2">
            Demo response
          </Badge>
          <p className="text-[13.5px] leading-relaxed text-ink-800">{turn.answer}</p>
        </div>

        <div className="rounded-2xl border border-surface-border bg-white p-3">
          <p className="mb-1 text-[12px] font-medium text-ink-500">Sales Trend (Last 6 Months)</p>
          <ResponsiveContainer width="100%" height={110}>
            <LineChart data={turn.trend}>
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v) => `₹${v.toLocaleString("en-IN")}`} />
              <Line type="monotone" dataKey="value" stroke="#3269ea" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="flex flex-wrap gap-2">
          {turn.followUps.map((label) => (
            <button
              key={label}
              onClick={() => onFollowUp?.(label)}
              className="rounded-full border border-surface-border bg-white px-3 py-1.5 text-[12.5px] font-medium text-brand-600 hover:bg-brand-50"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
