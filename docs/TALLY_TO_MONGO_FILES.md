# Tally se data lana, parse karna, aur MongoDB me store karna

Ye document backend ki un files aur functions ko list karta hai jo Tally se voucher data lane, usko parse karne, aur MongoDB me save karne me involve hain.

Sab details code ko padh kar likhi gayi hain (line numbers current files ke hain). Jahan koi cheez maine poori tarah nahi padhi, wahan saaf likha hai.

---

## 0. Ek nazar me poora raasta

```
[1] TRIGGER
    server.js → startTallySyncWorker() → (har 60s) runSyncForAllCompanies()
                  → runSyncForCompanyModule(company, module)   ← 4 modules: Sales, Purchase, Credit Note, Debit Note

[2] GUARD + IDENTITY  (kya ye sahi company hai?)
    verifyOpenTallyCompany() → readOpenCompanies() → getCompanyInfo() → extractOpenCompanies()
    resolveVoucherTypeClassification() → getVoucherTypeMasters() → parseVoucherTypeMasterList()
                                       → validateMasterOwnership() → classifyVoucherTypes()

[3] TALLY SE FETCH  (odbcService.js, HTTP JSONEx)
    getPendingVoucherAlterIds()          ← halka probe: sirf AlterID ki list
    computeBatchWindow()                 ← max 100 ka cut-off
    getSalesVouchersSinceAlterId()  /  getPurchaseVouchersSinceAlterId()  /  getAdjustmentNoteVouchersSinceAlterId()

[4] OWNERSHIP CHECK (save se pehle)
    assertBatchOwnership()  → har voucher GUID "<companyGuid>-<id>" honi chahiye

[5] PARSE  (tallyParser.js + helpers)
    parseTallyVoucher()   /   parseAdjustmentNoteVoucher()

[6] MAP  (apne format me)
    mapTallySale()   /   mapTallyPurchase()   /   mapAdjustmentNote()
    (CN/DN ke liye pehle classifyAdjustmentNote() → resolveAccountRoles())

[7] VALIDATE + SAVE  (MongoDB upsert)
    processSingleVoucher()  [voucherPersistence.js]  → Sale / Purchase model
    processSingleAdjustmentNoteVoucher()  [adjustmentNotePersistence.js] → AdjustmentNote model

[8] CHECKPOINT
    releaseLock() → SyncCheckpoint.lastAlterId (sirf success par aage)
```

**Manual import (button se):** `importController` → `importTallySalesFromTally()` (ya file upload ke liye `importTallySales()`) → `importParsedVouchers()` → `processSingleVoucher()` → same parse / map / save.

---

## 1. Files (kaun si file kya karti hai)

| # | File (backend/src/...) | Role |
|---|---|---|
| 1 | `services/sync/tallySyncWorker.js` | Background sync ka main controller: timer, company loop, lock, batch, checkpoint |
| 2 | `services/sync/batchWindow.js` | Batch ka size aur cut-off tay karna, completeness check |
| 3 | `services/auth/tallyCompanyGuard.js` | Tally me abhi khuli company sahi hai ya nahi |
| 4 | `services/tally/voucherTypeClassifier.js` | Tally ke voucher type names se Sales/Purchase/CN/DN ke root tay karna |
| 5 | `services/tally/companyOwnership.js` | Har GUID ka company se match check karna (batch ke liye aur masters ke liye) |
| 6 | `services/odbc/odbcService.js` | Tally se baat karne wale saare functions (HTTP JSONEx requests) |
| 7 | `services/odbc/tallyUrl.js` | Tally URL ko safe banana aur default URL dena |
| 8 | `services/parser/tallyParser.js` | Tally ka voucher JSON saaf karna (`parseTallyVoucher`) + basic value parsers + line discount (percentage se amount) |
| 9 | `services/parser/gstFields.js` | Voucher line ke GST fields parse karna |
| 10 | `services/parser/adjustmentNoteParser.js` | Credit/Debit Note voucher parse karna |
| 11 | `services/import/tallySalesImport.js` | Manual import (file upload + "Sync Now"), JSON decode, voucher list nikalna, Sales save wiring |
| 12 | `services/import/tallyPurchaseImport.js` | Purchase save wiring (`processSinglePurchaseVoucher`) |
| 13 | `services/mapper/salesMapper.js` | Parsed sale → `Sale` model ka format (`mapTallySale`) |
| 14 | `services/mapper/purchaseMapper.js` | Parsed purchase → `Purchase` model ka format (`mapTallyPurchase`) |
| 15 | `services/mapper/adjustmentNoteMapper.js` | Parsed CN/DN → `AdjustmentNote` model ka format (`mapAdjustmentNote`) |
| 16 | `services/tally/adjustmentNoteClassifier.js` | CN/DN ko return ya value adjustment me classify karna |
| 17 | `services/sync/voucherPersistence.js` | Sales/Purchase ka save logic (`createVoucherPersistence` → `processSingleVoucher`) |
| 18 | `services/sync/adjustmentNotePersistence.js` | CN/DN ka save logic (`createAdjustmentNotePersistence`) |
| 19 | `models/sales.model.js` | `Sale` collection |
| 20 | `models/purchase.model.js` | `Purchase` collection |
| 21 | `models/adjustmentNote.model.js` | `AdjustmentNote` collection (Credit + Debit Notes) |
| 22 | `models/syncCheckpoint.model.js` | `SyncCheckpoint` collection (lastAlterId + lock) |
| 23 | `models/company.js` | `Company` collection (companyGuid, tenantId, tallyConnection.baseUrl, isActive) |
| 24 | `models/gstSchemas.js` | GST sub-schemas (sales/purchase line ke andar use hote hain) |
| 25 | `services/query/dataVersion.js` + `models/tenantDataVersion.model.js` | Har write par tenant ka version counter badhana (AI cache ke liye) |

