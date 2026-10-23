function ensureObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a non-null object.`);
  }
  return value;
}

/**
 * @param {Object} parsedVoucher - from adjustmentNoteParser.parseAdjustmentNoteVoucher
 * @param {Object} context
 * @param {string} context.tenantId
 * @param {string} context.companyGuid
 * @param {"credit"|"debit"} context.noteType
 * @param {"sales_return"|"purchase_return"|"value_adjustment"|"unclassified"} context.classification
 */
function mapAdjustmentNote(parsedVoucher, context = {}) {
  ensureObject(parsedVoucher, "parsedVoucher");
  ensureObject(context, "context");

  const { tenantId, companyGuid, noteType, classification } = context;
  if (!tenantId) throw new Error("mapAdjustmentNote requires context.tenantId. Do not invent a tenantId from Tally data.");
  if (!companyGuid) throw new Error("mapAdjustmentNote requires context.companyGuid.");
  if (noteType !== "credit" && noteType !== "debit") throw new Error("mapAdjustmentNote requires context.noteType of 'credit' or 'debit'.");
  if (!classification) throw new Error("mapAdjustmentNote requires context.classification (resolved by adjustmentNoteClassifier before mapping).");

  const headerInput = ensureObject(parsedVoucher.header || {}, "parsedVoucher.header");
  const inventory = Array.isArray(parsedVoucher.inventory) ? parsedVoucher.inventory : [];
  const ledgers = Array.isArray(parsedVoucher.ledgers) ? parsedVoucher.ledgers : [];

  const header = {
    voucherNo: String(headerInput.voucherNo || "").trim(),
    voucherDate: headerInput.voucherDate || null,
    voucherType: String(headerInput.voucherType || "").trim(),
    voucherTotalAmount: Number.isFinite(headerInput.voucherTotalAmount) ? headerInput.voucherTotalAmount : 0,
    narration: String(headerInput.narration || "").trim(),
    partyName: String(headerInput.partyName || "").trim(),
  };

  if (!header.voucherNo) throw new Error("Mapped adjustment note is missing header.voucherNo.");
  if (!header.voucherDate) throw new Error("Mapped adjustment note is missing header.voucherDate.");
  if (!header.voucherType) throw new Error("Mapped adjustment note is missing header.voucherType.");
  if (!header.partyName) throw new Error("Mapped adjustment note is missing header.partyName.");

  const mappedInventory = inventory.map((item) => {
    const itemName = String((item && item.itemName) || "").trim();
    if (!itemName) throw new Error("Mapped adjustment note contains an inventory item without an itemName.");
    return {
      itemName,
      quantity: Number.isFinite(item.quantity) ? item.quantity : 0,
      rate: Number.isFinite(item.rate) ? item.rate : 0,
      amount: Number.isFinite(item.amount) ? item.amount : 0,
      accountingAllocationLedger: item.accountingAllocationLedger || null,
    };
  });

  const mappedLedgers = ledgers.map((entry) => {
    const ledgerName = String((entry && entry.ledgerName) || "").trim();
    if (!ledgerName) throw new Error("Mapped adjustment note contains a ledger entry without a ledgerName.");
    const ledgerAmount = Number.isFinite(entry.ledgerAmount) ? entry.ledgerAmount : 0;
    const entryType = entry.entryType === "Debit" || entry.entryType === "Credit" ? entry.entryType : ledgerAmount >= 0 ? "Credit" : "Debit";
    return { ledgerName, ledgerAmount, entryType };
  });

  const sync = ensureObject(parsedVoucher.sync || {}, "parsedVoucher.sync");
  const voucherStatus = sync.isDeleted ? "deleted" : sync.isCancelled ? "cancelled" : "active";

  return {
    tenantId,
    companyGuid,
    header,
    noteType,
    classification,
    inventory: mappedInventory,
    ledgers: mappedLedgers,
    originalVoucherNumber: parsedVoucher.originalVoucherNumber || null,
    tallyGuid: sync.guid || null,
    tallyAlterId: sync.alterId ?? null,
    voucherStatus,
  };
}

module.exports = { mapAdjustmentNote };
