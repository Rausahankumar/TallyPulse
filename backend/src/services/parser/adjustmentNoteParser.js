const {
  unwrapJsonExValue,
  safeString,
  findCollectionByKeywords,
  parseTallyDate,
  parseQuantity,
  parseRate,
  parseAmount,
  parseTallyId,
  parseTallyBoolean,
  computePartyLedgerTotal,
} = require("./tallyParser");

// --------------------------------------------------
// Credit Note / Debit Note parsing. A SEPARATE parser from
// tallyParser.parseTallyVoucher (not a modification of it) - Sales/Purchase
// stay on the exact code path already proven against 5,929 real vouchers.
// Reuses the same JSONEx unwrap/collection-finding helpers.
//
// The one thing Sales/Purchase parsing does not need and this does: for
// every inventory line, the ledger it is booked to (accountingallocations),
// and for every ledger line, its bill allocations (billallocations) - this
// is what lets adjustmentNoteClassifier tell a real sales/purchase return
// apart from a value adjustment, per the CN/DN diagnostic
// (docs/../generic-tumbling-magpie.md sections 2-3). Native Method on the
// Tally request (odbcService.getAdjustmentNoteVouchersSinceAlterId) asks
// for exactly these fields and nothing else - not the ~223-field full
// voucher dump the diagnostic used to discover them.
// --------------------------------------------------

function findInventoryEntries(voucher) {
  return (
    findCollectionByKeywords(voucher, ["inventory"]).find(
      (entries) => Array.isArray(entries) && entries.some((e) => e && typeof e === "object" && ("stockitemname" in e || "stockItemName" in e))
    ) || findCollectionByKeywords(voucher, ["inventoryentries", "allinventoryentries"]).find((e) => Array.isArray(e)) || []
  );
}

function findLedgerEntries(voucher) {
  return (
    findCollectionByKeywords(voucher, ["ledger"]).find(
      (entries) => Array.isArray(entries) && entries.some((e) => e && typeof e === "object" && ("ledgername" in e || "ledgerName" in e))
    ) || findCollectionByKeywords(voucher, ["ledgerentries", "allledgerentries"]).find((e) => Array.isArray(e)) || []
  );
}

// The single ledger an inventory line's amount is booked against. A line
// can in principle carry more than one accounting allocation (a split); the
// diagnostic's 15 sampled real vouchers never showed this, but if Tally
// ever returns more than one, the line is treated as having NO single
// resolvable ledger (classification below falls back to value_adjustment
// rather than guessing which allocation is authoritative).
function parseAccountingAllocations(rawEntry) {
  const raw = unwrapJsonExValue(rawEntry && (rawEntry.accountingallocations ?? rawEntry.accountingAllocations));
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((a) => a && typeof a === "object")
    .map((a) => ({
      ledgerName: safeString(a.ledgername ?? a.ledgerName).trim(),
      amount: parseAmount(a.amount),
    }))
    .filter((a) => a.ledgerName);
}

function parseBillAllocations(rawEntry) {
  const raw = unwrapJsonExValue(rawEntry && (rawEntry.billallocations ?? rawEntry.billAllocations));
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((b) => b && typeof b === "object")
    .map((b) => ({
      name: safeString(b.name).trim(),
      billType: safeString(b.billtype ?? b.billType).trim(),
      amount: parseAmount(b.amount),
    }))
    .filter((b) => b.name);
}