---

## 2. Function-by-function

Har entry me: **File**, **line**, **kya karta hai**, aur **kahan se call hota hai**.

### 2A. Trigger aur orchestration — `services/sync/tallySyncWorker.js`

**`startTallySyncWorker({ intervalSeconds })`** (line ~606)
- Cron timer lagata hai. Default 60 second (`DEFAULT_INTERVAL_SECONDS`, env `TALLY_SYNC_INTERVAL_SECONDS`).
- Har tick par `runSyncForAllCompanies` chalata hai.
- Dobara call ho to same timer wapas (double timer nahi).
- Called from: `server.js` (MongoDB connect hone ke baad).

**`runSyncForAllCompanies({ intervalSeconds })`** (line ~537)
- Pichla round chal raha ho to `cycleInProgress` se skip.
- `Company.find({ isActive: true })` se active companies.
- Har company ke liye `SYNC_MODULES` (Sales, Purchase, Credit Note, Debit Note) ek ek karke `runSyncForCompanyModule` se.
- Ek module ka error doosre ko nahi rokta.
- Called from: `startTallySyncWorker` (cron callback).

**`runSyncForCompanyModule(company, syncModule, { intervalSeconds, batchSize })`** (line ~207)
- Ek company ka ek module: lock → company check → classification → probe → batch → fetch → ownership → completeness → save → checkpoint.
- `syncModule` ek descriptor hai (`SALES_SYNC_MODULE`, `PURCHASE_SYNC_MODULE`, `CREDIT_NOTE_SYNC_MODULE`, `DEBIT_NOTE_SYNC_MODULE`). Usme `fetchVouchersSinceAlterId`, `fetchPendingAlterIds`, `processVoucher`, `classificationKey`, `voucherType` hote hain.
- Called from: `runSyncForAllCompanies`. Test files (`verify-*.js`) bhi isko directly call karti hain.

**`ensureCheckpointExists(tenantId, companyGuid, voucherType)`** (line ~135)
- `SyncCheckpoint` nahi hai to `lastAlterId: 0` ke saath upsert karta hai.
- Called from: `runSyncForCompanyModule`.

**`acquireLock(tenantId, companyGuid, voucherType, intervalSeconds)`** (line ~156)
- `SyncCheckpoint` ka `isRunning` true karta hai, sirf tab jab lock free ho ya purana (stale, 5 × interval) ho.
- Lock na mile to `{ skipped: true, reason: "locked" }`.
- Called from: `runSyncForCompanyModule`.

**`releaseLock(tenantId, companyGuid, voucherType, { status, error, advanceTo })`** (line ~177)
- `isRunning: false` karta hai, `lastRunStatus`, `lastSyncedAt`, `lastError` set karta hai.
- `advanceTo` sirf success par `lastAlterId` update karta hai. Ye checkpoint ka ek hi rule hai.
- Called from: `runSyncForCompanyModule` (kai return points par: skip, failure, success, catch).

**`resolveTallyBaseUrl(company)`** (line ~125)
- `company.tallyConnection.baseUrl` ya `undefined` (phir default URL use hota hai).
- Called from: `runSyncForCompanyModule`.

**`buildCronExpression(intervalSeconds)`** (line ~598)
- 60 ka multiple ho to `*/N * * * *`, warna `*/N * * * * *`.
- Called from: `startTallySyncWorker`.

**`stopTallySyncWorker()`** (line ~636)
- Cron task band karta hai. Called from: production code me koi caller nahi (sirf export).

---

### 2B. Batch control — `services/sync/batchWindow.js`

**`resolveBatchSize(value, fallback)`** (line 22)
- Positive integer lautaata hai, warna default (100). Invalid env value bounding ko band nahi karti.
- Called from: `tallySyncWorker.js` (module load par `DEFAULT_SYNC_BATCH_SIZE`).

