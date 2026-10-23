import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { User, Mail, KeyRound } from "lucide-react";
import AuthLayout from "./AuthLayout";
import Input from "../../components/ui/Input";
import Button from "../../components/ui/Button";
import { useAuth } from "../../context/useAuth";
import { ApiError } from "../../api/client";

// Just an account: name, email, password. Registering signs the user in and
// the app then sends them to "Connect Tally", where their TallyPrime company
// is detected automatically - no company name, ID or GUID is ever typed.
export default function Register() {
  const navigate = useNavigate();
  const { register } = useAuth();

  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  function update(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (form.password !== form.confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await register({ name: form.name, email: form.email, password: form.password });
      navigate("/connect-company", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Registration failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout>
      <h2 className="text-[22px] font-semibold text-ink-900">Create your account</h2>
      <p className="mt-1 mb-6 text-sm text-ink-500">
        Next you'll connect your TallyPrime company — have it open in TallyPrime.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-[12.5px] text-danger-600">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
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
        <Button type="submit" className="w-full" loading={loading}>
          Create account
        </Button>
      </form>

      <p className="mt-6 text-center text-[13px] text-ink-500">
        Already have an account?{" "}
        <Link to="/login" className="font-medium text-brand-600 hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
