import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ArrowRight, ArrowLeft, User, Mail, KeyRound, Building2, Fingerprint } from "lucide-react";
import AuthLayout from "./AuthLayout";
import Input from "../../components/ui/Input";
import Button from "../../components/ui/Button";
import { useAuth } from "../../context/AuthContext";
import { ApiError } from "../../api/client";

// Two visual steps ("create your account" -> "connect your first
// company") that submit together in one call to the backend's single
// POST /api/auth/register, which genuinely creates the Company and
// User atomically (docs §7.2) — there is no separate "add company"
// endpoint to call in between.
export default function Register() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
    companyName: "",
    companyGuId: "",
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function goToStep2(e) {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setStep(2);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await register(form);
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <div className="mb-6 flex items-center gap-2">
        <StepDot active={step === 1} done={step > 1} label="1" />
        <span className="h-px flex-1 bg-surface-border" />
        <StepDot active={step === 2} done={false} label="2" />
      </div>

      {step === 1 ? (
        <>
          <h2 className="text-[22px] font-semibold text-ink-900">Create your account</h2>
          <p className="mt-1 mb-6 text-sm text-ink-500">Step 1 of 2 — your TallyPulse login</p>

          {error && (
            <div className="mb-4 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-[12.5px] text-danger-600">
              {error}
            </div>
          )}

          <form onSubmit={goToStep2} className="space-y-4">
            <Input label="Full name" icon={User} value={form.name} onChange={update("name")} required />
            <Input
              label="Email"
              type="email"
              icon={Mail}
              value={form.email}
              onChange={update("email")}
              required
            />
            <Input
              label="Password"
              type="password"
              icon={KeyRound}
              value={form.password}
              onChange={update("password")}
              required
            />
            <Input
              label="Confirm password"
              type="password"
              icon={KeyRound}
              value={form.confirmPassword}
              onChange={update("confirmPassword")}
              required
            />
            <Button type="submit" className="w-full" icon={ArrowRight}>
              Continue
            </Button>
          </form>
        </>
      ) : (
        <>
          <h2 className="text-[22px] font-semibold text-ink-900">Connect your first company</h2>
          <p className="mt-1 mb-6 text-sm text-ink-500">Step 2 of 2 — link your TallyPrime company</p>

          {error && (
            <div className="mb-4 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-[12.5px] text-danger-600">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              label="Company name"
              icon={Building2}
              value={form.companyName}
              onChange={update("companyName")}
              required
            />
            <Input
              label="Company GUID"
              icon={Fingerprint}
              hint="Found in TallyPrime under Company Info."
              value={form.companyGuId}
              onChange={update("companyGuId")}
              required
            />
            <div className="flex gap-3">
              <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => setStep(1)}>
                Back
              </Button>
              <Button type="submit" className="flex-1" loading={loading}>
                Create account
              </Button>
            </div>
          </form>
        </>
      )}

      <p className="mt-6 text-center text-[13px] text-ink-500">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}

function StepDot({ active, done, label }) {
  return (
    <span
      className={
        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold " +
        (active
          ? "bg-brand-600 text-white"
          : done
            ? "bg-success-50 text-success-600"
            : "bg-surface-alt text-ink-400")
      }
    >
      {label}
    </span>
  );
}
