#!/usr/bin/env node
/**
 * Generates docs/CODE_REFERENCE.md from the source (static analysis only: nothing is executed, no database, no network).
 *
 *   NODE_PATH=<a folder whose node_modules has acorn and acorn-jsx> node docs/gen_ref.js [--out=docs/CODE_REFERENCE.md]
 *   (install them anywhere outside the repo: npm install --no-save acorn acorn-jsx)
 *   Optional: --extra-root=<another worktree> --extra-files=a.js,b.js   adds a "work in another worktree" section.
 *
 * For every file: who requires it, what it requires, what it exports, and for every top-level function its line, the comment
 * above it, the functions it calls in the same file and the functions it calls in other files (resolved from require()).
 */
const fs = require("fs");
const path = require("path");
const acorn = require("acorn");
const jsx = require("acorn-jsx");
// A generic AST visitor (acorn-walk does not know JSX nodes): every object with a string `type` below `node`, parents first.
const walk = {
  full(node, fn) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk.full(n, fn); return; }
    if (typeof node.type === "string") fn(node);
    for (const k of Object.keys(node)) { if (k === "loc" || k === "type") continue; const v = node[k]; if (v && typeof v === "object") walk.full(v, fn); }
  },
};

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const i = a.indexOf("="); return i < 0 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }));
const REPO = path.resolve(__dirname, "..");
const BACKEND = path.join(REPO, "backend");
const FRONTEND = path.join(REPO, "frontend");
const OUT = path.resolve(REPO, args.out || "docs/CODE_REFERENCE.md");
const Parser = acorn.Parser.extend(jsx());
const norm = (p) => p.split(path.sep).join("/");

function listJs(dir, exts = [".js"], skip = new Set(["node_modules", "dist", "uploads"])) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p, exts, skip));
    else if (exts.includes(path.extname(e.name))) out.push(p);
  }
  return out.sort();
}

function parse(file) {
  const src = fs.readFileSync(file, "utf8");
  const comments = [];
  const opts = { ecmaVersion: "latest", locations: true, allowHashBang: true, onComment: (block, text, start, end, sl, el) => comments.push({ block, text, start, end, startLine: sl.line, endLine: el.line }) };
  let ast;
  try { ast = Parser.parse(src, { ...opts, sourceType: "script" }); } catch (e1) {
    comments.length = 0;
    ast = Parser.parse(src, { ...opts, sourceType: "module" });
  }
  return { src, ast, comments, lines: src.split(/\r?\n/).length };
}

// the comment block directly above a statement (contiguous lines), as one short sentence
function commentAbove(comments, startLine) {
  const chain = [];
  let line = startLine - 1;
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.endLine === line) { chain.unshift(c); line = c.startLine - 1; } else if (c.endLine < line) break;
  }
  if (!chain.length) return "";
  // a block comment's description ends at its first @tag line (everything after belongs to the tags)
  const text = chain.map((c) => { if (!c.block) return c.text; const ls = c.text.split(/\r?\n/).map((l) => l.replace(/^\s*\*+\s?/, "")); const cut = ls.findIndex((l) => /^\s*@\w+/.test(l)); return (cut < 0 ? ls : ls.slice(0, cut)).join(" "); }).join(" ");
  const clean = text.replace(/\s+/g, " ").replace(/[-=]{4,}/g, " ").trim();
  return clean.length > 420 ? clean.slice(0, 417).trimEnd() + "..." : clean;
}

