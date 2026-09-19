export function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `₹${Number(value).toLocaleString("en-IN")}`;
}

export function formatCompactCurrency(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (Math.abs(n) >= 100000) return `₹${(n / 100000).toFixed(2)}L`;
  if (Math.abs(n) >= 1000) return `₹${(n / 1000).toFixed(1)}k`;
  return `₹${n}`;
}

export function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("en-IN");
}

export function formatPercent(value, { withSign = false } = {}) {
  if (value === null || value === undefined) return "—";
  const sign = withSign && value > 0 ? "+" : "";
  return `${sign}${value}%`;
}
