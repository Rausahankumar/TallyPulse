import { FlaskConical } from "lucide-react";

// Every analytics screen (Dashboard, Sales/Purchase/Products/Customers
// Analytics, Reports) renders against sample data today because the
// backend does not yet expose analytics over REST — the real
// analytics engine only answers through the chat/tool layer, and that
// path currently returns 501 until Claude is wired up server-side
// (docs §11/§17). This banner is the one place that fact is stated,
// so no screen silently implies these numbers are live.
export default function MockDataBanner({ label = "Sample data" }) {
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3.5 py-2 text-[13px] text-brand-700">
      <FlaskConical className="h-4 w-4 shrink-0" />
      <span>
        <strong className="font-semibold">{label}.</strong> Connect the analytics API to replace
        these figures with your live TallyPrime data.
      </span>
    </div>
  );
}
