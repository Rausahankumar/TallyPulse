import { cn } from "../../lib/cn";

// columns: [{ key, header, align?, render? }]
export default function Table({ columns, rows, rowKey = "id", dense = false }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-surface-border">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "whitespace-nowrap px-2 pb-2.5 text-[12px] font-medium uppercase tracking-wide text-ink-400 first:pl-0 last:pr-0",
                  col.align === "right" && "text-right"
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={row[rowKey] ?? idx}
              className="border-b border-surface-border/70 last:border-0 hover:bg-surface-alt/60"
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    dense ? "py-2" : "py-3",
                    "whitespace-nowrap px-2 text-[13.5px] text-ink-700 first:pl-0 last:pr-0",
                    col.align === "right" && "text-right"
                  )}
                >
                  {col.render ? col.render(row, idx) : row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
