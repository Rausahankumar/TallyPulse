import { Link } from "react-router-dom";
import { ShoppingCart, ShoppingBag, Package, Users, ArrowRight } from "lucide-react";
import PageHeader from "../components/ui/PageHeader";
import MockDataBanner from "../components/ui/MockDataBanner";
import Card from "../components/ui/Card";

// The sidebar's generic "Analytics" entry is a hub into the four
// focused analytics screens rather than a fifth copy of the same
// charts — keeps navigation consistent without duplicating components.
const SECTIONS = [
  { to: "/sales", label: "Sales Analytics", desc: "Revenue, invoices and sales trends", icon: ShoppingCart },
  { to: "/purchases", label: "Purchase Analytics", desc: "Procurement and supplier performance", icon: ShoppingBag },
  { to: "/products", label: "Products Analytics", desc: "Top, growing and declining products", icon: Package },
  { to: "/customers", label: "Customers Analytics", desc: "Customer value and distribution", icon: Users },
];

export default function Analytics() {
  return (
    <div>
      <PageHeader title="Analytics" subtitle="A quick jump-off point into every analytics view." />
      <MockDataBanner label="All linked screens use sample data" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {SECTIONS.map((s) => (
          <Link key={s.to} to={s.to} className="group block">
            <Card className="flex items-center gap-4 transition-shadow hover:shadow-card-lg">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-50">
                <s.icon className="h-5 w-5 text-brand-600" />
              </span>
              <div className="flex-1">
                <p className="text-[14.5px] font-semibold text-ink-900">{s.label}</p>
                <p className="mt-0.5 text-[13px] text-ink-500">{s.desc}</p>
              </div>
              <ArrowRight className="h-4 w-4 text-ink-400 transition-transform group-hover:translate-x-0.5" />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
