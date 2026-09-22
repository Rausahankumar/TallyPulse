import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../../context/useAuth";

// Mirrors ProtectedRoute in the other direction: found by QA that
// typing /login or /register in the URL bar while already signed in
// rendered the auth form instead of the app, with no redirect.
export default function GuestRoute() {
  const { isAuthenticated, needsCompany } = useAuth();

  if (isAuthenticated) {
    return <Navigate to={needsCompany ? "/connect-company" : "/"} replace />;
  }

  return <Outlet />;
}
