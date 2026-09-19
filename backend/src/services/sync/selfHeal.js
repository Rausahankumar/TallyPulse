const SyncCheckpoint = require("../../models/syncCheckpoint.model");
const { recoverMissingVouchers } = require("./voucherRecovery");

// --------------------------------------------------
// Self-heal for "checkpoint advanced, data gone".
//
// The incremental sync only asks Tally for vouchers newer than its
// checkpoint, so vouchers whose MongoDB documents disappear (manual delete,
// restore from an older backup, ...) behind the checkpoint are never fetched
// again. voucherRecovery.js repairs that; this file decides WHEN it is safe to
// run it unattended.
//
// It is called from the reconciliation worker, right after a reconciliation
// pass that SUCCEEDED, because at that point everything a repair depends on
// has just been established: the company open in Tally is this tenant's
// company, the voucher-type classification resolved, Tally answered with a
// usable GUID list, and this {tenant, voucher type} is locked against a
// concurrent run. Nothing here re-implements recovery: it calls
// recoverMissingVouchers, which re-checks the company guard, reads its own
// light registry, skips cancelled/deleted vouchers, requires a complete Tally
// fetch before writing, upserts by {tenantId, tallyGuid} and never touches
// SyncCheckpoint.
//
// Gates, all cheap (no Tally call) except the last:
//   1. reconciliation succeeded (a failed/unsafe/skipped pass repairs nothing)
//   2. exact GUID difference: the GUID set Tally just reported minus the GUIDs
//      MongoDB holds for this tenant and voucher type (any status, so a
//      voucher reconciliation marked deleted is not "missing"). Counts are
//      never compared - only identities. No missing GUID = nothing to do and
//      no further Tally query. Tally's list also contains cancelled vouchers,
//      which are never stored, so the candidates can include permanent
//      non-candidates; the recovery pass below reads Tally's cancelled flag
//      and settles it exactly.
//   3. SyncCheckpoint.lastAlterId > 0 - a company still on its first sync is
//      the normal sync's job, not a mismatch
//   4. cooldown after a no-op/failed/refused attempt, so the same gap is not
//      re-checked against Tally every reconciliation tick. A partial repair
//      (progress made, more to do) is NOT cooled down and continues next tick.
//   5. recoverMissingVouchers, scoped to AlterID <= the sync checkpoint (what
//      the normal sync will never fetch), bounded batches per tick, and
//      refusing to auto-repair an unreasonably large gap.
// --------------------------------------------------

const DEFAULT_CONFIG = {
  enabled: process.env.SELF_HEAL_ENABLED !== "false",
  cooldownMinutes: Number(process.env.SELF_HEAL_COOLDOWN_MINUTES) || 360,
  maxBatches: Number(process.env.SELF_HEAL_MAX_BATCHES) || 3,
  // undefined = the same batch size the incremental sync uses
  batchSize: Number(process.env.SELF_HEAL_BATCH_SIZE) || undefined,
  maxAutoRecover: Number(process.env.SELF_HEAL_MAX_AUTO_RECOVER) || 20000,
};

// Outcomes that put this {tenant, voucher type} on cooldown.
const COOLDOWN_OUTCOMES = new Set(["noop", "failed", "aborted"]);

function skip(reason) {
  return { attempted: false, skipReason: reason, update: {} };
}

/**
 * @param {Object} params
 * @param {Object} params.company - Company document (tenantId, companyGuid, ...)
 * @param {string} params.voucherType - "Sales" | "Purchase"
 * @param {import('mongoose').Model} params.Model - Sale or Purchase
 * @param {Object} params.reconcileResult - result of reconcileVoucherType
 * @param {Object} [params.checkpoint] - the ReconciliationCheckpoint document
 *   (carries the repair marker from the previous attempt)
 * @param {Object} [params.config]
 * @param {Object} [params.deps] - { recover, SyncCheckpointModel, now }
 * @returns {Promise<{attempted: boolean, skipReason?: string, outcome?: string,
 *   result?: Object, update: Object}>} `update` holds the repair-marker fields
 *   for the caller to persist with the reconciliation result. Never throws.
 */
async function maybeSelfHeal({
  company,
  voucherType,
  Model,
  reconcileResult,
  checkpoint,
  config = {},
  deps = {},
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const recover = deps.recover || recoverMissingVouchers;
  const SyncCheckpointModel = deps.SyncCheckpointModel || SyncCheckpoint;
  const now = deps.now ? deps.now() : new Date();

  try {
    if (!cfg.enabled) return skip("disabled");

    if (!reconcileResult || reconcileResult.status !== "success") {
      return skip("reconciliation_not_successful");
    }

    const tallyGuids = reconcileResult.tallyGuids;

    if (!(tallyGuids instanceof Set) || tallyGuids.size === 0) return skip("no_tally_vouchers");
    if (!company || !company.tenantId || !Model) return skip("no_tenant_scope");

    // One query, this tenant only.
    const heldDocs = await Model.find({
      tenantId: company.tenantId,
      tallyGuid: { $type: "string" },
    })
      .select("tallyGuid")
      .lean();
    const held = new Set(heldDocs.map((d) => d.tallyGuid));

    let candidates = 0;
    for (const guid of tallyGuids) {
      if (!held.has(guid)) candidates += 1;
    }

    if (candidates === 0) return skip("no_missing_guids");

    const syncCheckpoint = await SyncCheckpointModel.findOne({
      tenantId: company.tenantId,
      companyGuid: company.companyGuid,
      voucherType,
    }).lean();

    if (!syncCheckpoint || !(syncCheckpoint.lastAlterId > 0)) {
      return skip("checkpoint_not_advanced");
    }

    const lastAttemptAt = checkpoint && checkpoint.selfHealLastAttemptAt;
    const lastOutcome = checkpoint && checkpoint.selfHealLastOutcome;

    if (
      lastAttemptAt &&
      COOLDOWN_OUTCOMES.has(lastOutcome) &&
      now.getTime() - new Date(lastAttemptAt).getTime() < cfg.cooldownMinutes * 60 * 1000
    ) {
      return skip("cooldown");
    }

    const result = await recover({
      company,
      voucherType,
      apply: true,
      maxBatches: cfg.maxBatches,
      batchSize: cfg.batchSize,
      upToAlterId: syncCheckpoint.lastAlterId,
      maxMissing: cfg.maxAutoRecover,
    });

    let outcome;

    if (result.status === "aborted") outcome = "aborted";
    else if (result.found === 0) outcome = "noop";
    else if (result.status === "completed") outcome = "completed";
    else if (result.status === "partial") outcome = "partial";
    else outcome = "failed";

    return {
      attempted: true,
      outcome,
      result,
      candidates,
      update: {
        selfHealLastAttemptAt: now,
        selfHealLastOutcome: outcome,
        selfHealLastRecovered: result.recovered || 0,
        selfHealLastRemaining: result.remainingMissing || 0,
        selfHealLastReason: result.reason || null,
      },
    };
  } catch (error) {
    return {
      attempted: true,
      outcome: "failed",
      result: null,
      update: {
        selfHealLastAttemptAt: now,
        selfHealLastOutcome: "failed",
        selfHealLastRecovered: 0,
        selfHealLastRemaining: null,
        selfHealLastReason: error && error.message ? error.message : "Self-heal failed.",
      },
    };
  }
}

module.exports = { maybeSelfHeal, DEFAULT_CONFIG };
