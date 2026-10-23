"use strict";

const { z } = require("zod");
const insights = require("./insights");
const dateRanges = require("./dateRanges");

// --------------------------------------------------
// Insight tools: a small, validated registry over the EXISTING insight functions (insights.js), so a later Ask AI step can
// use business analytics without a second implementation of any calculation. Nothing here calls a model; Ask AI reaches it
// only through analysis plans (query/analysisPlan.js, behind ASK_AI_ANALYSIS).
//
//   runInsightTool(toolId, args, context) -> { ok: true, ...evidence } | { ok: false, tool, error: { code, message } }
//
// - context.tenantId comes from the authenticated company context (req.companyContext) ONLY. The argument schemas are
//   strict, so a tenant (or any other unknown key) inside `args` is rejected, never used.
// - Every execution passes an explicit maxTimeMS to every aggregation (DEFAULT_MAX_TIME_MS, or a smaller/equal
//   context.maxTimeMS). Inputs are bounded (period span, limit, product length); results are the functions' own bounded
//   results (limit <= 50, at most insights.MAX_GROUP_ROWS groups, otherwise result_too_large - never truncated).
// - The data is the insight function's own result, unchanged (same numbers and shape as the REST pages); the evidence
//   adds the resolved period, the normalised arguments, the function's disclosures, coverage and the tool's limitations.
// - Errors are mapped to fixed codes and plain messages; a database error's text is never returned.
// - Periods use the REST helpers (dateRanges.resolveRequestPeriod, the tenant reference date); product names use the
//   tenant's own entity resolver (the same one Ask AI uses), so a name resolves to its stored spelling or is refused.
// --------------------------------------------------

const DEFAULT_MAX_TIME_MS = 8000; // the same per-aggregation limit as the query engine (LIMITS.queryTimeoutMs)
const MAX_RANGE_DAYS = 1830; // the same longest custom range as the query engine (periods.rules.maxCustomRangeDays)
const MAX_LIMIT = 50; // the REST limit convention (analyticsController parseLimitFromQuery), and insights' own cap
const MAX_NAME_LENGTH = 200; // the query engine's LIMITS.maxStringLength
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const periodSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["current_month", "previous_month"]) }),
  z.strictObject({ kind: z.literal("custom"), from: isoDay, to: isoDay }),
]);
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(10);
const productSchema = z.string().trim().min(1).max(MAX_NAME_LENGTH);

const DISCOUNT_BREAKDOWNS = { sales: ["customer", "product", "month"], purchase: ["supplier", "product", "month"] }; // as the REST handler

const INDICATIVE_MARGIN = "Indicative margin from average sale and purchase rates, not accounting profit (no stock valuation).";
const NOT_A_CAUSE = "These figures describe what happened; on their own they do not explain a change in sales.";
// Notes computed from the returned data (never from the question): what a reader must know about THESE figures.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmtAmount = (v) => `₹${Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const unitNote = (rows) => {
  const n = rows.filter((r) => r.unitWarning).length;
  return n ? [`${plural(n, "product shown has", "products shown have")} line rates that differ by more than 5×: the unit of measure may differ between vouchers.`] : [];
};
function discountNotes(d) {
  const t = d.totals || {};
  const out = [];
  const noRate = (t.lines || 0) - (t.listedLines || 0);
  if (noRate > 0) out.push(`${plural(noRate, "item line has", "item lines have")} no rate or quantity and ${noRate === 1 ? "is" : "are"} not in the discount figures.`);
  if (t.excludedLines > 0) out.push(`${plural(t.excludedLines, "item line has", "item lines have")} a discount in Tally that does not agree with its quantity, rate and amount (often another unit) and ${t.excludedLines === 1 ? "is" : "are"} left out.`);
  if (t.freeLines > 0) out.push(`${plural(t.freeLines, "item line was", "item lines were")} given free (list value ${fmtAmount(t.freeValue)}): free goods are not counted as discount.`);
  if (t.aboveListLines > 0) out.push(`${plural(t.aboveListLines, "item line is", "item lines are")} billed ${fmtAmount(t.aboveListAmount)} above quantity × rate (a price above the list rate, or another unit): counted at the billed amount, with no discount.`);
  if (t.reductionLines > 0) out.push(`${plural(t.reductionLines, "item line is", "item lines are")} billed ${fmtAmount(t.reductionAmount)} below quantity × rate with no discount recorded in Tally (free quantity on a billed line, another unit, or lines synced before discounts were read): not counted as discount, so the discount may be incomplete.`);
  return out;
}
// lines left out of the average rates because their billed quantity is not known (insights PRICED_STAGES)
function uncertainNotes(u) {
  const out = [];
  if (u && u.saleLines > 0) out.push(`${plural(u.saleLines, "sale line", "sale lines")} (${fmtAmount(u.saleValue)}) ${u.saleLines === 1 ? "is" : "are"} billed below quantity × rate with no discount recorded in Tally (free quantity, another unit, or synced before discounts were read): left out of the average rates.`);
  if (u && u.purchaseLines > 0) out.push(`${plural(u.purchaseLines, "purchase line", "purchase lines")} (${fmtAmount(u.purchaseValue)}) ${u.purchaseLines === 1 ? "is" : "are"} left out of the average costs for the same reason.`);
  return out;
}
function marginNotes(d) {
  const s = d.summary || {};
  const rows = d.rows || [];
  const out = [];
  if (s.withoutCost > 0) out.push(`${s.withoutCost} of ${s.products} products have no purchase cost in the period or the 12 months before: they have no margin and are listed last.`);
  const earlier = rows.filter((r) => r.costSource === "earlier").length;
  if (earlier) out.push(`For ${plural(earlier, "product", "products")} shown, the cost is the average purchase rate of the 12 months before the period (nothing was bought in it).`);
  return [...out, ...uncertainNotes(s.uncertain), ...unitNote(rows)];
}