function resolveLocal(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const c of [base, base + ".js", base + ".jsx", path.join(base, "index.js"), path.join(base, "index.jsx")]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

function analyse(file, root) {
  const { ast, comments, lines } = parse(file);
  const rel = (p) => norm(path.relative(root, p));
  const imports = []; // ordered unique file paths
  const alias = new Map(); // local identifier -> {file, name|null}
  const addImport = (f) => { if (f && !imports.includes(f)) imports.push(f); };
  const requireSpec = (n) => n && n.type === "CallExpression" && n.callee.type === "Identifier" && n.callee.name === "require" && n.arguments[0] && n.arguments[0].type === "Literal" && typeof n.arguments[0].value === "string" ? n.arguments[0].value : null;

  walk.full(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.init) {
      let call = node.init, member = null;
      if (call.type === "MemberExpression" && !call.computed) { member = call.property.name; call = call.object; }
      const spec = requireSpec(call);
      if (spec) {
        const f = resolveLocal(file, spec);
        if (f) {
          addImport(f);
          if (node.id.type === "Identifier") alias.set(node.id.name, { file: f, name: member });
          else if (node.id.type === "ObjectPattern") for (const p of node.id.properties) if (p.type === "Property" && p.value.type === "Identifier") alias.set(p.value.name, { file: f, name: p.key.name || p.key.value });
        }
      }
    } else if (node.type === "ImportDeclaration") {
      const f = resolveLocal(file, node.source.value);
      if (f) {
        addImport(f);
        for (const s of node.specifiers) alias.set(s.local.name, { file: f, name: s.type === "ImportDefaultSpecifier" ? null : s.type === "ImportNamespaceSpecifier" ? null : s.imported.name });
      }
    } else if (node.type === "CallExpression") {
      const spec = requireSpec(node);
      if (spec) addImport(resolveLocal(file, spec));
    }
  });

  // exports
  const exportsList = [];
  const addExport = (n) => { if (n && !exportsList.includes(n)) exportsList.push(n); };
  for (const st of ast.body) {
    if (st.type === "ExpressionStatement" && st.expression.type === "AssignmentExpression") {
      const l = st.expression.left, r = st.expression.right;
      const txt = l.type === "MemberExpression" ? (l.object.name === "module" && l.property.name === "exports" ? "module.exports" : l.object.type === "MemberExpression" && l.object.object.name === "module" ? "module.exports." + l.property.name : l.object.name === "exports" ? "exports." + l.property.name : "") : "";
      if (txt === "module.exports") {
        if (r.type === "ObjectExpression") for (const p of r.properties) addExport(p.key ? (p.key.name || p.key.value) : p.type === "SpreadElement" ? "...spread" : null);
        else if (r.type === "Identifier") addExport(r.name + " (default)");
        else if (r.type === "CallExpression" || r.type === "FunctionExpression" || r.type === "ArrowFunctionExpression") addExport("(default)");
        else addExport("(default)");
      } else if (txt.startsWith("module.exports.") || txt.startsWith("exports.")) addExport(txt.split(".").pop());
    } else if (st.type === "ExportDefaultDeclaration") {
      const d = st.declaration;
      addExport((d.id && d.id.name ? d.id.name : d.type === "Identifier" ? d.name : "") + " (default)");
    } else if (st.type === "ExportNamedDeclaration") {
      if (st.declaration) {
        if (st.declaration.id) addExport(st.declaration.id.name);
        else if (st.declaration.declarations) for (const d of st.declaration.declarations) if (d.id.name) addExport(d.id.name);
      }
      for (const s of st.specifiers || []) addExport(s.exported.name);
    }
  }

  // top-level functions
  const fns = [];
  const fnOf = (st) => {
    let s = st;
    if ((s.type === "ExportNamedDeclaration" || s.type === "ExportDefaultDeclaration") && s.declaration) s = s.declaration;
    if (s.type === "FunctionDeclaration" && s.id) return { name: s.id.name, node: s, stmt: st, async: s.async };
    if (s.type === "VariableDeclaration") {
      const out = [];
      for (const d of s.declarations) if (d.id.type === "Identifier" && d.init && (d.init.type === "ArrowFunctionExpression" || d.init.type === "FunctionExpression")) out.push({ name: d.id.name, node: d.init, stmt: st, async: d.init.async });
      return out.length ? out : null;
    }
    return null;
  };
  for (const st of ast.body) {
    const f = fnOf(st);
    if (!f) continue;
    for (const x of Array.isArray(f) ? f : [f]) fns.push(x);
  }
  const localNames = new Set(fns.map((f) => f.name));
  const isComponent = (n) => /^[A-Z]/.test(n);

  for (const f of fns) {
    const calls = [], other = [], renders = [];
    const seenLocal = new Set(), seenOther = new Set(), seenR = new Set();
    walk.full(f.node, (n) => {
      if (n.type === "CallExpression") {
        const c = n.callee;
        if (c.type === "Identifier") {
          if (c.name !== f.name && localNames.has(c.name) && !seenLocal.has(c.name)) { seenLocal.add(c.name); calls.push(c.name + "()"); }
          else if (alias.has(c.name)) { const a = alias.get(c.name); const label = `${rel(a.file)} → ${a.name || c.name}()`; if (!seenOther.has(label)) { seenOther.add(label); other.push(label); } }
        } else if (c.type === "MemberExpression" && !c.computed && c.property.type === "Identifier") {
          if (c.object.type === "Identifier" && alias.has(c.object.name)) { const a = alias.get(c.object.name); const label = `${rel(a.file)} → ${a.name ? a.name + "." : ""}${c.property.name}()`; if (!seenOther.has(label)) { seenOther.add(label); other.push(label); } }
          else if (c.object.type === "CallExpression" && requireSpec(c.object)) { const f2 = resolveLocal(file, requireSpec(c.object)); if (f2) { const label = `${rel(f2)} → ${c.property.name}()`; if (!seenOther.has(label)) { seenOther.add(label); other.push(label); } } }
        }
      } else if (n.type === "JSXOpeningElement" && n.name.type === "JSXIdentifier" && isComponent(n.name.name)) {
        const nm = n.name.name;
        if (alias.has(nm)) { const a = alias.get(nm); const label = `${rel(a.file)} → <${nm}>`; if (!seenR.has(label)) { seenR.add(label); renders.push(label); } }
        else if (localNames.has(nm) && nm !== f.name && !seenR.has("L" + nm)) { seenR.add("L" + nm); renders.push(`this file → <${nm}>`); }
      }
    });
    f.calls = calls; f.other = other; f.renders = renders;
    f.line = f.stmt.loc.start.line;
    f.purpose = commentAbove(comments, f.stmt.loc.start.line);
  }
  const header = commentAbove(comments, ast.body.length ? ast.body[0].loc.start.line : 1);
  const topComment = (() => { const first = comments.find((c) => c.startLine <= 3); if (!first) return ""; const t = first.block ? first.text.split(/\r?\n/).map((l) => l.replace(/^\s*\*+\s?/, "")).join(" ") : ""; let u = first.text; if (!first.block) { const chain = []; for (const c of comments) { if (!c.block && c.startLine === (chain.length ? chain[chain.length - 1].endLine + 1 : c.startLine) && c.startLine <= 3 + chain.length) chain.push(c); else if (chain.length) break; } u = chain.map((c) => c.text).join(" "); return u.replace(/[-=]{4,}/g, " ").replace(/\s+/g, " ").trim().slice(0, 500); } return t.replace(/[-=]{4,}/g, " ").replace(/\s+/g, " ").trim().slice(0, 500); })();
  return { file, rel: rel(file), lines, imports, exportsList, fns, ast, alias, topComment: header && !fns.length ? header : topComment };
}