**`computeBatchWindow(alterIds, batchSize)`** (line 35)
- Pending AlterIDs ko sort karke `{ pending, bounded, upToAlterId, batchCount }` deta hai.
- `pending` > batchSize ho to `bounded: true` aur `upToAlterId` = batchSize-th chhota AlterID.
- Example: 250 pending, size 100 → `upToAlterId` = 200 (101..200 is tick me).
- Called from: `runSyncForCompanyModule`.

**`findMissingAlterIds(expectedAlterIds, returnedAlterIds)`** (line 65)
- Probe ne jo IDs mange the, unme se kaun-kaun Tally ke jawab me nahi aaye, wo array deta hai.
- Missing ho to `runSyncForCompanyModule` error throw karta hai aur checkpoint aage nahi badhta.
- Called from: `runSyncForCompanyModule`.

---

### 2C. Company aur classification guards

**`verifyOpenTallyCompany(expectedGuid, { baseUrl })`** — `services/auth/tallyCompanyGuard.js` (line 45)
- Tally me abhi khuli companies lekar check karta hai ki `expectedGuid` unme hai.
- Results: `ok`, `mismatch` (routine, tick skip), `no_company_open`, `unreachable` (real failure).
- Called from: `tallySyncWorker.js` (line ~245), `reconciliationWorker.js` (~156), `voucherRecovery.js` (~142), `tallySalesImport.js` (~568, `importTallySalesFromTally`), `controllers/odbcController.js`.

**`readOpenCompanies({ baseUrl })`** — `tallyCompanyGuard.js` (line 14)
- `getCompanyInfo` call karta hai, phir `extractOpenCompanies` se list banata hai.
- Called from: `verifyOpenTallyCompany`, `resolveSelectedOpenCompany`.

**`selectedCompanyFromMasters(openCompanies, baseUrl)`** — `tallyCompanyGuard.js` (line 74)
- Multi-company case me: voucher type masters ke GUIDs se pata karta hai ki Tally ne kaun si company select ki hui hai.
- Called from: `resolveSelectedOpenCompany` (sync path me nahi, "Connect Tally" flow me).

**`resolveVoucherTypeClassification({ companyGuid, baseUrl, forceRefresh, cacheTtlMs })`** — `services/tally/voucherTypeClassifier.js` (line 295)
- Pehle cache (6 ghante default, `VOUCHER_TYPE_CLASSIFICATION_CACHE_TTL_MINUTES`) dekhta hai.
- Cache nahi to: `getVoucherTypeMasters` → `parseVoucherTypeMasterList` → `validateMasterOwnership` → `classifyVoucherTypes`.
- Sirf successful live result cache hota hai.
- `forceRefresh` ka default `false`, aur koi caller ise `true` nahi bhejta.
- Called from: `runSyncForCompanyModule`, `importTallySalesFromTally`, `voucherRecovery.js` (~148).

**`classifyVoucherTypes(masters)`** — `voucherTypeClassifier.js` (line 88)
- Pure function (I/O nahi). Har type ke parent chain se root nikalta hai, reservedName ke hisaab se Sales, Purchase, Credit Note, Debit Note ke `{ status, typeNames, rootName, reason }` deta hai.
- Status: `ok`, `needs_configuration` (koi root nahi, ya ek se zyada).
- Called from: `resolveVoucherTypeClassification`.

**`parseVoucherTypeMasterList(rawTallyResponse)`** — `voucherTypeClassifier.js` (line 58)
- Tally ke `collection` se `{ name, parent, reservedName, guid }` ki list. Khali naam wale hata deta hai.
- Called from: `resolveVoucherTypeClassification`.

**`buildFetchFailureResult(reason)`** — `voucherTypeClassifier.js` (line 252)
- Sab 4 keys ke liye `status: "error"` wala result banata hai. Fetch/parse/ownership fail par.

**`cacheKeyFor(companyGuid)`** — `voucherTypeClassifier.js` (line 286): sirf GUID return karta hai (cache key).

**`clearVoucherTypeClassificationCache(companyGuid)`** — `voucherTypeClassifier.js` (line 375): cache saaf karta hai. Production code me caller nahi (sirf export, test/verify files use karti hain).

**`validateMasterOwnership(items, expectedCompanyGuid)`** — `services/tally/companyOwnership.js` (line 167)
- Har master ka GUID check karta hai. Ek bhi foreign ya malformed → reject. Koi verified nahi → reject. Sab theek → `ok: true`.
- Called from: `resolveVoucherTypeClassification` (classifier), `selectedCompanyFromMasters`, `ledgerMaster.js`, `stockItemGst.js`.

**`classifyGuid(guid, expectedCompanyGuid)`** — `companyOwnership.js` (line 35)
- `"ok"`, `"foreign"`, `"malformed"`, `"missing"` deta hai. Format: `<companyGuid>-<masterId>`.
- Called from: `validateMasterOwnership`, `validateBatchOwnership`.