const VOUCHER_SETS ="Distinct voucher counts are computed from per-group voucher-id sets that are not capped; the tool is restricted to ONE product so those sets stay small, and maxTimeMS bounds the work.";

const TOOLS = {
  discount_summary: {
    description: "Discount given (sales) or received (purchases) in a period: the discount Tally records per item line (list value of the billed quantity minus the billed amount), by customer/supplier, product or month. Free goods are shown apart. Pre-tax item values.",
    ready: true,
    args: z
      .strictObject({ period: periodSchema, entity: z.enum(["sales", "purchase"]).default("sales"), by: z.enum(["customer", "supplier", "product", "month"]).nullable().default(null), limit: limitSchema })
      .refine((a) => a.by === null || DISCOUNT_BREAKDOWNS[a.entity].includes(a.by), { message: "this breakdown does not exist for the entity", path: ["by"] }),
    product: null,
    voucherTypes: (a) => [a.entity === "purchase" ? "Purchase" : "Sales"],
    run: (tenantId, period, a, maxTimeMS) => insights.discountSummary(tenantId, period, { entity: a.entity, by: a.by, limit: a.limit, maxTimeMS }),
    rows: (d) => d.rows,
    ordering: (a) => (a.by === "month" ? "by month" : a.by ? "largest discount first" : null),
    notes: discountNotes,
    limitations: [NOT_A_CAUSE],
  },
  product_rates: {
    description: "Average sale and purchase rate per product in a period (after discount, before tax), with the rate gap and unit warnings.",
    ready: true,
    args: z.strictObject({ period: periodSchema, product: productSchema.optional(), limit: limitSchema }),
    product: "optional",
    voucherTypes: () => ["Sales", "Purchase"],
    run: (tenantId, period, a, maxTimeMS) => insights.ratesByProduct(tenantId, period, { limit: a.limit, product: a.product || null, maxTimeMS }),
    rows: (d) => d.rows,
    ordering: () => "largest sale value first",
    notes: (d) => [...uncertainNotes(d.uncertain), ...unitNote(d.rows || [])],
    limitations: ["The rate gap is a price difference, not a profit.", NOT_A_CAUSE],
  },
  product_margin: {
    description: "Indicative margin per product sold in a period: average sale rate minus average purchase cost per billed unit. sortBy marginPct ranks by margin %, profit by indicative rupees, unit margin × quantity. Not accounting profit.",
    ready: true,
    args: z.strictObject({ period: periodSchema, sortBy: z.enum(["profit", "marginPct"]).default("profit"), order: z.enum(["desc", "asc"]).default("desc"), limit: limitSchema }),
    product: null,
    voucherTypes: () => ["Sales", "Purchase"],
    run: (tenantId, period, a, maxTimeMS) => insights.productMargin(tenantId, period, { limit: a.limit, sortBy: a.sortBy, order: a.order, maxTimeMS }),
    rows: (d) => d.rows,
    ordering: (a) => `${a.sortBy === "marginPct" ? "indicative margin %" : "indicative profit (₹)"}, ${a.order === "asc" ? "lowest" : "highest"} first (products without a cost last)`,
    notes: marginNotes,
    limitations: [INDICATIVE_MARGIN, NOT_A_CAUSE],
  },
  product_trend: {
    description: "Quantity bought and sold per month for ONE product, with the net movement (not a stock balance).",
    ready: true,
    args: z.strictObject({ period: periodSchema, product: productSchema }),
    product: "required",
    voucherTypes: () => ["Sales", "Purchase"],
    run: (tenantId, period, a, maxTimeMS) => insights.productTrend(tenantId, period, { product: a.product, maxTimeMS }),
    rows: (d) => d.rows,
    ordering: () => "by month",
    limitations: ["Movement, not a stock balance: opening stock, stock journals and returns are not included.", VOUCHER_SETS, NOT_A_CAUSE],
  },
  supplier_rates: {
    description: "What each supplier charged per unit for ONE product in a period, the cheapest meaningful supplier and the indicative saving.",
    ready: true,
    // The REST page also allows "all products"; this tool requires one product (see VOUCHER_SETS).
    args: z.strictObject({ period: periodSchema, product: productSchema }),
    product: "required",
    voucherTypes: () => ["Purchase"],
    run: (tenantId, period, a, maxTimeMS) => insights.supplierRates(tenantId, period, { product: a.product, limit: 1, maxTimeMS }),
    rows: (d) => d.rows,
    ordering: () => "suppliers cheapest first",
    // insights.supplierRates lists at most 8 suppliers per product (REST behaviour, unchanged): say so when there are more
    notes: (d) => [...d.rows.filter((r) => r.supplierCount > r.suppliers.length).map((r) => `${r.product}: the ${r.suppliers.length} cheapest of ${r.supplierCount} suppliers are listed; the best rate and the saving use all of them.`), ...unitNote(d.rows)],
    limitations: ["The saving and the per-supplier margin are indicative: they assume a supplier could supply everything at its average rate.", INDICATIVE_MARGIN, VOUCHER_SETS],
  },
};

