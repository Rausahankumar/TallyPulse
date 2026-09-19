import { BarChart3, ShieldCheck, Sparkles, TrendingUp } from "lucide-react";

const FEATURES = [
  { icon: TrendingUp, text: "Accurate Analytics" },
  { icon: Sparkles, text: "AI-Powered Insights" },
  { icon: ShieldCheck, text: "Secure & On-Premise" },
  { icon: BarChart3, text: "Built for Growing Businesses" },
];

export default function AuthLayout({ children }) {
  return (
    <div className="flex min-h-screen bg-surface">
      <div className="relative hidden w-[440px] shrink-0 flex-col justify-between overflow-hidden bg-navy-950 px-10 py-12 text-white lg:flex">
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-brand-600/20 blur-3xl"
          aria-hidden
        />
        <div>
          <div className="mb-14 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600">
              <BarChart3 className="h-5 w-5 text-white" />
            </span>
            <div className="leading-tight">
              <p className="text-[16px] font-semibold">TallyPulse</p>
              <p className="text-[11px] text-navy-muted">From Data to Decisions</p>
            </div>
          </div>

          <h1 className="text-[30px] font-semibold leading-[1.2] tracking-tight">
            Turn Your Tally Data into <span className="text-brand-400">Real Opportunities</span>
          </h1>
          <p className="mt-4 text-[14px] leading-relaxed text-navy-muted">
            AI-powered insights for smarter sales, purchases and business growth.
          </p>

          <ul className="mt-10 space-y-4">
            {FEATURES.map((f) => (
              <li key={f.text} className="flex items-center gap-3 text-[13.5px] text-white/90">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/10">
                  <f.icon className="h-4 w-4 text-brand-300" />
                </span>
                {f.text}
              </li>
            ))}
          </ul>
        </div>

        <blockquote className="border-l-2 border-brand-500 pl-4 text-[13px] italic text-navy-muted">
          "Your Data. Smarter Decisions.
          <br />A Stronger Tomorrow."
        </blockquote>
      </div>

      <div className="flex flex-1 items-center justify-center px-6 py-12">
        <div className="w-full max-w-[400px]">{children}</div>
      </div>
    </div>
  );
}