**`guidText(value)`** — `companyOwnership.js` (line 28): GUID value ko `unwrapJsonExValue` se string banata hai.

**`shortGuid(guid)`** — `companyOwnership.js` (line 50): log ke liye GUID ke pehle 8 characters.

**`validateBatchOwnership(items, expectedCompanyGuid, { rejectDuplicates })`** — `companyOwnership.js` (line 66)
- Batch ke liye ownership result (counts + sample). Called from: reconciliation, voucherRecovery, voucherLineBackfill.

**`assertBatchOwnership(items, expectedCompanyGuid, context, options)`** — `companyOwnership.js` (line 136)
- Batch me ek bhi galat GUID mile to `CompanyMismatchError` throw karta hai. Save se pehle.
- Called from: `runSyncForCompanyModule` (line ~400), `importTallySalesFromTally`.

**`logMismatch(validation, context)`** — `companyOwnership.js` (line 149): ginti aur chhote prefix ka log, voucher ka data nahi.

---

### 2D. Tally se baat — `services/odbc/odbcService.js`

Ye file har Tally request ka ek hi darwaza hai. Sab requests `axios.post` se `resolveTallyUrl(baseUrl, DEFAULT_TALLY_URL)` par jaati hain, aur timeout 30 second hai.

**`getCompanyInfo({ baseUrl })`** (line 61)
- Tally se open company ki info (Type: Company collection).
- Called from: `readOpenCompanies` (`tallyCompanyGuard.js`), `controllers/odbcController.js`.

**`getVoucherTypeMasters({ baseUrl })`** (line 220)
- `"Type": "VoucherType"` collection, sirf `Name, Parent, Guid`.
- Called from: `resolveVoucherTypeClassification`, `tallyCompanyGuard.js` (selected company).

**`getPendingVoucherAlterIds({ afterAlterId, baseUrl, voucherTypeNames, withCancelledFlag })`** (line 990)
- Halka probe: sirf AlterID ki list, `afterAlterId` ke baad. Sales/Purchase/CN/DN sab modules me.
- Called from: `runSyncForCompanyModule` (via `fetchPendingAlterIds`), `voucherRecovery.js`.

**`getSalesVouchersSinceAlterId({ afterAlterId, baseUrl, voucherTypeNames, upToAlterId })`** (line 690)
- Sales vouchers jinka AlterID `afterAlterId` se bada hai (aur `upToAlterId` tak agar diya ho). `requireVoucherTypeNames`, `buildAlterIdRangeClause`, `buildVoucherTypeNameFilterClause` use karta hai.
- Called from: `runSyncForCompanyModule` (SALES_SYNC_MODULE ke through).

**`getPurchaseVouchersSinceAlterId(...)`** (line 787)
- Sales ka same copy, Purchase voucher type names ke saath.
- Called from: `runSyncForCompanyModule` (PURCHASE_SYNC_MODULE).

**`getAdjustmentNoteVouchersSinceAlterId(...)`** (line 888)
- Credit/Debit Notes. Sales jaisa shape, do extra Native Method fields ke saath (accounting allocations aur bill allocations).
- Called from: `runSyncForCompanyModule` (CREDIT_NOTE_SYNC_MODULE, DEBIT_NOTE_SYNC_MODULE).

**`getSalesVouchers({ fromDate, toDate, baseUrl, voucherTypeNames })`** (line 546)
- Date range ke sales vouchers (manual "Sync Now" ke liye).
- Called from: `tallySalesImport.js` (`importTallySalesFromTally`), `controllers/odbcController.js`.

**`getVouchersByAlterIds({ alterIds, baseUrl, voucherTypeNames })`** (line 1089)
- Specific AlterIDs ke vouchers. Recovery aur backfill ke liye, normal sync me nahi.
- Called from: `voucherRecovery.js`, `voucherLineBackfill.js`.

**`formatTallyDate(date)`** (line 18): date ko Tally ke `DD-MM-YYYY` format me.

**`resolveDateBound(input, fallback)`** (line 25): date range ka bound tay karta hai.

**`isSafeVoucherTypeNameForFormula(name)`** (line 148): voucher type naam me `"` ya control chars ho to refuse (TDL formula ko tootne se bachane ke liye).

**`buildVoucherTypeNameFilterClause(voucherTypeNames)`** (line 157): `($VoucherTypeName = "Sales") OR (...)` jaisa filter banata hai. Called from: sab `...SinceAlterId` functions.

**`buildAlterIdRangeClause(afterAlterId, upToAlterId)`** (line 177): `$AlterID > X` aur optional `AND $AlterID <= Y`.

**`requireVoucherTypeNames(voucherTypeNames, fnName)`** (line 195): voucher type names khali ho to error (bina type ke query nahi).

**`getAllSalesVoucherGuids` / `getAllPurchaseVoucherGuids`** (lines 1252, 1281): reconciliation (deleted vouchers pakadne) ke liye. Sync save path me nahi.

