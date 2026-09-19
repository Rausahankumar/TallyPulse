import { useState } from "react";
import { X, KeyRound } from "lucide-react";
import Input from "../ui/Input";
import Button from "../ui/Button";
import { useCompany } from "../../context/CompanyContext";
import { ApiError } from "../../api/client";

// "Connect another company": the SAME logged-in account, re-authorized with
// its EXISTING password - never a new email/account. The company itself is
// never typed: it is whichever company is open in TallyPrime right now, and
// the backend detects it.
export default function AddCompanyModal({ onClose, onConnected }) {
  const { connectCompany } = useCompany();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      // The connect call also switches the session to the connected company.
      const connected = await connectCompany({ password });
      onConnected?.(connected);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not connect this company.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-[420px] rounded-2xl bg-white p-6 shadow-card-lg">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold text-ink-900">Connect another company</h2>
          <button onClick={onClose} className="rounded-md p-1 text-ink-400 hover:bg-surface-alt">
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mb-3 text-[13px] text-ink-500">
          Uses your existing TallyPulse account — no new email required.
        </p>
        <p className="mb-5 text-[12.5px] text-ink-500">
          <strong className="text-ink-700">Before you continue:</strong> open the company you want
          to connect in TallyPrime. TallyPulse detects it automatically.
        </p>

        {error && (
          <div className="mb-4 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-[12.5px] text-danger-600">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            label="Your TallyPulse password"
            type="password"
            icon={KeyRound}
            hint="Confirms it's really you connecting this company."
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onClose} className="flex-1">
              Cancel
            </Button>
            <Button type="submit" loading={loading} className="flex-1">
              Connect company
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
