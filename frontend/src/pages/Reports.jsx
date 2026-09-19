import { useState } from "react";
import { FileText, Info } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import Tabs from "../components/ui/Tabs";
import Card from "../components/ui/Card";
import Button from "../components/ui/Button";
import { MOCK_REPORTS } from "../mock/mockData";

const TABS = [
  { key: "standard", label: "Standard Reports" },
  { key: "custom", label: "Custom Reports" },
];

// No report-generation endpoint exists on the backend today, so
// "Generate" honestly says so per-row rather than faking a download.
export default function Reports() {
  const [tab, setTab] = useState("standard");
  const [pending, setPending] = useState(null);

  return (
    <div>
      <PageHeader title="Reports" subtitle="Generate and download business reports." />
      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "standard" ? (
        <Card padded={false}>
          <ul className="divide-y divide-surface-border">
            {MOCK_REPORTS.map((report) => (
              <li key={report.key} className="flex items-center gap-4 px-5 py-4">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50">
                  <FileText className="h-4.5 w-4.5 text-brand-600" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-ink-900">{report.name}</p>
                  <p className="text-[12.5px] text-ink-500">{report.description}</p>
                  {pending === report.key && (
                    <p className="mt-1 flex items-center gap-1 text-[12px] text-brand-600">
                      <Info className="h-3 w-3" /> Report generation isn't available yet — this
                      will call a backend reporting endpoint once it's built.
                    </p>
                  )}
                </div>
                <Button variant="secondary" size="sm" onClick={() => setPending(report.key)}>
                  {report.key === "stock" ? "Run Now" : "Generate"}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card>
          <p className="text-sm text-ink-500">
            Custom report building (choose your own fields, filters and grouping) isn't built yet —
            it needs the same reporting endpoint referenced above, generalized to caller-supplied
            filters.
          </p>
        </Card>
      )}
    </div>
  );
}
