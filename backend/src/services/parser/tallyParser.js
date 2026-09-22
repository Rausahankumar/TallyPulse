function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Tally JSONEx sometimes wraps a field's real value instead of sending a
// plain primitive, e.g. { value: "...", taxtype: "GST" } or the
// [ { metadata: true, type: "String" }, "actual value" ] pair pattern used
// for UDF/list fields. Unwrap those shapes down to the underlying scalar
// before any parsing runs, so a field being wrapped never silently breaks
// downstream parsing.
function unwrapJsonExValue(value) {
  if (value === undefined || value === null) return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return value;

    const [first, second] = value;

    if (isObject(first) && first.metadata === true) {
      if (second === undefined) return first;
      return unwrapJsonExValue(isObject(second) && 'value' in second ? second.value : second);
    }

    return value;
  }

  if (isObject(value) && 'value' in value && !isObject(value.value) && !Array.isArray(value.value)) {
    return value.value;
  }

  return value;
}

function safeString(value) {
  const unwrapped = unwrapJsonExValue(value);
  if (unwrapped === undefined || unwrapped === null) return '';
  return String(unwrapped);
}

function normalizeLedgerEntryType(ledgerAmount, isDeemedPositive, explicitType) {
  const type = safeString(explicitType).trim().toLowerCase();
  if (type === 'debit' || type === 'credit') return type === 'debit' ? 'Debit' : 'Credit';

  if (isDeemedPositive !== undefined && isDeemedPositive !== null) {
    return isDeemedPositive ? 'Credit' : 'Debit';
  }

  return ledgerAmount >= 0 ? 'Credit' : 'Debit';
}

// The true voucher/invoice total: the absolute amount of the ledger
// entry(ies) whose ledgerName exactly matches partyName (a balanced
// voucher's party ledger line IS the full total - see the call site's
// comment for the audit evidence). Returns null (never a fabricated 0 or
// silently-wrong number) when no ledger entry matches, so the caller can
// apply its own defensive fallback for that edge case. Multiple entries
// under the exact same party name (not observed in real data so far, but
// possible in principle - e.g. a split-reference line) are summed
// BEFORE taking the absolute value, not summed as separate absolutes:
// this is the only behavior consistent with "the party's net position in
// this voucher," and is the specific behavior verify-tally-parser.js
// tests for that case documents and locks in.
function computePartyLedgerTotal(ledgers, partyName) {
  if (!partyName) return null;

  const entries = (Array.isArray(ledgers) ? ledgers : []).filter(
    (l) => l && l.ledgerName === partyName
  );

  if (entries.length === 0) return null;

  const net = entries.reduce((sum, l) => sum + Number(l.ledgerAmount || 0), 0);
  return Math.abs(net);
}

function findCollectionByKeywords(value, keywords) {
  const matches = [];
  const lowerKeywords = keywords.map((key) => String(key).toLowerCase());

  function isCollectionCandidate(key, child) {
    if (!Array.isArray(child)) return false;

    const lowerKey = String(key).toLowerCase();
    return lowerKeywords.some((keyword) => lowerKey.includes(keyword));
  }

  function walk(current) {
    if (!current || typeof current !== 'object') return;

    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }

    Object.entries(current).forEach(([key, child]) => {
      if (isCollectionCandidate(key, child)) {
        matches.push(child);
      }

      if (child && typeof child === 'object') {
        walk(child);
      }
    });
  }

  walk(value);
  return matches;
}