// ---------------------------------------------------------------- collect
const bFiles = listJs(path.join(BACKEND, "src")).concat(fs.existsSync(path.join(BACKEND, "server.js")) ? [path.join(BACKEND, "server.js")] : []);
const infos = bFiles.map((f) => analyse(f, BACKEND));
const byFile = new Map(infos.map((i) => [i.file, i]));

const scripts = fs.readdirSync(BACKEND).filter((f) => f.endsWith(".js") && f !== "server.js").map((f) => path.join(BACKEND, f)).concat(listJs(path.join(BACKEND, "eval"), [".js"]));
const scriptInfos = scripts.map((f) => analyse(f, BACKEND));

// used by: src + server.js only; tested by: verify-*.js
const usedBy = new Map(), testedBy = new Map();
for (const i of infos) for (const d of i.imports) { if (!usedBy.has(d)) usedBy.set(d, []); usedBy.get(d).push(i.rel); }
for (const s of scriptInfos) for (const d of s.imports) { if (!testedBy.has(d)) testedBy.set(d, []); testedBy.get(d).push(path.basename(s.file)); }

const feFiles = listJs(path.join(FRONTEND, "src"), [".js", ".jsx"]);
const feInfos = feFiles.map((f) => analyse(f, REPO));
const feUsedBy = new Map();
for (const i of feInfos) for (const d of i.imports) { if (!feUsedBy.has(d)) feUsedBy.set(d, []); feUsedBy.get(d).push(i.rel); }

