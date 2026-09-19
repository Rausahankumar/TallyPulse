import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from "recharts";
import Card, { CardHeader } from "../ui/Card";

const COLORS = ["#3269ea", "#22b07d", "#f5a35c", "#8b7bf0", "#ef6a6a", "#2fb6c4"];

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-surface-border bg-white px-3 py-2 text-xs shadow-card-lg">
      <p className="font-medium text-ink-700">{p.name}</p>
      <p style={{ color: p.payload.fill }}>₹{p.value.toLocaleString("en-IN")}</p>
    </div>
  );
}

// data: [{ name, value }], centerLabel/centerValue shown in the donut hole
export default function DonutChart({ title, subtitle, data, centerLabel, centerValue, height = 240 }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <div className="relative">
        <ResponsiveContainer width="100%" height={height}>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="90%"
              paddingAngle={2}
              stroke="none"
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
          </PieChart>
        </ResponsiveContainer>
        {centerValue && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-lg font-semibold text-ink-900">{centerValue}</span>
            <span className="text-[12px] text-ink-500">{centerLabel}</span>
          </div>
        )}
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-y-1.5 gap-x-3">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
            <span className="h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />
            <span className="truncate">{d.name}</span>
            <span className="ml-auto shrink-0 text-ink-400">
              {Math.round((d.value / data.reduce((s, x) => s + x.value, 0)) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