function parseTallyDate(rawDate) {
  const value = unwrapJsonExValue(rawDate);
  if (!value) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  const dateString = safeString(value).trim();
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

function parseQuantity(rawValue) {
  const value = unwrapJsonExValue(rawValue);
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

function parseRate(rawValue) {
  const value = unwrapJsonExValue(rawValue);
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

function parseAmount(rawValue) {
  const value = unwrapJsonExValue(rawValue);
  if (value === undefined || value === null || value === '') return 0;

  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  const text = safeString(value).trim();
  if (!text) return 0;

  const numeric = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : 0;
}

// Unlike parseAmount, returns null (not 0) when the id is genuinely absent,
// so callers can tell "no AlterID on this record" apart from "AlterID 0".
function parseTallyId(rawValue) {
  const value = unwrapJsonExValue(rawValue);
  if (value === undefined || value === null || value === '') return null;

  const text = safeString(value).trim();
  if (!text) return null;

  const numeric = Number(text.replace(/[^0-9-]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

// Tally Logical fields arrive either as a wrapped { type: "Logical", value }
// pair, a plain boolean, or (elsewhere in Tally's API) "Yes"/"No" text.
function parseTallyBoolean(rawValue) {
  const value = unwrapJsonExValue(rawValue);
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;

  const text = safeString(value).trim().toLowerCase();
  return text === 'yes' || text === 'true' || text === '1';
}

function parseTallyVoucher(voucher) {
  if (!isObject(voucher)) {
    throw new Error('parseTallyVoucher expected a raw Tally voucher object, but received a non-object value.');
  }

  const metadata = isObject(voucher.metadata) ? voucher.metadata : {};

  const inventoryEntries = findCollectionByKeywords(voucher, ['inventory']).find((entries) => Array.isArray(entries) && entries.some((entry) => isObject(entry) && (
    'stockitemname' in entry ||
    'stockItemName' in entry ||
    'itemName' in entry ||
    'name' in entry ||
    'stockitem' in entry
  ))) || findCollectionByKeywords(voucher, ['inventoryentries', 'allinventoryentries']).find((entries) => Array.isArray(entries)) || [];

  const rawLedgerEntries = findCollectionByKeywords(voucher, ['ledger']).find((entries) => Array.isArray(entries) && entries.some((entry) => isObject(entry) && (
    'ledgername' in entry ||
    'ledgerName' in entry ||
    'name' in entry
  ))) || findCollectionByKeywords(voucher, ['ledgerentries', 'allledgerentries']).find((entries) => Array.isArray(entries)) || [];

  const parsedInventory = (Array.isArray(inventoryEntries) ? inventoryEntries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const quantityInfo = parseQuantity(entry.actualqty ?? entry.billedqty ?? entry.quantity ?? entry.qty ?? entry.actualquantity);
      const rateInfo = parseRate(entry.rate ?? entry.unitrate ?? entry.rateperunit);
      const amount = parseAmount(entry.amount ?? entry.amountvalue ?? entry.value ?? 0);
      const discountAmount = parseAmount(entry.discountamount ?? entry.discountAmount ?? 0);
      const discountPercentage = Number(entry.discountpercentage ?? entry.discountPercentage ?? 0);

      const itemName = safeString(entry.stockitemname ?? entry.stockItemName ?? entry.itemName ?? entry.name ?? entry.stockitem).trim();

      return {
        itemName,
        quantity: quantityInfo.quantity ?? 0,
        rate: rateInfo.rate ?? 0,
        amount,
        discountPercentage: Number.isFinite(discountPercentage) ? discountPercentage : 0,
        discountAmount,
      };
    })
    .filter((entry) => entry.itemName || entry.amount || entry.quantity || entry.rate);

  const parsedLedgers = (Array.isArray(rawLedgerEntries) ? rawLedgerEntries : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const ledgerName = safeString(entry.ledgername ?? entry.ledgerName ?? entry.name).trim();
      if (!ledgerName) return null;

      const ledgerAmount = parseAmount(entry.amount ?? entry.ledgerAmount ?? entry.value ?? 0);
      const isDeemedPositive = entry.isdeemedpositive ?? entry.isDeemedPositive ?? entry.deemedPositive;

      return {
        ledgerName,
        ledgerAmount,
        entryType: normalizeLedgerEntryType(ledgerAmount, isDeemedPositive, entry.entryType),
      };
    })
    .filter(Boolean);

  // partyName is needed here (not just in the returned header below) to
  // locate the party ledger entry for voucherTotalAmount - hoisted out of
  // the final return object, same expression, unchanged.
  const partyName = safeString(voucher.partyname || voucher.partyledgername || voucher.basicbuyername || voucher.customerName || voucher.name || '').trim();

  const inventoryTotal = parsedInventory.reduce((sum, item) => sum + Number(item.amount || 0), 0);

  // Used only as a defensive fallback below, for a voucher shape the real
  // data audited so far never produced (see computePartyLedgerTotal).
  // Kept, not deleted, so an edge case that lacks a party-name-matching
  // ledger line still gets a best-effort total instead of 0 - never
  // silently 0 for a real voucher.
  const ledgerTotal = parsedLedgers.reduce((sum, item) => sum + Math.abs(Number(item.ledgerAmount || 0)), 0) / 2;

  // CORRECTED (financial-data-correctness audit): the true voucher/invoice
  // total is the party (customer/supplier) ledger entry's amount, not the
  // inventory subtotal. In a balanced Tally voucher the party ledger IS,
  // by definition, the full total - item subtotal + tax + freight +
  // rounding all net against it. Confirmed against 5,929 real vouchers
  // (both tenants, Sales + Purchase) with zero "party ledger not found"
  // cases, and independently verified to the paisa against a live Tally
  // Voucher Register export. The previous formula
  // (`inventoryTotal || ledgerTotal || 0`) used the pre-tax item subtotal
  // whenever any inventory existed, silently excluding GST/freight/
  // rounding from every affected voucher - see migrate-voucher-total-amount.js
  // for the backfill of historical documents already stored with the old,
  // wrong total.
  const partyLedgerTotal = computePartyLedgerTotal(parsedLedgers, partyName);
  const voucherTotalAmount = partyLedgerTotal !== null ? partyLedgerTotal : (inventoryTotal || ledgerTotal || 0);

  // Sync-identity fields. These are read directly off the raw voucher and
  // never throw, regardless of whether the header/inventory/ledger fields
  // above are complete — so a sparse record (e.g. a cancelled/deleted
  // voucher Tally returns with minimal data) still yields usable sync
  // flags even when it can't be fully mapped into a Sale document.
  const sync = {
    guid: safeString(voucher.guid ?? voucher.remoteid ?? metadata.remoteid ?? '').trim() || null,
    alterId: parseTallyId(voucher.alterid ?? voucher.alterId),
    isCancelled: parseTallyBoolean(voucher.iscancelled ?? voucher.isCancelled),
    // CONFIRMED (via live probe): $IsCancelled and $AlterID are real,
    // queryable fields. UNVERIFIED: whether $IsDeleted ever actually
    // becomes true for a genuinely deleted voucher in this Tally version/
    // config, or what shape the record has when it does — Tally returns
    // isdeleted:false by default on every normal voucher, which is
    // evidence the field is meaningful, but this hasn't been observed
    // going true against a real deletion. Treated defensively: if it ever
    // is true, the mapper marks the Sale doc "deleted" (never removes it).
    isDeleted: parseTallyBoolean(voucher.isdeleted ?? voucher.isDeleted),
  };

  return {
    header: {
      voucherNo: safeString(voucher.vouchernumber ?? voucher.voucherNumber ?? '').trim(),
      voucherDate: parseTallyDate(voucher.date) || parseTallyDate(voucher.effectivedate),
      voucherType: safeString(metadata.vchtype || voucher.vouchertypename || voucher.voucherType || 'Sales').trim() || 'Sales',
      voucherTotalAmount,
      narration: safeString(voucher.narration || voucher.remarks || voucher.voucherNarration || '').trim() || '',
      partyName,
    },
    inventory: parsedInventory,
    ledgers: parsedLedgers,
    sync,
  };
}

// Extracts {name, guid} for every company object Tally's "Type": "Company"
// collection currently reports (odbcService.getCompanyInfo's raw response
// shape: {status, data:{collection:[{name:{value},guid:{value},...}]}}).
// Real identities only, straight off Tally's own response - never invents
// or approximates a guid when one isn't present.
function extractOpenCompanies(rawTallyResponse) {
  const collection = rawTallyResponse?.data?.collection;
  if (!Array.isArray(collection)) return [];

  return collection
    .map((entry) => ({
      name: safeString(entry?.name).trim(),
      guid: safeString(entry?.guid).trim(),
    }))
    .filter((company) => company.guid);
}

module.exports = {
  parseTallyVoucher,
  extractOpenCompanies,
  parseTallyDate,
  parseQuantity,
  parseRate,
  parseAmount,
  parseTallyId,
  parseTallyBoolean,
  unwrapJsonExValue,
  computePartyLedgerTotal,
};
