const mongoose = require("mongoose");

// --------------------------------------------------
// Shared GST sub-schemas (see services/parser/gstFields.js for how each field is produced).
//
// Two different things use them and must never be mixed up:
//   - StockItemMaster.gst   : the item's CURRENT master configuration, with its dated history.
//   - Sale/Purchase inventory[].gst : what that voucher line carried when it was posted.
//
// Conventions:
//   - null means "Tally did not supply it". It is never a stand-in for 0 or false.
//   - A rate is {value, status, raw}: status "value" (0 is a real value), "missing" or "malformed".
//   - Duty heads are separate rows. They are never summed: CGST+SGST (intra-state) and IGST
//     (inter-state) are alternative treatments of the same supply.
//   - Every enumerated *Key sits next to the verbatim label Tally sent; unknown labels get "other".
// --------------------------------------------------

const { Schema } = mongoose;

const DUTY_HEAD_KEYS = ["cgst", "sgst_utgst", "igst", "cess", "state_cess", "other", null];
const TAXABILITY_KEYS = ["taxable", "exempt", "nil_rated", "non_gst", "other", null];
const VALUATION_KEYS = ["based_on_value", "based_on_quantity", "not_applicable", "other", null];
const APPLICABLE_KEYS = ["applicable", "not_applicable", "undefined", "other", null];

const quantitySchema = new Schema(
  {
    value: { type: Number, default: null },
    status: { type: String, enum: ["value", "missing", "malformed"], required: true },
    raw: { type: String, default: null },
  },
  { _id: false }
);

const rateRowSchema = new Schema(
  {
    dutyHead: { type: String, default: null },
    dutyHeadKey: { type: String, enum: DUTY_HEAD_KEYS, default: null },
    valuationType: { type: String, default: null },
    valuationKey: { type: String, enum: VALUATION_KEYS, default: null },
    rate: { type: quantitySchema, required: true }, // a percentage when valuationKey is based_on_value
    ratePerUnit: { type: quantitySchema, required: true }, // an amount per unit when based_on_quantity
  },
  { _id: false }
);

const stateRatesSchema = new Schema(
  {
    stateName: { type: String, default: null },
    stateScope: { type: String, enum: ["any", "state", "unknown"], required: true },
    rates: { type: [rateRowSchema], default: [] },
  },
  { _id: false }
);

const gstDetailSchema = new Schema(
  {
    applicableFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null }, // last day in force, derived from the next later entry; null = open-ended
    taxability: { type: String, default: null },
    taxabilityKey: { type: String, enum: TAXABILITY_KEYS, default: null },
    calculationType: { type: String, default: null },
    srcOfDetails: { type: String, default: null },
    reverseChargeRate: { type: quantitySchema, required: true },
    ineligibleItc: { type: Boolean, default: null }, // true only when Tally said so; absent is null, not false
    stateRates: { type: [stateRatesSchema], default: [] },
  },
  { _id: false }
);

const hsnEntrySchema = new Schema(
  {
    applicableFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },
    code: { type: String, default: null }, // string: leading zeros matter
    description: { type: String, default: null },
    srcOfDetails: { type: String, default: null },
  },
  { _id: false }
);

const gstIssueSchema = new Schema(
  {
    section: { type: String, enum: ["applicability", "hsn", "details"], required: true },
    path: { type: String, required: true },
    code: { type: String, required: true },
    severity: { type: String, enum: ["error", "warning"], required: true },
    raw: { type: String, default: null },
  },
  { _id: false }
);

const stockItemGstSchema = new Schema(
  {
    schemaVersion: { type: Number, required: true },
    syncedAt: { type: Date, required: true }, // when this GST content last CHANGED (not when it was last re-read)
    applicability: {
      type: new Schema(
        {
          gstApplicable: { type: String, default: null },
          gstApplicableKey: { type: String, enum: APPLICABLE_KEYS, default: null },
          typeOfSupply: { type: String, default: null },
        },
        { _id: false }
      ),
      default: null,
    },
    hsn: { type: [hsnEntrySchema], default: [] },
    details: { type: [gstDetailSchema], default: [] },
    issues: { type: [gstIssueSchema], default: [] },
    issueCount: { type: Number, default: 0 },
    contentHash: { type: String, required: true },
  },
  { _id: false }
);

const voucherLineGstSchema = new Schema(
  {
    hsn: { type: String, default: null },
    taxability: { type: String, default: null },
    taxabilityKey: { type: String, enum: TAXABILITY_KEYS, default: null },
    typeOfSupply: { type: String, default: null },
    reverseCharge: { type: String, default: null },
    rates: { type: [rateRowSchema], default: [] },
    // The GST amounts in rupees Tally computed for this line (taxable value and each duty head), as Tally sends them.
    // null = not supplied; 0 = a real zero. Present only on lines fetched with `inventoryentries.computedigst`.
    amounts: {
      type: new Schema(
        {
          assessableValue: { type: Number, default: null },
          cgst: { type: Number, default: null },
          sgst: { type: Number, default: null },
          utgst: { type: Number, default: null },
          igst: { type: Number, default: null },
          cess: { type: Number, default: null },
          cessOnQty: { type: Number, default: null },
          stateCess: { type: Number, default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },
    // Tally's own markers for where this line's GST values came from (Stock Item / Company / specified on the
    // voucher) and whether they were system-inferred. Verbatim; present only when Tally sent any.
    provenance: {
      type: new Schema(
        {
          storedNature: { type: String, default: null },
          gstSourceType: { type: String, default: null },
          hsnSourceType: { type: String, default: null },
          rateInference: { type: String, default: null },
          hsnInference: { type: String, default: null },
        },
        { _id: false }
      ),
      default: undefined,
    },
  },
  { _id: false }
);

module.exports = { stockItemGstSchema, voucherLineGstSchema };
