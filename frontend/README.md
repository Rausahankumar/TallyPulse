# TallyPulse frontend

React 19 + Vite + Tailwind CSS 4 single-page app. It talks to the backend over REST only (`src/api/`) and never computes a business figure itself. Requests go to `/api`; in development Vite proxies that to `http://localhost:5000` (override with `VITE_API_PROXY_TARGET`), and for a build served from another origin set `VITE_API_BASE_URL`.

```bash
npm install
npm run dev       # http://localhost:5173
npm run lint      # oxlint
npm run build
```

Pages (`src/pages`): Dashboard, Sales / Purchase / Customers / Products analytics, Reports with CSV export, Sync Data, Ask AI, Settings and the auth pages (register, login, Connect Tally). Ask AI renders the backend's answer text as sanitised Markdown and its presentation model as KPI cards, charts and exact-value tables (`src/components/chat`).

Verification scripts (plain `node`, no browser): `verify-chat-api.mjs`, `verify-chat-rendering.mjs`, `verify-chat-presentation.mjs`, `verify-dashboard-report-link.mjs`, and `verify-chat-timeout.cjs` (takes about 45 seconds).
