function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function parseTallyDate(rawDate) {
  if (!rawDate) return null;

  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    return rawDate;
  }

  const dateString = safeString(rawDate).trim();
  if (!dateString) return null;

  if (/^\d{8}$/.test(dateString)) {
    const year = Number(dateString.slice(0, 4));
    const month = Number(dateString.slice(4, 6)) - 1;
    const day = Number(dateString.slice(6, 8));

    const parsed = new Date(Date.UTC(year, month, day));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(dateString);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseQuantity(value) {
  if (value === undefined || value === null || value === '') {
    return { quantity: null, unit: null };
  }

  const text = safeString(value).trim();
  if (!text) {
    return { quantity: null, unit: null };
  }

  const match = text.match(/^([-+]?\d*\.?\d+(?:e[+-]?\d+)?)\s*([^\d\s].*)?$/i);

  if (!match) {
    return { quantity: null, unit: null };
  }

  const numericValue = Number(match[1]);
  const unit = match[2] ? match[2].trim() : '';

  return {
    quantity: Number.isFinite(numericValue) ? numericValue : null,
    unit: unit || null,
  };
}

function parseRate(value) {
  if (value === undefined || value === null || value === '') {
    return { rate: null, rateUnit: null };
  }

  const text = safeString(value).trim();
  if (!text) {
    return { rate: null, rateUnit: null };
  }

  const normalized = text.replace(/\s+/g, '');
  const match = normalized.match(/^([-+]?\d*\.?\d+(?:e[+-]?\d+)?)\/?([^/]+)?$/i);

  if (!match) {
    return { rate: null, rateUnit: null };
  }

  const numericValue = Number(match[1]);
  const rateUnit = match[2] ? match[2].trim() : null;

  return {
    rate: Number.isFinite(numericValue) ? numericValue : null,
    rateUnit: rateUnit || null,
  };
}

function parseAmount(value) {
  if (value === undefined || value === null || value === '') return 0;

  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  const text = safeString(value).trim();
  if (!text) return 0;

  const numeric = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

function parseTallyVoucher(voucher) {
  if (!isObject(voucher)) {
    throw new Error('parseTallyVoucher expected a raw Tally voucher object, but received a non-object value.');
  }

  const metadata = isObject(voucher.metadata) ? voucher.metadata : {};
  const inventoryEntries = Array.isArray(voucher.allinventoryentries) ? voucher.allinventoryentries : [];
  const ledgerKey = Object.keys(voucher).find((key) => /ledger/i.test(key) && /entry/i.test(key));
  const rawLedgerList = Array.isArray(voucher[ledgerKey]) ? voucher[ledgerKey] : [];

  const parsedInventory = inventoryEntries
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const quantityInfo = parseQuantity(entry.actualqty ?? entry.billedqty ?? entry.quantity);
      const rateInfo = parseRate(entry.rate);
      const amount = parseAmount(entry.amount);
      const discountAmount = parseAmount(entry.discountamount ?? 0);
      const discountPercentage = Number(entry.discountpercentage ?? 0);

      return {
        itemName: safeString(entry.stockitemname || entry.name).trim(),
        quantity: quantityInfo.quantity ?? 0,
        rate: rateInfo.rate ?? 0,
        amount,
        discountPercentage: Number.isFinite(discountPercentage) ? discountPercentage : 0,
        discountAmount,
      };
    });

  const parsedLedgers = rawLedgerList
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const ledgerAmount = parseAmount(entry.amount);

      return {
        ledgerName: safeString(entry.ledgername).trim(),
        ledgerAmount,
        entryType: ledgerAmount >= 0 ? 'Debit' : 'Credit',
      };
    });

  const voucherTotalAmount = parsedInventory.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  return {
    header: {
      voucherNo: safeString(voucher.vouchernumber).trim(),
      voucherDate: parseTallyDate(voucher.date) || parseTallyDate(voucher.effectivedate),
      voucherType: safeString(metadata.vchtype || voucher.vouchertypename || 'Sales').trim() || 'Sales',
      voucherTotalAmount,
      narration: safeString(voucher.narration || voucher.remarks || '').trim() || '',
      partyName: safeString(voucher.partyname || voucher.partyledgername || voucher.basicbuyername).trim(),
    },
    inventory: parsedInventory,
    ledgers: parsedLedgers,
  };
}

module.exports = {
  parseTallyVoucher,
  parseTallyDate,
  parseQuantity,
  parseRate,
  parseAmount,
};
