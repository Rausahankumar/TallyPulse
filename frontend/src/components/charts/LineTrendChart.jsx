import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import Card, { CardHeader } from "../ui/Card";

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-surface-border bg-white px-3 py-2 text-xs shadow-card-lg">
      <p className="mb-1 font-medium text-ink-700">{label}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} style={{ color: entry.color }}>
          {entry.name}: <span className="font-semibold">₹{entry.value.toLocaleString("en-IN")}</span>
        </p>
      ))}
    </div>
  );
}

// data: [{ label, value }] or with a second series via valueKey2
export default function LineTrendChart({ title, subtitle, data, valueKey = "value", seriesName = "Amount", height = 240 }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} />
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
          <CartesianGrid stroke="#eef1f8" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 12, fill: "#98a2b3" }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fontSize: 12, fill: "#98a2b3" }}
            axisLine={false}
            tickLine={false}
            tickFormatter={(v) => `${v / 1000}k`}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey={valueKey}
            name={seriesName}
            stroke="#3269ea"
            strokeWidth={2.5}
            dot={{ r: 3, fill: "#3269ea", strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
}
