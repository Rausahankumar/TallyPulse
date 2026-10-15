import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import Card, { CardHeader } from "../ui/Card";

function CustomTooltip({ active, payload, label, format }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-surface-border bg-white px-3 py-2 text-xs shadow-card-lg">
      <p className="mb-1 font-medium text-ink-700">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name}: <span className="font-semibold">{format === "number" ? "" : "₹"}{entry.value.toLocaleString("en-IN")}</span>
        </p>
      ))}
    </div>
  );
}

// data: [{ label, sales, purchases }]; valueFormat: "currency" (default: rupees, axis in k) or "number" (plain quantities)
export default function ComparisonBarChart({ title, subtitle, data, series, height = 240, valueFormat = "currency" }) {
  return (
    <Card>
      <CardHeader
        title={title}
        subtitle={subtitle}
        action={
          <div className="flex items-center gap-4 text-[12px] text-ink-500">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                {s.name}
              </span>
            ))}
          </div>
        }
      />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }} barGap={6}>
          <CartesianGrid stroke="#eef1f8" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
          <YAxis
            tick={{ fontSize: 12, fill: "#98a2b3" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={valueFormat === "number" ? undefined : (v) => `${v / 1000}k`}
          />
          <Tooltip content={<CustomTooltip format={valueFormat} />} />
          {series.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.name} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={22} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
