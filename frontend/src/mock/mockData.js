// --------------------------------------------------------------------
// SAMPLE / DEMO DATA — clearly isolated in this one file.
//
// Most of this file's original contents have been replaced by real API
// calls as backend capability was added (see each consuming page's own
// comments for exactly what's real vs. not) — including the Sales
// Invoices / Purchase Bills lists (VoucherRegister.jsx) and, most
// recently, the Reports page itself (see pages/Reports.jsx). What
// remains here is data with genuinely no backing capability today:
//   - MOCK_AI_DEMO_TURN / MOCK_SUGGESTED_QUESTIONS: AskAI's explicit,
//     user-triggered "Show demo response" preview and suggested-prompt
//     chips — not touched by the frontend production-readiness pass
//     (AI/chat functionality is explicitly out of scope for that work).
// --------------------------------------------------------------------

// A pre-canned assistant turn shown only when the user explicitly asks
// to preview the AI experience (see AskAI.jsx) — never shown as a real
// answer, always labeled "Demo response" in the UI.
export const MOCK_AI_DEMO_TURN = {
  question: "What were my total sales in September 2025?",
  answer:
    "Your total sales in September 2025 were ₹1,24,800 across 48 invoices. This is 12.6% higher than August 2025 (₹1,10,800).",
  trend: [
    { label: "Apr", value: 78000 },
    { label: "May", value: 86000 },
    { label: "Jun", value: 91000 },
    { label: "Jul", value: 98000 },
    { label: "Aug", value: 110800 },
    { label: "Sep", value: 124800 },
  ],
  followUps: ["View detailed report", "Compare with last year", "Show top products"],
};

export const MOCK_SUGGESTED_QUESTIONS = [
  "Top customers",
  "Purchase summary",
  "Low stock items",
  "Product growth",
];
