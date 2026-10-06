const Sale = require("../models/sales.model");
const Purchase = require("../models/purchase.model");

// --------------------------------------------------
// Server-side paginated + searchable voucher listing for the Sales
// Register / Purchase Register screens. No "list vouchers" endpoint
// existed before this - GET /api/sync/status only ever exposed the 10
// most-recently-updated vouchers, unpaginated, unsearchable.
//
// tenantId always comes from req.companyContext (set by the
// liveCompanyContext middleware, re-derived from the authenticated
// user's live account on every request - never from a query param, body
// field, or header). Every query below is built through the same
// {tenantId, ...} shape analyticsScope.buildVoucherMatchStage uses
// elsewhere, so tenant scoping can't be forgotten by a future edit here.
// --------------------------------------------------

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const DEFAULT_STATUSES = ["active"];

function parsePagination(query) {
  const page = Number.parseInt(query.page, 10);
  const limit = Number.parseInt(query.limit, 10);

  return {
    page: Number.isFinite(page) && page > 0 ? page : 1,
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT,
  };
}

function parseDateBound(value, label) {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    const err = new Error(`Invalid "${label}" date: "${value}".`);
    err.status = 400;
    throw err;
  }
  return parsed;
}

// Same regex-escaping discipline as the query engine's name matching
// (query/compile.js) - real voucher/party text, never a pattern, so it
// must never be interpreted as one.
function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One `search` box covers the fields that make sense for free text:
// voucher number and party name (partial, case-insensitive), plus an
// exact amount match when the term parses as a number. Date is
// deliberately NOT part of free-text search - date-format parsing from
// arbitrary text is ambiguous; the existing `from`/`to` params (same
// convention as the analytics endpoints) cover date filtering instead.
function buildSearchClause(search) {
  const term = String(search || "").trim();
  if (!term) return null;

  const escaped = escapeRegex(term);
  const clauses = [
    { "header.voucherNo": { $regex: escaped, $options: "i" } },
    { "header.partyName": { $regex: escaped, $options: "i" } },
  ];

  const asNumber = Number(term);
  if (term !== "" && Number.isFinite(asNumber)) {
    clauses.push({ "header.voucherTotalAmount": asNumber });
  }

  return { $or: clauses };
}

async function listVouchers(Model, req, res) {
  try {
    const { tenantId } = req.companyContext;
    const { page, limit } = parsePagination(req.query);
    const from = parseDateBound(req.query.from, "from");
    const to = parseDateBound(req.query.to, "to");

    const match = { tenantId, voucherStatus: { $in: DEFAULT_STATUSES } };
    if (from || to) {
      match["header.voucherDate"] = {};
      if (from) match["header.voucherDate"].$gte = from;
      if (to) match["header.voucherDate"].$lte = to;
    }

    const searchClause = buildSearchClause(req.query.search);
    const filter = searchClause ? { $and: [match, searchClause] } : match;

    const [total, docs] = await Promise.all([
      Model.countDocuments(filter),
      Model.find(filter)
        .sort({ "header.voucherDate": -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    const data = docs.map((doc) => ({
      voucherNo: doc.header?.voucherNo || null,
      voucherDate: doc.header?.voucherDate || null,
      partyName: doc.header?.partyName || null,
      amount: doc.header?.voucherTotalAmount ?? null,
      tallyGuid: doc.tallyGuid || null,
      voucherStatus: doc.voucherStatus,
      updatedAt: doc.updatedAt,
    }));

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    });
  } catch (error) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    if (status === 500) console.error("VOUCHER LIST ERROR:", error);

    return res.status(status).json({
      success: false,
      message: status === 500 ? "Something went wrong on the server. Please try again." : error.message,
    });
  }
}

const listSalesVouchers = (req, res) => listVouchers(Sale, req, res);
const listPurchaseVouchers = (req, res) => listVouchers(Purchase, req, res);

module.exports = { listSalesVouchers, listPurchaseVouchers };
