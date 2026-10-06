import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";

// Chart components for a presentation model. They plot ONLY the numeric values the backend put in
// `chart.points` and show the backend's own formatted string (`display`) in tooltips - nothing is derived,
// smoothed or invented. Axis ticks are compact (₹1.08L); the exact values are in the table beside the chart.
const BRAND = "#2457d8";
const MUTED = "#c3cbe0";
const AXIS = { fontSize: 11, fill: "#667085" };

// Axis ticks only (the exact values are in the table and tooltips): Indian short units, trailing zeros trimmed.
const trim = (n) => String(Number(n.toFixed(1)));
const compact = (n) => {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 10000000) return `${s}${trim(a / 10000000)}Cr`;
  if (a >= 100000) return `${s}${trim(a / 100000)}L`;
  if (a >= 1000) return `${s}${trim(a / 1000)}k`;
  return `${n}`;
};
const tick = (money) => (v) => (money ? `₹${compact(v)}` : compact(v));

function PointTooltip({ active, payload, metric }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="max-w-[16rem] rounded-lg border border-surface-border bg-white px-3 py-2 text-xs shadow-card-lg">
      <p className="mb-1 break-words font-medium text-ink-800">{p.label}</p>
      <p className="text-ink-700">
        {metric}: <span className="font-semibold text-ink-900">{p.display}</span>
      </p>
      {p.previousDisplay && (
        <p className="text-ink-500">
          Previous: <span className="font-medium">{p.previousDisplay}</span>
        </p>
      )}
    </div>
  );
}

const shorten = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function CategoryTick({ x, y, payload }) {
  const full = String(payload.value);
  return (
    <text x={x} y={y} dy={4} textAnchor="end" fontSize={11} fill="#344054">
      <title>{full}</title>
      {shorten(full, 24)}
    </text>
  );
}

/** Horizontal bars: long customer/product names stay readable (the full name is in the table and the tooltip). */
export function RankingChart({ chart }) {
  const hasPrev = chart.points.some((p) => p.previous !== undefined);
  const height = Math.max(150, chart.points.length * (hasPrev ? 46 : 34) + 24);
  return (
    <div role="img" aria-label={`${chart.metric} by ${chart.points.length} items`}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={chart.points} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke="#eef1f8" horizontal={false} />
          <XAxis type="number" tick={AXIS} axisLine={false} tickLine={false} tickFormatter={tick(chart.money)} />
          <YAxis type="category" dataKey="label" width={150} tick={<CategoryTick />} axisLine={false} tickLine={false} interval={0} />
          <Tooltip content={<PointTooltip metric={chart.metric} />} cursor={{ fill: "#f4f6fb" }} />
          {hasPrev && <Bar dataKey="previous" fill={MUTED} radius={[0, 4, 4, 0]} maxBarSize={14} isAnimationActive={false} />}
          <Bar dataKey="value" fill={BRAND} radius={[0, 4, 4, 0]} maxBarSize={hasPrev ? 14 : 20} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
      {chart.shownOf && <p className="mt-1 text-[11.5px] text-ink-500">Chart shows the top {chart.shownOf.shown} of {chart.shownOf.total}; the table lists every row returned.</p>}
    </div>
  );
}

/** One line of the actual monthly (or daily/weekly) values; x labels are the backend's own period labels. */
export function TrendChart({ chart }) {
  return (
    <div role="img" aria-label={`${chart.metric} trend over ${chart.points.length} periods`}>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chart.points} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="#eef1f8" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={12} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={56} tickFormatter={tick(chart.money)} />
          <Tooltip content={<PointTooltip metric={chart.metric} />} />
          <Line type="linear" dataKey="value" stroke={BRAND} strokeWidth={2.5} dot={{ r: 3.5, fill: BRAND, strokeWidth: 0 }} activeDot={{ r: 5 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Previous vs current: two bars, current period highlighted. */
export function ComparisonChart({ chart }) {
  return (
    <div role="img" aria-label={`${chart.metric}: ${chart.points.map((p) => `${p.label} ${p.display}`).join(" versus ")}`}>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={chart.points} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
          <CartesianGrid stroke="#eef1f8" vertical={false} />
          <XAxis dataKey="label" tick={AXIS} axisLine={false} tickLine={false} interval={0} />
          <YAxis tick={AXIS} axisLine={false} tickLine={false} width={56} tickFormatter={tick(chart.money)} />
          <Tooltip content={<PointTooltip metric={chart.metric} />} cursor={{ fill: "#f4f6fb" }} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
            {chart.points.map((p, i) => (
              <Cell key={i} fill={i === chart.points.length - 1 ? BRAND : MUTED} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