// ---------------------------------------------------------------- sections
const SECTIONS = [
  ["0. Entry point", (r) => r === "server.js"],
  ["1. Config", (r) => r.startsWith("src/config/")],
  ["2. Middleware (har request ke raaste me)", (r) => r.startsWith("src/middleware/")],
  ["3. Routes (URL → controller)", (r) => r.startsWith("src/routes/")],
  ["4. Controllers (request handle)", (r) => r.startsWith("src/controllers/")],
  ["5. Models (MongoDB tables)", (r) => r.startsWith("src/models/")],
  ["6. Tally se baat (odbc)", (r) => r.startsWith("src/services/odbc/")],
  ["7. Tally rules / masters", (r) => r.startsWith("src/services/tally/")],
  ["8. Parser", (r) => r.startsWith("src/services/parser/")],
  ["9. Mapper", (r) => r.startsWith("src/services/mapper/")],
  ["10. Sync / reconciliation / recovery", (r) => r.startsWith("src/services/sync/")],
  ["11. Manual import", (r) => r.startsWith("src/services/import/")],
  ["12. Company / auth services", (r) => r.startsWith("src/services/auth/")],
  ["13. Analytics (dashboards, periods)", (r) => r.startsWith("src/services/analytics/")],
  ["14. AI query engine", (r) => r.startsWith("src/services/query/")],
];
const grouped = SECTIONS.map(([title, test]) => ({ title, items: infos.filter((i) => test(i.rel)) }));
const covered = new Set(grouped.flatMap((g) => g.items.map((i) => i.file)));
const rest = infos.filter((i) => !covered.has(i.file));
if (rest.length) grouped.push({ title: "14b. Other backend source", items: rest });
const FE_GROUPS = [["pages", "pages/"], ["components", "components/"], ["context", "context/"], ["api (backend calls)", "api/"], ["lib (hooks and helpers)", "lib/"]];
const feSections = [];
for (const [label, prefix] of FE_GROUPS) feSections.push({ title: `15. Frontend: ${label}`, items: feInfos.filter((i) => i.rel.startsWith("frontend/src/" + prefix)) });
const feRoot = feInfos.filter((i) => !FE_GROUPS.some(([, p]) => i.rel.startsWith("frontend/src/" + p)));
if (feRoot.length) feSections.push({ title: "15. Frontend: app entry", items: feRoot });
grouped.push(...feSections);

// extra worktree (optional)
let extra = null;
let extraRoot = null; // set while the section of another worktree is rendered (its imports are relative to that worktree)
if (args["extra-root"] && args["extra-files"]) {
  const root = path.resolve(args["extra-root"]);
  const files = String(args["extra-files"]).split(",").map((f) => path.join(root, "backend", f.trim()));
  extra = { root, items: files.filter((f) => fs.existsSync(f)).map((f) => analyse(f, path.join(root, "backend"))) };
}

// ---------------------------------------------------------------- render
const out = [];
const w = (s = "") => out.push(s);
const tick = (s) => "`" + s + "`";
const list = (a) => (a.length ? a.map(tick).join(", ") : "(none)");
const relUsedBy = (i, map, isFe) => (map.get(i.file) || []).filter((x, k, arr) => arr.indexOf(x) === k);

