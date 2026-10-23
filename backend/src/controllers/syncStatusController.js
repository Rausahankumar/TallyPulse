const Sale = require("../models/sales.model");
const Purchase = require("../models/purchase.model");
const SyncCheckpoint = require("../models/syncCheckpoint.model");
const ReconciliationCheckpoint = require("../models/reconciliationCheckpoint.model");
const { resolveTenantContext } = require("../services/import/tallySalesImport");

const RECENT_LIMIT = 10;

function serializeCheckpoint(doc) {
  if (!doc) return null;
  return {
    lastAlterId: doc.lastAlterId,
    lastSyncedAt: doc.lastSyncedAt,
    lastRunStatus: doc.lastRunStatus,
    lastError: doc.lastError,
    isRunning: doc.isRunning,
  };
}

function serializeReconciliation(doc) {
  if (!doc) return null;
  return {
    lastRunAt: doc.lastRunAt,
    lastRunStatus: doc.lastRunStatus,
    lastError: doc.lastError,
    lastTallyGuidCount: doc.lastTallyGuidCount,
    lastMongoActiveCount: doc.lastMongoActiveCount,
    lastMarkedDeletedCount: doc.lastMarkedDeletedCount,
    isRunning: doc.isRunning,
  };
}

function serializeVoucher(doc) {
  return {
    voucherNo: doc.header?.voucherNo || null,
    voucherDate: doc.header?.voucherDate || null,
    partyName: doc.header?.partyName || null,
    amount: doc.header?.voucherTotalAmount ?? null,
    tallyGuid: doc.tallyGuid || null,
    tallyAlterId: doc.tallyAlterId ?? null,
    voucherStatus: doc.voucherStatus,
    updatedAt: doc.updatedAt,
  };
}

// --------------------------------------------------
// Real backend data for the Sync & Data page (docs §5.1/§16 previously
// had no REST endpoint exposing SyncCheckpoint/ReconciliationCheckpoint
// or the actual synced records - only the cron workers wrote them
// internally). This is that endpoint: everything returned here is read
// straight from MongoDB for the caller's own tenant (re-derived from
// their JWT's companyGuId via resolveTenantContext, never trusted
// directly), nothing sample or fabricated. A checkpoint that doesn't
// exist yet (this tenant's worker hasn't run) comes back as `null`,
// not a fake "never run" placeholder object - the frontend renders
// that as an honest "not synced yet" state.
// --------------------------------------------------
const getSyncStatus = async (req, res) => {
  try {
    const companyGuId = req.user?.companyGuId;

    if (!companyGuId) {
      return res.status(401).json({
        success: false,
        message: "Company GUID is missing from authentication token.",
      });
    }

    const { tenantId } = await resolveTenantContext(companyGuId);

    const [
      salesCheckpoint,
      purchaseCheckpoint,
      salesReconciliation,
      purchaseReconciliation,
      recentSales,
      recentPurchases,
      totalSales,
      totalPurchases,
    ] = await Promise.all([
      SyncCheckpoint.findOne({ tenantId, voucherType: "Sales" }).lean(),
      SyncCheckpoint.findOne({ tenantId, voucherType: "Purchase" }).lean(),
      ReconciliationCheckpoint.findOne({ tenantId, voucherType: "Sales" }).lean(),
      ReconciliationCheckpoint.findOne({ tenantId, voucherType: "Purchase" }).lean(),
      Sale.find({ tenantId }).sort({ updatedAt: -1 }).limit(RECENT_LIMIT).lean(),
      Purchase.find({ tenantId }).sort({ updatedAt: -1 }).limit(RECENT_LIMIT).lean(),
      Sale.countDocuments({ tenantId }),
      Purchase.countDocuments({ tenantId }),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        incremental: {
          sales: serializeCheckpoint(salesCheckpoint),
          purchase: serializeCheckpoint(purchaseCheckpoint),
        },
        reconciliation: {
          sales: serializeReconciliation(salesReconciliation),
          purchase: serializeReconciliation(purchaseReconciliation),
        },
        recentSales: recentSales.map(serializeVoucher),
        recentPurchases: recentPurchases.map(serializeVoucher),
        totalSales,
        totalPurchases,
      },
    });
  } catch (error) {
    const known = error.message === "Company not found." || error.message === "Company is inactive.";

    if (!known) console.error("SYNC STATUS ERROR:", error);

    return res.status(known ? 404 : 500).json({
      success: false,
      message: known ? error.message : "Something went wrong on the server. Please try again.",
    });
  }
};

module.exports = { getSyncStatus };
