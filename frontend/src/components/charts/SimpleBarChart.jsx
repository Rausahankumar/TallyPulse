import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from "recharts";
import Card, { CardHeader } from "../ui/Card";

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-surface-border bg-white px-3 py-2 text-xs shadow-card-lg">
      <p className="font-medium text-ink-700">{label}</p>
      <p className="text-brand-600">₹{payload[0].value.toLocaleString("en-IN")}</p>
    </div>
  );
}

// data: [{ label, value, negative? }] — negative entries render in red
export default function SimpleBarChart({ title, subtitle, data, height = 220 }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid stroke="#eef1f8" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: "#98a2b3" }} axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 12, fill: "#98a2b3" }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v / 1000}k`} />
          <Tooltip content={<CustomTooltip />} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={36}>
            {data.map((d, i) => (
              <Cell key={i} fill={d.negative ? "#ef6a6a" : "#3269ea"} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
}