Masters ke functions (`getStockItemMasters`, `getStockItemGstMasters`, `getLedgerMasters`, `getGroupMasters`, `postMasterCollection`) is document ke main voucher flow me nahi hain. Inka use `stockItemMaster.js`, `stockItemGst.js`, `ledgerMaster.js` karte hain.

**`services/odbc/tallyUrl.js`**
- `resolveTallyUrl(baseUrl, defaultUrl)` (line 81): company ka URL ya default. Called from: sab odbc functions.
- `assertSafeTallyUrl(input)` (line 43) aur `isSafeTallyUrl(input)` (line 71): URL ko validate karte hain. `models/company.js` bhi `isSafeTallyUrl` use karti hai.
- `fail(reason)` (line 38): internal error helper.

---

### 2E. Parsing — `services/parser/tallyParser.js` aur helpers

**`parseTallyVoucher(voucher)`** (line 286) — **main voucher parser**
- Input: ek raw Tally voucher object.
- Steps (code ke hisaab se):
  1. Inventory entries dhundhta hai (`findCollectionByKeywords` se "inventory" wali array).
  2. Ledger entries dhundhta hai ("ledger" wali array).
  3. Har inventory line: `parseQuantity`, `parseRate`, `parseAmount`, `parseDiscountPercentage`, `deriveDiscountAmount`, `parseVoucherLineGst`.
  4. Har ledger line: `safeString` naam, `parseAmount` amount.
  5. Party naam: `partyname` / `partyledgername` / `basicbuyername` etc.
  6. Totals: `inventoryTotal`, `ledgerTotal`, aur `partyLedgerTotal` (`computePartyLedgerTotal`). Voucher total = partyLedgerTotal, nahi to inventoryTotal, nahi to ledgerTotal.
  7. `sync` object: `guid`, `alterId` (`parseTallyId`), `isCancelled`, `isDeleted` (`parseTallyBoolean`).
  8. Return: `{ header, inventory, ledgers, sync, ... }`.
- Called from: `processSingleVoucher` (`voucherPersistence.js`), `voucherLineBackfill.js`.

**`parseTallyDate(rawDate)`** (line 112): Tally date (YYYYMMDD ya text) ko UTC midnight Date banata hai. Called from: `parseTallyVoucher`, `adjustmentNoteParser`, `ledgerMaster.js`.

**`parseQuantity(rawValue)`** (line 136): quantity ko `{ quantity, unit }` jaisa object. Unit text bhi nikalta hai. Called from: `parseTallyVoucher`, `adjustmentNoteParser`.

**`parseRate(rawValue)`** (line 162): rate ko number + unit. Called from: `parseTallyVoucher`, `adjustmentNoteParser`.

**`parseAmount(rawValue)`** (line 189): amount ko number (negative bhi). Called from: `parseTallyVoucher`, `adjustmentNoteParser`.

**`parseTallyId(rawValue)`** (line 204): AlterID/ID ko number. Absent ho to `null` (0 nahi). Called from: `parseTallyVoucher`, `tallySyncWorker.js` (probe aur completeness), `voucherLineBackfill.js`.

**`parseTallyBoolean(rawValue)`** (line 217): Tally ke "Yes/No", true/false, ya wrapped `{type:"Logical", value}` ko boolean. Called from: `parseTallyVoucher`, `adjustmentNoteParser`.

**`safeString(value)`** (line 36): kuch bhi string me (null → "").

**`unwrapJsonExValue(value)`** (line 13): Tally ke wrapped values (`{ value: ... }` ya `[ {metadata:true}, value ]`) ko khol kar asli value.

**`isObject(value)`** (line 3): plain object check.

**`normalizeLedgerEntryType(ledgerAmount, isDeemedPositive, explicitType)`** (line 42): ledger entry ka Dr/Cr type.

**`computePartyLedgerTotal(ledgers, partyName)`** (line 65): party ledger ka absolute amount = voucher ka asli total. Mismatch par `null` (andaza nahi).

**`findCollectionByKeywords(value, keywords)`** (line 78): object ke andar keyword wali array dhundhta hai.

**`extractOpenCompanies(rawTallyResponse)`** (line 427): `getCompanyInfo` ke jawab se `[{ name, guid }]`. Called from: `readOpenCompanies`.

**`services/parser/gstFields.js`**
- `parseVoucherLineGst(entry)` (line 350): voucher line ke GST fields. Koi GST na ho to `null`. Called from: `parseTallyVoucher`.
- `parseLineTaxAmounts(entry)` (line 337): line ke tax amounts (CGST/SGST/IGST/Cess type). Called from: `parseVoucherLineGst`.
- `parseStockItemGstRecord(record)` (line 286): stock item master ka GST view. Called from: `stockItemGst.js`.
- `resolveGstAsOf(gst, asOf)` (line 398): kisi date par applicable GST entry.
- Helpers: `unwrap`, `stripControl`, `cleanText`, `pick`, `numericField`, `booleanField`, `dayField` (YYYYMMDD → UTC midnight), `keyOf`, `objectRows`, `parseRateRows`, `finaliseTimeline`, `parseHsnEntries`, `parseGstDetailEntries`, `makeContext` — ye sab GST sub-parsing ke andar use hote hain.