// The wiring statements of server.js and the route files: app.use("/api/x", router) and router.post("/p", mw..., handler).
function routing(i) {
  const lines = [];
  const objs = i.rel === "server.js" ? new Set(["app"]) : i.rel.startsWith("src/routes/") ? new Set(["router"]) : null;
  if (!objs) return lines;
  const label = (n) => {
    if (n.type === "Identifier") return n.name;
    if (n.type === "MemberExpression" && !n.computed) return label(n.object) + "." + (n.property.name || "?");
    if (n.type === "CallExpression") return label(n.callee) + "()";
    if (n.type === "SpreadElement") return "..." + label(n.argument);
    if (n.type === "Literal") return JSON.stringify(n.value);
    if (n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression") return "(inline handler)";
    return n.type;
  };
  for (const st of i.ast.body) {
    if (st.type !== "ExpressionStatement" || st.expression.type !== "CallExpression") continue;
    const c = st.expression;
    // a helper that wires the app, e.g. applyHttpSecurity(app)
    if (c.callee.type === "Identifier" && c.arguments.some((a) => a.type === "Identifier" && objs.has(a.name))) {
      const al = i.alias.get(c.callee.name);
      lines.push(`${c.callee.name}(${[...objs][0]})${al ? ` (${norm(path.relative(BACKEND, al.file))})` : ""}`);
      continue;
    }
    if (c.callee.type !== "MemberExpression" || c.callee.object.type !== "Identifier" || !objs.has(c.callee.object.name)) continue;
    const method = c.callee.property.name;
    if (!["use", "get", "post", "put", "patch", "delete", "listen", "disable"].includes(method)) continue;
    const args = c.arguments;
    const first = args[0] && args[0].type === "Literal" && typeof args[0].value === "string" ? args[0].value : null;
    const rest = (first === null ? args : args.slice(1)).map((a) => {
      const l = label(a);
      const al = a.type === "Identifier" ? i.alias.get(a.name) : null;
      return al ? `${l} (${norm(path.relative(BACKEND, al.file))})` : l;
    });
    lines.push(`${c.callee.object.name}.${method}(${first === null ? "" : JSON.stringify(first)}) ${method === "listen" ? "" : "→ "}${rest.join(" → ")}`.trim());
  }
  return lines;
}

function renderFile(i, kind) {
  w(`## ${tick(i.rel)}`);
  if (kind === "extra") w("**Worktree only:** is branch me ye file nahi hai, isliye 'Used by' wahan ke worktree me dekho.");
  else {
    const ub = kind === "fe" ? relUsedBy(i, feUsedBy) : relUsedBy(i, usedBy);
    w(`**Used by:** ${ub.length ? list(ub) : i.rel === "server.js" ? "(entry file / run directly)" : "(nothing in the app requires it: entry file, or used only by tests)"}`);
    const tb = kind === "fe" ? [] : (testedBy.get(i.file) || []).filter((x, k, a) => a.indexOf(x) === k);
    if (tb.length) w(`\n**Tested by:** ${tb.slice(0, 8).map(tick).join(", ")}${tb.length > 8 ? ` (+${tb.length - 8} more)` : ""}`);
  }
  const imp = i.imports.map((f) => norm(path.relative(extraRoot ? path.join(extraRoot, "backend") : kind === "fe" ? REPO : BACKEND, f)));
  w(`\n**Imports:** ${list(imp)}`);
  if (i.exportsList.length) w(`\n**Exports:** ${list(i.exportsList)}`);
  if (i.topComment && !i.fns.length) w(`\n**Purpose:** ${i.topComment}`);
  const wiring = routing(i);
  if (wiring.length) { w(); w(i.rel === "server.js" ? "**Middleware and route mounts (in order):**" : "**Routes (METHOD path → middleware → handler):**"); w(); for (const l of wiring) w("- " + tick(l)); }
  w();
  for (const f of i.fns) {
    w(`- **${tick(f.name + "()")}**${f.async ? " _(async)_" : ""} — line ${f.line}`);
    w(`  - Purpose: ${f.purpose || "(no comment in code — see name and calls below)"}`);
    if (f.calls.length) w(`  - Calls in this file: ${list(f.calls)}`);
    if (f.other.length) w(`  - Calls other files: ${list(f.other)}`);
    if (f.renders && f.renders.length) w(`  - Renders: ${list(f.renders)}`);
  }
  w();
}

const today = new Date().toISOString().slice(0, 10);
const totalFns = (a) => a.reduce((n, i) => n + i.fns.length, 0);
w("# TallyPulse code reference (generated from the source)");
w();
w(`> **Generated on ${today} by \`docs/gen_ref.js\`** from the code in this checkout. To refresh it: install \`acorn acorn-jsx\` outside the repo (\`npm install --no-save acorn acorn-jsx\` in a scratch folder) and run \`NODE_PATH=<that folder>/node_modules node docs/gen_ref.js\`. It is static analysis: only top-level functions are listed, and "Calls other files" shows calls it could resolve from \`require()\`/\`import\`; calls through objects passed as arguments are not traced. For the current map of rules and architecture use [\`PROJECT_CONTEXT.md\`](PROJECT_CONTEXT.md).`);
w();
w("Har file ke liye: kya karti hai, kaun use karta hai, kaun si functions hain, har function kya karta hai (code ke apne comments se), aur wo kis dusri file ka kaun sa function call karta hai. \"Tested by\" batata hai kaun si verify-*.js suites us file ko require karti hain.");
w();
w("> Comments code se uthaye gaye hain, isliye English me hain. Simple Hindi/Hinglish samjhane wala hissa alag file `CODE_WALKTHROUGH_HINGLISH.md` me hai (wo haath se likha hai, is file se purana ho sakta hai).");
w();
w(`**Is snapshot me:** backend ${infos.length} source files (${totalFns(infos)} functions), frontend ${feInfos.length} files (${totalFns(feInfos)} functions/components), backend scripts ${scriptInfos.length} files.`);
w();
w("## Index");
w();
for (const g of grouped) {
  if (!g.items.length) continue;
  w(`**${g.title}**`);
  w();
  for (const i of g.items) w(`- ${tick(i.rel)} (${i.lines} lines, ${i.fns.length} functions)`);
  w();
}
w("**16. Backend scripts (operator tools, evaluations, verification suites)**");
w();
w("- see section 16 below (one line per script)");
w();
if (extra) { w("**17. Work in another worktree (not in this branch)**"); w(); for (const i of extra.items) w(`- ${tick(i.rel)} (${i.lines} lines, ${i.fns.length} functions)`); w(); }

for (const g of grouped) {
  if (!g.items.length) continue;
  w();
  w(`# ${g.title}`);
  w();
  for (const i of g.items) renderFile(i, g.title.startsWith("15.") ? "fe" : "be");
}

// scripts
w();
w("# 16. Backend scripts (operator tools, evaluations, verification suites)");
w();
w("Ye sab `backend/` ke root me (aur `backend/eval/`) hain. `verify-*.js` offline tests hain jinka `check()` helper har file me apna hai; kuch scripts DB likhti hain (migrate-*, refresh-*, backfill-*), unhe bina padhe mat chalana. Har line: file, kya karti hai (file ke upar ke comment se), aur kaun si app files require karti hai.");
w();
const kinds = [["Verification suites (`verify-*.js`)", (s) => /^verify-/.test(path.basename(s.file))], ["Evaluations and corpora (`eval-*`, `backend/eval/`)", (s) => /(^|\/)eval(-|\/)/.test(s.rel) || /^eval-/.test(path.basename(s.file))], ["Operator and migration scripts", (s) => true]];
const done = new Set();
for (const [label, test] of kinds) {
  const group = scriptInfos.filter((s) => !done.has(s.file) && test(s));
  group.forEach((s) => done.add(s.file));
  if (!group.length) continue;
  w(`## ${label}`);
  w();
  for (const s of group) {
    const reqs = s.imports.filter((f) => f.startsWith(path.join(BACKEND, "src"))).map((f) => norm(path.relative(BACKEND, f)));
    w(`- ${tick(s.rel)} (${s.lines} lines) — ${s.topComment || "(no header comment)"}${reqs.length ? ` _Uses:_ ${reqs.slice(0, 5).map(tick).join(", ")}${reqs.length > 5 ? ` (+${reqs.length - 5} more)` : ""}` : ""}`);
  }
  w();
}

if (extra) {
  w();
  w("# 17. Work in another worktree (not in this branch)");
  w();
  w(`Ye files abhi is branch me nahi hain: wo \`${norm(extra.root)}\` worktree me uncommitted hain (cost/retry measurement). Wahan ke kuch purane files bhi badle hain (planner.js, queryChat.js, turnTelemetry.js, usageStore.js, aiTurnUsage.model.js, verify-ai-usage-persist.js): unka naya hissa yahan alag se nahi likha. Jab wo kaam commit/merge ho, is section ko hata kar generator dobara chalao.`);
  w();
  extraRoot = extra.root;
  for (const i of extra.items) renderFile(i, "extra");
  extraRoot = null;
}

// one line-ending style (CRLF, as the committed file had), no trailing blanks, never more than two empty lines in a row
const text = out.join("\n").split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, "")).join("\n").replace(/\n{4,}/g, "\n\n\n").replace(/\n+$/, "").replace(/\n/g, "\r\n") + "\r\n";
fs.writeFileSync(OUT, text);
console.log(`wrote ${norm(path.relative(REPO, OUT))}: ${infos.length} backend files, ${feInfos.length} frontend files, ${scriptInfos.length} scripts, ${text.split("\r\n").length} lines`);
