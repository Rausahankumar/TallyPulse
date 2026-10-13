function ensureObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a non-null object.`);
  }
  return value;
}

function toNumber(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeVoucherType(voucherType) {
  const value = String(voucherType || '').trim();
  return value || 'Sales';
}

function mapTallySale(parsedVoucher, context = {}) {
  ensureObject(parsedVoucher, 'parsedVoucher');

  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new Error('mapTallySale requires a context object with tenantId.');
  }

  const tenantId = context.tenantId;
  if (!tenantId) {
    throw new Error('mapTallySale requires context.tenantId. Do not invent a tenantId from Tally data.');
  }

  const headerInput = ensureObject(parsedVoucher.header || {}, 'parsedVoucher.header');
  const inventory = Array.isArray(parsedVoucher.inventory) ? parsedVoucher.inventory : [];
  const ledgers = Array.isArray(parsedVoucher.ledgers) ? parsedVoucher.ledgers : [];

  const header = {
    voucherNo: String(headerInput.voucherNo || '').trim(),
    voucherDate: headerInput.voucherDate || null,
    voucherType: normalizeVoucherType(headerInput.voucherType),
    voucherTotalAmount: toNumber(headerInput.voucherTotalAmount, 0),
    narration: String(headerInput.narration || '').trim(),
    partyName: String(headerInput.partyName || '').trim(),
  };

  if (!header.voucherNo) {
    throw new Error('Mapped sale is missing header.voucherNo.');
  }

  if (!header.voucherDate) {
    throw new Error('Mapped sale is missing header.voucherDate.');
  }

  if (!header.partyName) {
    throw new Error('Mapped sale is missing header.partyName.');
  }

  const mappedInventory = inventory.map((item) => {
    const itemName = String(item && item.itemName ? item.itemName : '').trim();
    if (!itemName) {
      throw new Error('Mapped sale contains an inventory item without an itemName.');
    }

    return {
      itemName,
      quantity: toNumber(item.quantity, 0),
      rate: toNumber(item.rate, 0),
      amount: toNumber(item.amount, 0),
      discountPercentage: toNumber(item.discountPercentage, 0),
      discountAmount: toNumber(item.discountAmount, 0),
      // Already normalised by the parser (gstFields.parseVoucherLineGst); passed through untouched.
      ...(item.gst && typeof item.gst === 'object' ? { gst: item.gst } : {}),
    };
  });

  const mappedLedgers = ledgers.map((entry) => {
    const ledgerName = String(entry && (entry.ledgerName || entry.ledgername || entry.name) ? (entry.ledgerName || entry.ledgername || entry.name) : '').trim();
    if (!ledgerName) {
      throw new Error('Mapped sale contains a ledger entry without a ledgerName.');
    }

    const ledgerAmount = toNumber(entry.ledgerAmount ?? entry.amount ?? 0, 0);
    const explicitType = String(entry.entryType || entry.type || '').trim();
    const normalizedEntryType = explicitType === 'Debit' || explicitType === 'Credit'
      ? explicitType
      : (ledgerAmount >= 0 ? 'Credit' : 'Debit');

    return {
      ledgerName,
      ledgerAmount,
      entryType: normalizedEntryType,
    };
  });

  const sync = ensureObject(parsedVoucher.sync || {}, 'parsedVoucher.sync');

  // isDeleted takes precedence over isCancelled when (in principle) both
  // could be set. See tallyParser.js for what's confirmed vs. unverified
  // about $IsDeleted.
  const voucherStatus = sync.isDeleted
    ? 'deleted'
    : sync.isCancelled
      ? 'cancelled'
      : 'active';

  return {
    tenantId,
    header,
    inventory: mappedInventory,
    ledgers: mappedLedgers,
    tallyGuid: sync.guid || null,
    tallyAlterId: sync.alterId ?? null,
    voucherStatus,
  };
}

module.exports = {
  mapTallySale,
  normalizeVoucherType,
};
