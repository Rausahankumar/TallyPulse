import { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { Plug, LogOut } from "lucide-react";
import AuthLayout from "./AuthLayout";
import Button from "../../components/ui/Button";
import { useAuth } from "../../context/useAuth";
import { ApiError } from "../../api/client";

// "Connect Tally": the last onboarding step. The user opens their company
// in TallyPrime and clicks one button - the backend detects which company
// is open and connects it. Nothing about the company is typed here.
export default function ConnectCompany() {
  const navigate = useNavigate();
  const { isAuthenticated, needsCompany, connectCompany, logout } = useAuth();

  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [connected, setConnected] = useState(null);

  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!needsCompany && !connected) return <Navigate to="/" replace />;

  async function handleConnect() {
    setError(null);
    setLoading(true);
    try {
      const company = await connectCompany();
      setConnected(company);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not connect TallyPrime.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h2 className="text-[22px] font-semibold text-ink-900">Connect TallyPrime</h2>
      <p className="mt-1 mb-6 text-sm text-ink-500">
        Open your company in TallyPrime before connecting. TallyPulse detects it automatically.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-[12.5px] text-danger-600">
          {error}
        </div>
      )}

      {connected && (
        <div className="mb-4 rounded-lg border border-success-50 bg-success-50 px-3 py-2 text-[12.5px] text-success-600">
          Connected company: {connected.companyName}
        </div>
      )}

      <Button className="w-full" icon={Plug} loading={loading} onClick={handleConnect}>
        Connect Tally
      </Button>

      <button
        type="button"
        onClick={logout}
        className="mt-6 flex w-full items-center justify-center gap-1.5 text-[13px] text-ink-500 hover:text-ink-700"
      >
        <LogOut className="h-3.5 w-3.5" />
        Sign out
      </button>
    </AuthLayout>
  );
}