**Line discount (isi `tallyParser.js` ke andar, `parseTallyVoucher` se pehle)**
- `parseDiscountPercentage(entry)` (line 260): Tally ka discount % (`discount` field).
- `deriveDiscountAmount(percentage, { quantity, rate, amount })` (line 272): list value minus line amount se rupee discount (>= 0).
- `round2(n)` (line 258): 2 decimal rounding.

**`services/parser/adjustmentNoteParser.js`** (Credit/Debit Note)
- `parseAdjustmentNoteVoucher(voucher)` (line 78): CN/DN ka richer parse. Called from: `adjustmentNotePersistence.js`, `adjustmentNoteMapper.js`.
- `findInventoryEntries(voucher)` (31), `findLedgerEntries(voucher)` (39): inventory aur ledger arrays nikalte hain.
- `parseAccountingAllocations(rawEntry)` (53): kis ledger par inventory line ka amount book hua.
- `parseBillAllocations(rawEntry)` (65): bill allocations (Agst Ref).

---

### 2F. Import aur decode (manual / file) — `services/import/tallySalesImport.js`

**`importTallySalesFromTally({ companyGuId, fromDate, toDate })`** (line 552)
- "Sync Now" button ka raasta. JWT wale `companyGuId` se `resolveTenantContext`, phir `verifyOpenTallyCompany`, `resolveVoucherTypeClassification`, `getSalesVouchers` (date range), `assertBatchOwnership`, aur `importParsedVouchers`.
- Called from: `controllers/importController.js` (line ~270).

**`importTallySales({ filePath, rawData, fileName, mimetype, companyGuId })`** (line 415)
- File upload ka raasta: `decodeJsonBuffer` → `extractVoucherCollection` → `importParsedVouchers`.
- Called from: `controllers/importController.js` (line ~52, ~224).

**`resolveTenantContext(companyGuId)`** (line 316)
- `Company.findOne({ companyGuid })`, tenantId wahin se. Called from: `importTallySales`, `importTallySalesFromTally`, `tallyPurchaseImport.js`, `syncStatusController.js`, `syncRecoveryController.js`.

**`importParsedVouchers(vouchers, tenantId)`** (line 353)
- Array ke har voucher ke liye `processSingleVoucher` chalata hai aur summary (created, updated, duplicates, skipped, failed) banata hai. Single voucher ho to seedha result, failure par throw.
- Called from: `importTallySales`, `importTallySalesFromTally`.

**`extractVoucherCollection(payload)`** (line 205): Tally ke jawab me se voucher array nikalta hai (kai possible paths try karta hai). Called from: `runSyncForCompanyModule` (probe aur fetch dono), `tallyPurchaseImport.js`, `reconciliation.js`.

**`decodeJsonBuffer(buffer, { fileName, mimetype })`** (line 140): file ka buffer → string (encoding detect karke). Called from: `importTallySales`.
- `detectJsonEncoding(buffer)` (line 29): UTF-8 / UTF-16 BOM check.
- `sanitizeJsonText(rawText)` (line 17): BOM aur control chars hatata hai.

**`services/import/tallyPurchaseImport.js`**
- Purchase ke liye `createVoucherPersistence({ Model: Purchase, mapVoucher: mapTallyPurchase, entityLabel: "Purchase" })` call karta hai. Result: `processSinglePurchaseVoucher`.
- Re-export karta hai `extractVoucherCollection`, `resolveTenantContext`.
- Called from: `tallySyncWorker.js` (PURCHASE_SYNC_MODULE).

---

### 2G. Mapping (Tally object → apna format)

**`mapTallySale(parsedVoucher, { tenantId })`** — `services/mapper/salesMapper.js` (line 19)
- `tenantId` zaroori (warna error). Tally data se tenantId nahi banata.
- `header` banata hai: `voucherNo`, `voucherDate`, `voucherType` (`normalizeVoucherType`), `voucherTotalAmount`, `narration`, `partyName`.
- `inventory` lines: `quantity`, `rate`, `amount`, `discountPercentage`, `discountAmount` (`toNumber` se).
- `ledgers`, `tallyGuid`, `tallyAlterId`, `voucherStatus`.
- Called from: `processSingleVoucher` (via `createVoucherPersistence`), `tallySalesImport.js` (line 7, 303).
- Helpers: `ensureObject(value, label)` (line 1), `toNumber(value, fallback)` (line 8), `normalizeVoucherType(voucherType)` (line 14).

