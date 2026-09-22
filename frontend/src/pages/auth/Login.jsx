import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { LogIn, Mail, KeyRound, Info } from "lucide-react";
import AuthLayout from "./AuthLayout";
import Input from "../../components/ui/Input";
import Button from "../../components/ui/Button";
import { useAuth } from "../../context/useAuth";
import { ApiError } from "../../api/client";

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login({ email, password });
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h2 className="text-[22px] font-semibold text-ink-900">Welcome back</h2>
      <p className="mt-1 mb-6 text-sm text-ink-500">Sign in to your TallyPulse account</p>

      {notice && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[12.5px] text-brand-700">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-[12.5px] text-danger-600">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          label="Email"
          type="email"
          icon={Mail}
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <Input
          label="Password"
          type="password"
          icon={KeyRound}
          placeholder="••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <div className="flex items-center justify-between text-[13px]">
          <label className="flex items-center gap-2 text-ink-500">
            <input type="checkbox" defaultChecked className="h-3.5 w-3.5 rounded border-surface-border accent-[#2457d8]" />
            Remember me
          </label>
          <button
            type="button"
            onClick={() => setNotice("Contact your TallyPulse administrator to reset your password.")}
            className="font-medium text-brand-600 hover:underline"
          >
            Forgot password?
          </button>
        </div>

        <Button type="submit" className="w-full" icon={LogIn} loading={loading}>
          Sign In
        </Button>
      </form>

      <div className="my-5 flex items-center gap-3 text-[12px] text-ink-400">
        <span className="h-px flex-1 bg-surface-border" />
        or continue with
        <span className="h-px flex-1 bg-surface-border" />
      </div>

      <Button
        variant="secondary"
        className="w-full"
        onClick={() => setNotice("Single sign-on isn't available yet.")}
      >
        Sign in with Microsoft
      </Button>

      <p className="mt-6 text-center text-[13px] text-ink-500">
        Don't have an account?{" "}
        <Link to="/register" className="font-medium text-brand-600 hover:underline">
          Create one
        </Link>
      </p>
    </AuthLayout>
  );
}