function parseAdjustmentNoteVoucher(voucher) {
  if (!voucher || typeof voucher !== "object" || Array.isArray(voucher)) {
    throw new Error("parseAdjustmentNoteVoucher expected a raw Tally voucher object, but received a non-object value.");
  }

  const metadata = voucher.metadata && typeof voucher.metadata === "object" ? voucher.metadata : {};

  const inventory = findInventoryEntries(voucher)
    .filter((e) => e && typeof e === "object")
    .map((entry) => {
      const quantityInfo = parseQuantity(entry.actualqty ?? entry.billedqty ?? entry.quantity ?? entry.qty);
      const rateInfo = parseRate(entry.rate);
      const amount = parseAmount(entry.amount);
      const itemName = safeString(entry.stockitemname ?? entry.stockItemName ?? entry.name).trim();
      const allocations = parseAccountingAllocations(entry);

      return {
        itemName,
        quantity: quantityInfo.quantity ?? 0,
        rate: rateInfo.rate ?? 0,
        amount,
        // Single resolvable allocation ledger, or null (mixed/none/unclear -
        // classification never guesses which one is authoritative).
        accountingAllocationLedger: allocations.length === 1 ? allocations[0].ledgerName : null,
      };
    })
    .filter((entry) => entry.itemName || entry.amount || entry.quantity);

  const ledgers = findLedgerEntries(voucher)
    .filter((e) => e && typeof e === "object")
    .map((entry) => {
      const ledgerName = safeString(entry.ledgername ?? entry.ledgerName).trim();
      if (!ledgerName) return null;
      const ledgerAmount = parseAmount(entry.amount ?? entry.ledgerAmount);
      const isDeemedPositive = entry.isdeemedpositive ?? entry.isDeemedPositive;
      const billAllocations = parseBillAllocations(entry);

      return {
        ledgerName,
        ledgerAmount,
        entryType: isDeemedPositive === undefined || isDeemedPositive === null ? (ledgerAmount >= 0 ? "Credit" : "Debit") : parseTallyBoolean(isDeemedPositive) ? "Credit" : "Debit",
        isPartyLedger: parseTallyBoolean(entry.ispartyledger ?? entry.isPartyLedger),
        billAllocations,
      };
    })
    .filter(Boolean);

  const partyName = safeString(voucher.partyname || voucher.partyledgername || voucher.basicbuyername || "").trim();

  // Original-invoice linkage: ONLY the "Agst Ref" bill allocation on the
  // party ledger line, exactly as Tally records it - never inferred from
  // voucher number, date, party or amount proximity (per the diagnostic:
  // most notes have no reliable linkage, and guessing one would be worse
  // than none). null when absent, by design.
  const partyLedger = ledgers.find((l) => l.isPartyLedger) || ledgers.find((l) => l.ledgerName === partyName) || null;
  const againstRef = partyLedger ? partyLedger.billAllocations.find((b) => b.billType === "Agst Ref") : null;

  // Same total convention as tallyParser.parseTallyVoucher: the party
  // ledger's own amount IS the voucher total in a balanced voucher.
  // Falls back to the inventory subtotal only when no party ledger line
  // matches (never a fabricated 0).
  const inventoryTotal = inventory.reduce((sum, item) => sum + Math.abs(Number(item.amount || 0)), 0);
  const partyLedgerTotal = computePartyLedgerTotal(ledgers, partyName);
  const voucherTotalAmount = partyLedgerTotal !== null ? partyLedgerTotal : inventoryTotal;

  const sync = {
    guid: safeString(voucher.guid ?? metadata.remoteid).trim() || null,
    alterId: parseTallyId(voucher.alterid ?? voucher.alterId),
    isCancelled: parseTallyBoolean(voucher.iscancelled ?? voucher.isCancelled),
    isDeleted: parseTallyBoolean(voucher.isdeleted ?? voucher.isDeleted),
  };

  return {
    header: {
      voucherNo: safeString(voucher.vouchernumber ?? voucher.voucherNumber).trim(),
      voucherDate: parseTallyDate(voucher.date) || parseTallyDate(voucher.effectivedate),
      voucherType: safeString(metadata.vchtype || voucher.vouchertypename).trim() || null,
      voucherTotalAmount,
      narration: safeString(voucher.narration).trim(),
      partyName,
    },
    inventory,
    ledgers,
    originalVoucherNumber: againstRef ? againstRef.name : null,
    sync,
  };
}

module.exports = { parseAdjustmentNoteVoucher };