**`mapTallyPurchase(parsedVoucher, { tenantId })`** — `services/mapper/purchaseMapper.js` (line 27)
- Purchase ke liye same shape, `Purchase` model ke format me. Called from: `processSinglePurchaseVoucher`.
- Helpers: `ensureObject` (9), `toNumber` (16), `normalizeVoucherType` (22).

**`mapAdjustmentNote(parsedVoucher, { tenantId, companyGuid, noteType, classification })`** — `services/mapper/adjustmentNoteMapper.js` (line 16)
- `tenantId`, `companyGuid`, `noteType` ("credit"/"debit"), `classification` sab zaroori. Warna error.
- `classification` pehle classifier se aata hai.
- Called from: `processSingleAdjustmentNoteVoucher` (`adjustmentNotePersistence.js`).

**`classifyAdjustmentNote(parsedVoucher, noteType, accountRoleByLedgerName)`** — `services/tally/adjustmentNoteClassifier.js` (line 33)
- Credit/Debit Note ko `sales_return`, `purchase_return`, `value_adjustment`, `unclassified` me tay karta hai. Sirf note type se nahi, ledger ke account role se.
- Called from: `processSingleAdjustmentNoteVoucher`.

**`resolveAccountRoles(tenantId, ledgerNames)`** — `adjustmentNoteClassifier.js` (line 54)
- LedgerMaster se ledger ke accountRole ek query me (tenant-scoped). Tally call nahi.
- Called from: `processSingleAdjustmentNoteVoucher`.

---

### 2H. Save (MongoDB) — `services/sync/voucherPersistence.js`

**`createVoucherPersistence({ Model, mapVoucher, entityLabel })`** (line 27)
- Factory. Model aur mapper dekar `processSingleVoucher` banata hai.
- Called from: `tallySalesImport.js` (line 301) aur `tallyPurchaseImport.js` (line 17).

**`processSingleVoucher(voucher, tenantId)`** (inside factory, line ~133) — Sales aur Purchase ka common save
Steps:
1. Voucher object check.
2. `parseTallyVoucher(voucher)` (parser).
3. `mapVoucher(parsedVoucher, { tenantId })`. Map fail ho to `handleUnmappableVoucher`.
4. `new Model(mappedDoc)` aur `doc.validate()` (schema check).
5. Identity: `{ tenantId, tallyGuid }`. GUID nahi to `{ tenantId, "header.voucherNo" }` (lekin do se zyada match ho to refuse).
6. `Model.findOne(filter)` → existing doc.
7. Idempotency: incoming `tallyAlterId` <= stored → `duplicate`, koi write nahi.
8. `Model.findOneAndUpdate(filter, { $set: mappedDoc }, { upsert: true, runValidators: true })`.
9. Result: `created` ya `updated`, `tallyAlterId`, `voucherNo`.
10. Catch → `status: "failed"`.
- Called from: `runSyncForCompanyModule` (`processVoucher`), `importParsedVouchers`.

**`handleUnmappableVoucher({ tenantId, voucherNo, parsedVoucher, mapError })`** (inside factory, line ~38)
- Map fail hua: agar voucher cancelled/deleted hai to existing doc ko `voucherStatus` se mark karta hai. Warna error phir se throw.
- Called from: `processSingleVoucher`.

---

### 2I. Save (Credit / Debit Notes) — `services/sync/adjustmentNotePersistence.js`

**`createAdjustmentNotePersistence({ noteType })`** (line 22): `processSingleAdjustmentNoteVoucher` banata hai (credit ya debit). Called from: `tallySyncWorker.js` (lines 86–87).

**`processSingleAdjustmentNoteVoucher(voucher, tenantId, companyGuid)`** (inside factory, line ~52)
1. `parseAdjustmentNoteVoucher(voucher)`.
2. Ledger names collect karke `resolveAccountRoles(tenantId, ledgerNames)`.
3. `classifyAdjustmentNote(parsedVoucher, noteType, roleMap)`.
4. `mapAdjustmentNote(parsedVoucher, { tenantId, companyGuid, noteType, classification })`.
5. `new AdjustmentNote(mappedDoc)` + `validate()`.
6. `AdjustmentNote.findOne({ tenantId, tallyGuid })` → AlterID idempotency.
7. `AdjustmentNote.findOneAndUpdate(filter, { $set }, { upsert: true })`.
8. Result: `created` / `updated` / `duplicate` / `failed`.
- Called from: `runSyncForCompanyModule` (CREDIT/DEBIT modules ka `processVoucher`).

**`handleUnmappable({ ... })`** (inside factory, line ~28): Sales wale jaisa cancel/delete handling, `AdjustmentNote` par.

---

### 2J. Ownership (save se pehle) — `services/tally/companyOwnership.js`
- `assertBatchOwnership(vouchers, companyGuid, context)` — `runSyncForCompanyModule` me, fetch ke turant baad, save se pehle. Ek foreign voucher se poora batch reject.
- `validateBatchOwnership(...)` — same logic, bina throw ke (recovery/reconciliation).

