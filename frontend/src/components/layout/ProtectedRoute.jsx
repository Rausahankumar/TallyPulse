import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";

export default function ProtectedRoute() {
  const { isAuthenticated, needsCompany } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Signed in but no company connected yet: nothing in the app works
  // without one, so go straight to "Connect Tally".
  if (needsCompany) {
    return <Navigate to="/connect-company" replace />;
  }

  return <Outlet />;
}