const fail = (tool, code, message, extra = {}) => ({ ok: false, tool, error: { code, message, ...extra } });
const dayString = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function listInsightTools() {
  return Object.entries(TOOLS).map(([id, t]) => ({ id, description: t.description, ready: t.ready, productArgument: t.product, limitations: [...t.limitations] }));
}

async function resolvePeriod(period, context, tenantId) {
  if (period.kind === "custom") {
    let range;
    try {
      range = dateRanges.customRange(period.from, period.to);
    } catch (e) {
      return { error: "the period is not a valid date range (from must not be after to)" };
    }
    // a day that does not exist (2025-02-30) must not roll over into the next month
    if (dayString(range.from) !== period.from || dayString(range.to) !== period.to) return { error: "the period contains a date that does not exist" };
    if (Math.round((range.to - range.from) / DAY_MS) > MAX_RANGE_DAYS) return { error: `the period is longer than ${MAX_RANGE_DAYS} days` };
    return { range: { ...range, label: `${period.from} to ${period.to}` } };
  }
  const referenceDate = context.referenceDate instanceof Date ? context.referenceDate : await (context.getReferenceDate || require("./referenceDate").getTenantReferenceDate)(tenantId);
  return { range: dateRanges.resolveRequestPeriod({ period: period.kind }, referenceDate) };
}

async function resolveProduct(text, context, tenantId) {
  const resolver = context.resolveEntity || require("../query/entityResolver").createEntityResolver({ tenantId });
  let matches;
  try {
    ({ matches } = await resolver({ hintDim: "product", text }));
  } catch (e) {
    return { error: { code: "entity_lookup_unavailable", message: "Product names could not be looked up right now. Please try again." } };
  }
  const found = (matches || []).filter((m) => m.dim === "product");
  if (found.length === 1) return { value: found[0].value, partial: !!found[0].partial };
  let suggestions = [];
  if (!found.length && typeof resolver.suggest === "function") {
    try {
      suggestions = ((await resolver.suggest({ hintDim: "product", text })) || []).map((s) => s.value);
    } catch (e) {
      suggestions = [];
    }
  }
  return { error: { code: "product_not_found", message: `"${text}" did not match a product of this company.`, ...(suggestions.length ? { suggestions } : {}) } };
}

/**
 * @param {string} toolId one of listInsightTools()
 * @param {object} args the tool's arguments (validated against its strict schema)
 * @param {{tenantId: string, referenceDate?: Date, maxTimeMS?: number, resolveEntity?: Function, getReferenceDate?: Function}} context
 *        tenantId from the authenticated company context only
 */