---

## 3. Models (MongoDB collections)

| Model file | Collection | Main fields | Unique index | Notes |
|---|---|---|---|---|
| `models/sales.model.js` | `Sale` | `tenantId`, `header{voucherNo, voucherDate, voucherType, voucherTotalAmount, partyName, narration}`, `inventory[]` (lines + GST), `ledgers[]`, `tallyGuid`, `tallyAlterId`, `voucherStatus` | `{tenantId, tallyGuid}` (partial, tallyGuid string ho to) | `tenantDataVersionPlugin` lagi hai. `voucherLineGstSchema` line me use hota hai |
| `models/purchase.model.js` | `Purchase` | Sales jaisa | `{tenantId, tallyGuid}` | Same plugin, same GST schema |
| `models/adjustmentNote.model.js` | `AdjustmentNote` | `noteType` (credit/debit), `classification` (sales_return/purchase_return/value_adjustment/unclassified), `header`, `inventory[]`, `ledgers[]`, `originalVoucherNumber`, `tallyGuid`, `voucherStatus` | `{tenantId, tallyGuid}` (partial) | Plugin lagi hai; `{tenantId, noteType, classification, header.voucherDate}` index |
| `models/syncCheckpoint.model.js` | `SyncCheckpoint` | `tenantId`, `companyGuid`, `voucherType`, `lastAlterId`, `lastRunStatus`, `lastSyncedAt`, `lastError`, `isRunning`, `lockedAt` | `{tenantId, companyGuid, voucherType}` unique | Sirf `acquireLock`/`releaseLock`/`ensureCheckpointExists` likhte hain |
| `models/company.js` | `Company` | `companyGuid`, `tenantId`, `companyName`, `isActive`, `tallyConnection.baseUrl` | — | `isSafeTallyUrl` se URL check |
| `models/gstSchemas.js` | (sub-schemas) | `voucherLineGstSchema`, `stockItemGstSchema` | — | Sales/Purchase line aur StockItemMaster me embed |
| `models/tenantDataVersion.model.js` + `services/query/dataVersion.js` | `TenantDataVersion` | Per-tenant counter | — | `tenantDataVersionPlugin` har write par counter badhata hai (AI answer cache invalidation) |

---

## 4. Teeno pipelines ek table me

| Pipeline | Fetch function | Parse | Map | Save function | Model | Checkpoint key |
|---|---|---|---|---|---|---|
| Sales | `getSalesVouchersSinceAlterId` | `parseTallyVoucher` | `mapTallySale` | `processSingleVoucher` (voucherPersistence) | `Sale` | `voucherType: "Sales"` |
| Purchase | `getPurchaseVouchersSinceAlterId` | `parseTallyVoucher` | `mapTallyPurchase` | `processSinglePurchaseVoucher` (voucherPersistence via tallyPurchaseImport) | `Purchase` | `voucherType: "Purchase"` |
| Credit Note | `getAdjustmentNoteVouchersSinceAlterId` | `parseAdjustmentNoteVoucher` + `resolveAccountRoles` + `classifyAdjustmentNote` | `mapAdjustmentNote` | `processCreditNote` (adjustmentNotePersistence) | `AdjustmentNote` | `voucherType: "Credit Note"` |
| Debit Note | same | same | same | `processDebitNote` | `AdjustmentNote` | `voucherType: "Debit Note"` |

---

## 5. Is document me NAHI hain (aur kyun)

- **Reconciliation** (`reconciliationWorker.js`, `reconciliation.js`): deleted vouchers pakadne ka alag kaam.
- **Voucher recovery** (`voucherRecovery.js`) aur **line backfill** (`voucherLineBackfill.js`): missing vouchers wapas laana aur purane vouchers me GST/discount bharna.
- **Master pipelines** (`stockItemMaster.js`, `stockItemGst.js`, `ledgerMaster.js`): stock items, ledgers, groups. Ye voucher pipeline ka hissa nahi.
- **AI query engine** (`services/query/*`): ye data ko read karta hai, store nahi karta.

---

## 6. Kuch khaas baatein

1. **Tenant hamesha ek jagah se:** `tenantId` `Company` record ya JWT se aata hai, Tally data ya request body se nahi.
2. **Pehle ownership, phir save:** ek bhi GUID doosri company ka ho to kuch save nahi hota.
3. **Checkpoint sirf success par:** koi error ho to `lastAlterId` nahi badhta, agle tick me wahi batch dobara aata hai. Save idempotent hai, to dobara chalne se duplicate nahi banta.
4. **Amount ka sign:** Save me amount Tally jaisa hi jaata hai (purchase line ka amount negative). Sign ulta karna query compile ke time hota hai (`compile.js` ka `signFactor`), parse ya save me nahi.
5. **Cancelled vouchers store nahi hote:** sirf existing record ko `voucherStatus` se mark kiya jata hai.
