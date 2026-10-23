import { useState } from "react";
import { Building2, User, Bell, PlugZap, Info, Plus, Check } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import Card, { CardHeader } from "../components/ui/Card";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";
import Badge from "../components/ui/Badge";
import { useAuth } from "../context/useAuth";
import { useCompany } from "../context/useCompany";
import { useTallyConnectionTest } from "../lib/useTallyConnectionTest";
import { renameActiveCompany } from "../api/auth";
import { ApiError } from "../api/client";
import AddCompanyModal from "../components/company/AddCompanyModal";

const TABS = [
  { key: "company", label: "Company", icon: Building2 },
  { key: "profile", label: "Profile", icon: User },
  { key: "preferences", label: "Preferences", icon: Bell },
  { key: "tally", label: "Tally Connection", icon: PlugZap },
];

export default function Settings() {
  const [tab, setTab] = useState("company");

  return (
    <div>
      <PageHeader title="Settings" subtitle="Manage your account and application settings." />

      <div className="flex flex-col gap-5 lg:flex-row">
        <nav className="flex gap-1 overflow-x-auto lg:w-56 lg:flex-col">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={
                "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13.5px] font-medium " +
                (tab === t.key ? "bg-brand-50 text-brand-700" : "text-ink-600 hover:bg-surface-alt")
              }
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </nav>

        <div className="min-w-0 flex-1 space-y-4">
          {tab === "company" && <CompanyTab />}
          {tab === "profile" && <ProfileTab />}
          {tab === "preferences" && <PreferencesTab />}
          {tab === "tally" && <TallyTab />}
        </div>
      </div>
    </div>
  );
}

function CompanyTab() {
  const { activeCompany, companies, switchCompany, refreshCompanies } = useCompany();
  const [companyName, setCompanyName] = useState("");
  const [savedNote, setSavedNote] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Keep the editable field in sync once the real name has loaded.
  if (!companyName && activeCompany?.companyName && activeCompany.companyName !== "Loading…") {
    setCompanyName(activeCompany.companyName);
  }

  async function handleSave(e) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await renameActiveCompany(companyName);
      await refreshCompanies();
      setSavedNote("Saved.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader title="Company Information" subtitle="Basic details about your active company." />
        <form onSubmit={handleSave} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Company Name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
          <Input label="Status" value="Active" disabled />
          <div className="sm:col-span-2">
            {error && <p className="mb-3 text-[12.5px] text-danger-600">{error}</p>}
            {savedNote && !error && (
              <p className="mb-3 flex items-center gap-1.5 text-[12.5px] text-success-600">
                <Check className="h-3.5 w-3.5" /> {savedNote}
              </p>
            )}
            <Button type="submit" loading={saving}>
              Update Company
            </Button>
          </div>
        </form>
      </Card>

      <Card>
        <CardHeader
          title="Your companies"
          subtitle="Every company connected to this account."
          action={
            <Button variant="secondary" size="sm" icon={Plus} onClick={() => setShowAddModal(true)}>
              Connect another company
            </Button>
          }
        />
        <ul className="divide-y divide-surface-border">
          {companies.map((c) => {
            const isActive = c.companyGuid === activeCompany?.companyGuid;
            return (
              <li key={c.companyGuid} className="flex items-center gap-3 py-3">
                <span
                  className={
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[12px] font-semibold " +
                    (isActive ? "bg-brand-600 text-white" : "bg-surface-alt text-ink-500")
                  }
                >
                  {(c.companyName || "?").slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-medium text-ink-900">{c.companyName}</p>
                </div>
                {isActive ? (
                  <Badge tone="brand">Active</Badge>
                ) : (
                  <Button variant="secondary" size="sm" onClick={() => switchCompany(c.companyGuid)}>
                    Switch
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {showAddModal && <AddCompanyModal onClose={() => setShowAddModal(false)} />}
    </>
  );
}

function ProfileTab() {
  const { session } = useAuth();
  return (
    <Card>
      <CardHeader title="Profile" subtitle="Your TallyPulse account." />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input label="User ID" value={session?.userId || ""} disabled />
        <Input label="Role" value={session?.role || "user"} disabled />
      </div>
      <p className="mt-4 flex items-start gap-1.5 text-[12.5px] text-ink-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Name and email aren't shown here because the backend has no "get current user" endpoint
        yet — only the ID and role travel in the JWT issued at login.
      </p>
    </Card>
  );
}

function PreferencesTab() {
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [syncAlerts, setSyncAlerts] = useState(true);

  return (
    <Card>
      <CardHeader title="Preferences" subtitle="These are stored locally in this browser only." />
      <div className="space-y-4">
        <Toggle label="Email alerts for sync failures" checked={emailAlerts} onChange={setEmailAlerts} />
        <Toggle label="Notify me on data reconciliation" checked={syncAlerts} onChange={setSyncAlerts} />
      </div>
    </Card>
  );
}

function TallyTab() {
  const { activeCompany } = useCompany();
  const { status, detail, run } = useTallyConnectionTest(activeCompany?.companyName);
  return (
    <Card>
      <CardHeader title="Tally Connection" subtitle="Test connectivity to your TallyPrime instance." />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" icon={PlugZap} loading={status === "checking"} onClick={run}>
          Test Connection
        </Button>
        {status === "ok" && <Badge tone="success" dot>Connected</Badge>}
        {status === "mismatch" && <Badge tone="warning" dot>Wrong company</Badge>}
        {status === "ambiguous" && <Badge tone="warning" dot>Multiple companies open</Badge>}
        {status === "no_company" && <Badge tone="warning" dot>No company data</Badge>}
        {status === "error" && <Badge tone="danger" dot>Unreachable</Badge>}
        {detail && <span className="text-[13px] text-ink-500">{detail}</span>}
      </div>
      <p className="mt-4 text-[12.5px] text-ink-500">
        TallyPulse currently connects to one TallyPrime instance via its HTTP/JSONEx gateway,
        configured server-side with <code className="rounded bg-surface-alt px-1 py-0.5">TALLY_URL</code>.
        This check compares the company name Tally reports with the one connected here.
      </p>
    </Card>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center justify-between">
      <span className="text-[13.5px] text-ink-700">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`h-6 w-11 rounded-full transition-colors ${checked ? "bg-brand-600" : "bg-surface-border"}`}
      >
        <span
          className={`block h-5 w-5 translate-y-0.5 rounded-full bg-white shadow transition-transform ${
            checked ? "translate-x-5" : "translate-x-0.5"
          }`}
        />
      </button>
    </label>
  );
}
