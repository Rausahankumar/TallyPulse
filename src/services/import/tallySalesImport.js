const fs = require('fs');
const path = require('path');

const Company = require('../../models/company');
const Sale = require('../../models/sales.model');
const { parseTallyVoucher } = require('../parser/tallyParser');
const { mapTallySale } = require('../mapper/salesMapper');

const TEST_COMPANY_NAME = 'Nirmal FMCG Traders Ltd';
const TEST_COMPANY_GUID = 'tallypulse-test-company-nirmal-fmcg-traders';
const TEST_TENANT_ID = '507f1f77bcf86cd799439011';

function extractVoucherCollection(payload) {
  if (!payload) return [];

  if (Array.isArray(payload)) return payload;

  if (typeof payload !== 'object') return [];

  const collection = payload.tallymessage || payload.vouchers || payload.voucher;
  if (Array.isArray(collection)) return collection;

  return [payload];
}

async function getOrCreateTestCompany() {
  let company = await Company.findOne({
    name: TEST_COMPANY_NAME,
    sourceType: 'tally',
    companyGuid: TEST_COMPANY_GUID,
  }).lean();

  if (company) {
    return company;
  }

  company = await Company.create({
    name: TEST_COMPANY_NAME,
    tenantId: TEST_TENANT_ID,
    sourceType: 'tally',
    companyGuid: TEST_COMPANY_GUID,
    isActive: true,
  });

  return company.toObject();
}

async function processSingleVoucher(voucher, tenantId) {
  const voucherNo = voucher && voucher.vouchernumber ? voucher.vouchernumber : null;

  try {
    if (!voucher || typeof voucher !== 'object') {
      throw new Error('Voucher entry is not an object.');
    }

    const parsedVoucher = parseTallyVoucher(voucher);
    const mappedSale = mapTallySale(parsedVoucher, { tenantId });

    const validationError = new Sale(mappedSale).validateSync();
    if (validationError) {
      throw new Error(`Mongoose validation failed: ${validationError.message}`);
    }

    const resolvedVoucherNo = mappedSale.header && mappedSale.header.voucherNo
      ? mappedSale.header.voucherNo
      : voucherNo;

    const existingSale = await Sale.findOne({
      tenantId,
      'header.voucherNo': resolvedVoucherNo,
    }).lean();

    if (existingSale) {
      return {
        created: false,
        duplicate: true,
        message: `Sale already exists for tenantId ${tenantId} and voucherNo ${resolvedVoucherNo}`,
        sale: existingSale,
        saleId: existingSale && existingSale._id ? String(existingSale._id) : null,
        tenantId,
        voucherNo: resolvedVoucherNo,
        status: 'duplicate',
      };
    }

    const savedSale = await new Sale(mappedSale).save();

    return {
      created: true,
      duplicate: false,
      message: 'Sale imported successfully',
      sale: savedSale.toObject(),
      saleId: savedSale && savedSale._id ? String(savedSale._id) : null,
      tenantId,
      voucherNo: resolvedVoucherNo,
      status: 'created',
    };
  } catch (error) {
    const message = error && error.message ? error.message : 'Unknown voucher import error';

    return {
      created: false,
      duplicate: false,
      message,
      sale: null,
      saleId: null,
      tenantId,
      voucherNo,
      status: 'failed',
      error: message,
    };
  }
}

async function importTallySales({ filePath, rawData } = {}) {
  const targetPath = filePath || path.resolve(__dirname, '../../../sample-data/tally-sales.json');

  let parsedPayload;
  try {
    if (rawData !== undefined) {
      parsedPayload = rawData;
    } else {
      const rawText = fs.readFileSync(targetPath, 'utf8');
      parsedPayload = JSON.parse(rawText);
    }
  } catch (error) {
    throw new Error(`Invalid JSON in Tally file: ${error.message}`);
  }

  const vouchers = extractVoucherCollection(parsedPayload);
  if (!vouchers.length) {
    throw new Error('No Tally voucher data found in the uploaded JSON file.');
  }

  let company;
  try {
    company = await getOrCreateTestCompany();
  } catch (error) {
    throw new Error(`Company context setup failed: ${error.message}`);
  }

  const tenantId = company.tenantId;

  if (vouchers.length === 1) {
    const singleResult = await processSingleVoucher(vouchers[0], tenantId);
    if (singleResult.status === 'failed') {
      throw new Error(singleResult.message);
    }
    return singleResult;
  }

  const summary = {
    total: vouchers.length,
    created: 0,
    duplicates: 0,
    failed: 0,
    results: [],
  };

  for (const voucher of vouchers) {
    const result = await processSingleVoucher(voucher, tenantId);

    if (result.status === 'created') {
      summary.created += 1;
    } else if (result.status === 'duplicate') {
      summary.duplicates += 1;
    } else {
      summary.failed += 1;
    }

    summary.results.push({
      voucherNo: result.voucherNo || null,
      status: result.status,
      ...(result.message ? { message: result.message } : {}),
      ...(result.saleId ? { saleId: result.saleId } : {}),
    });
  }

  return summary;
}

module.exports = {
  getOrCreateTestCompany,
  extractVoucherCollection,
  importTallySales,
};
