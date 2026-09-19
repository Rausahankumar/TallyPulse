import {
  LayoutDashboard,
  ShoppingCart,
  ShoppingBag,
  Package,
  Users,
  BarChart3,
  Sparkles,
  RefreshCw,
  FileText,
  Settings,
} from "lucide-react";

export const NAV_ITEMS = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/sales", label: "Sales", icon: ShoppingCart },
  { to: "/purchases", label: "Purchases", icon: ShoppingBag },
  { to: "/products", label: "Products", icon: Package },
  { to: "/customers", label: "Customers", icon: Users },
  { to: "/analytics", label: "Analytics", icon: BarChart3 },
  { to: "/ask-ai", label: "Ask AI", icon: Sparkles, badge: "New" },
  { to: "/sync", label: "Sync & Data", icon: RefreshCw },
  { to: "/reports", label: "Reports", icon: FileText },
  { to: "/settings", label: "Settings", icon: Settings },
];