async function runInsightTool(toolId, args, context = {}) {
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, toolId) ? TOOLS[toolId] : null;
  if (!tool) return fail(toolId, "unknown_tool", "This insight tool does not exist.");
  if (!tool.ready) return fail(toolId, "tool_not_ready", "This insight tool is not available yet.");
  const tenantId = context && context.tenantId;
  if (typeof tenantId !== "string" || !tenantId.trim()) return fail(toolId, "tenant_required", "An authorized company context is required.");
  const maxTimeMS = context.maxTimeMS === undefined ? DEFAULT_MAX_TIME_MS : context.maxTimeMS;
  if (!Number.isInteger(maxTimeMS) || maxTimeMS < 1 || maxTimeMS > DEFAULT_MAX_TIME_MS) return fail(toolId, "invalid_context", `maxTimeMS must be a whole number from 1 to ${DEFAULT_MAX_TIME_MS}.`);

  const parsed = tool.args.safeParse(args === undefined ? {} : args);
  if (!parsed.success) {
    return fail(toolId, "invalid_arguments", "The tool arguments are not valid.", { issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) });
  }
  const a = { ...parsed.data };

  try {
    const period = await resolvePeriod(a.period, context, tenantId);
    if (period.error) return fail(toolId, "invalid_arguments", "The tool arguments are not valid.", { issues: [{ path: "period", message: period.error }] });
    let productMatch = null;
    if (a.product) {
      const resolved = await resolveProduct(a.product, context, tenantId);
      if (resolved.error) return fail(toolId, resolved.error.code, resolved.error.message, resolved.error.suggestions ? { suggestions: resolved.error.suggestions } : {});
      productMatch = { asked: a.product, resolved: resolved.value, partial: resolved.partial };
      a.product = resolved.value;
    }

    const data = await tool.run(tenantId, period.range, a, maxTimeMS);
    const rows = tool.rows(data) || [];
    const limit = typeof a.limit === "number" ? a.limit : null;
    return {
      ok: true,
      tool: toolId,
      period: { kind: a.period.kind, from: dayString(period.range.from), to: dayString(period.range.to), label: period.range.label || null },
      arguments: a,
      ...(productMatch ? { productMatch } : {}),
      data,
      disclosures: [...(data.disclosures || [])],
      coverage: {
        hasData: !!data.hasData,
        rowsReturned: rows.length,
        rowLimit: limit,
        // the functions return the top rows only and do not report how many exist in all: say so, never imply completeness
        mayHaveMore: limit !== null && rows.length >= limit,
        ordering: tool.ordering(a),
        notes: tool.notes ? tool.notes(data) : [],
      },
      limitations: [...tool.limitations],
      maxTimeMS,
    };
  } catch (error) {
    if (error && error.code === "query_timeout") return fail(toolId, "query_timeout", "The calculation took too long. Choose a shorter period or a narrower filter.");
    if (error && error.code === "result_too_large") return fail(toolId, "result_too_large", error.message);
    if (error && error.status === 400) return fail(toolId, "invalid_arguments", "The tool arguments are not valid.", { issues: [{ path: "", message: String(error.message || "").slice(0, 200) }] });
    return fail(toolId, "execution_failed", "The calculation could not be completed.");
  }
}

/** Each ready tool's argument schema as JSON Schema (input form, so defaulted fields are optional), from the same zod schemas. */
function insightToolArgsJsonSchemas() {
  const out = {};
  for (const [id, t] of Object.entries(TOOLS)) {
    if (!t.ready) continue;
    const { $schema, ...rest } = z.toJSONSchema(t.args, { io: "input" });
    out[id] = rest;
  }
  return out;
}

/**
 * The period a tool would read, resolved exactly as runInsightTool resolves it (no aggregation), so a caller can refuse a
 * period outside the synced history BEFORE paying for the tool. null when the tool or its arguments are not valid (the tool
 * itself then refuses them).
 */
async function resolveInsightPeriod(toolId, args, context = {}) {
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, toolId) ? TOOLS[toolId] : null;
  const parsed = tool ? tool.args.safeParse(args === undefined ? {} : args) : null;
  if (!parsed || !parsed.success || typeof context.tenantId !== "string") return null;
  const period = await resolvePeriod(parsed.data.period, context, context.tenantId);
  return period.error ? null : period.range;
}

/** The voucher types a tool reads (for the freshness gate), from its validated arguments; an unknown tool reads none. */
function insightToolVoucherTypes(toolId, args) {
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, toolId) ? TOOLS[toolId] : null;
  const parsed = tool ? tool.args.safeParse(args === undefined ? {} : args) : null;
  return parsed && parsed.success ? tool.voucherTypes(parsed.data) : [];
}

/** Schema check of a tool's arguments without running it (no database): the same strict schema runInsightTool uses. */
function validateInsightArgs(toolId, args) {
  const tool = Object.prototype.hasOwnProperty.call(TOOLS, toolId) ? TOOLS[toolId] : null;
  if (!tool || !tool.ready) return { ok: false, issues: [{ path: "tool", message: "unknown or unavailable insight tool" }] };
  const parsed = tool.args.safeParse(args === undefined ? {} : args);
  return parsed.success ? { ok: true } : { ok: false, issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })) };
}

module.exports = { runInsightTool, listInsightTools, insightToolArgsJsonSchemas, validateInsightArgs, insightToolVoucherTypes, resolveInsightPeriod, DEFAULT_MAX_TIME_MS, MAX_RANGE_DAYS, MAX_LIMIT };
