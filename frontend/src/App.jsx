import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/auth/Login";
import Register from "./pages/auth/Register";
import ConnectCompany from "./pages/auth/ConnectCompany";
import ProtectedRoute from "./components/layout/ProtectedRoute";
import GuestRoute from "./components/layout/GuestRoute";
import AppLayout from "./components/layout/AppLayout";
import Dashboard from "./pages/Dashboard";
import SalesAnalytics from "./pages/SalesAnalytics";
import PurchaseAnalytics from "./pages/PurchaseAnalytics";
import ProductsAnalytics from "./pages/ProductsAnalytics";
import CustomersAnalytics from "./pages/CustomersAnalytics";
import Analytics from "./pages/Analytics";
import AskAI from "./pages/AskAI";
import SyncData from "./pages/SyncData";
import Reports from "./pages/Reports";
import Settings from "./pages/Settings";

export default function App() {
  return (
    <Routes>
      <Route element={<GuestRoute />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
      </Route>

      <Route path="/connect-company" element={<ConnectCompany />} />

      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sales" element={<SalesAnalytics />} />
          <Route path="/purchases" element={<PurchaseAnalytics />} />
          <Route path="/products" element={<ProductsAnalytics />} />
          <Route path="/customers" element={<CustomersAnalytics />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/ask-ai" element={<AskAI />} />
          <Route path="/sync" element={<SyncData />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
