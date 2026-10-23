# TallyPulse ko zero se samjho (Hinglish, aasaan bhasha)

Ye guide 2 files ka pair hai:

1. **Ye file** = kahani. Ek chiz ke peeche doosri kaise chalti hai, step by step.
2. **`docs/CODE_REFERENCE.md`** = dictionary. Har file, har function, uska kaam, aur wo kis doosri file ka kaun sa function bulata hai. Ye code se automatic bani hai (531 functions, 95 files).

> Rule: jab bhi kisi function me koi doosra function call dikhe, `CODE_REFERENCE.md` me us function ka naam search karo. Wahan likha milega: kis file me hai, kya karta hai, aur wo aage kisko bulata hai.

---

## 1. TallyPulse kya hai (ek line me)

TallyPrime ka accounting data (sales, purchase, credit/debit notes, masters) **MongoDB me copy** karta hai, phir us copy se **dashboards, reports aur "Ask AI" chat** chalata hai.

Teen bade kaam hain:

| Kaam | Kya hota hai | Kahan hota hai |
|---|---|---|
| **A. Data lana** | Tally se vouchers uthao → MongoDB me rakho | `services/odbc`, `parser`, `mapper`, `sync`, `tally` |
| **B. Sawal ka jawab** | User sawal poochta hai → AI sirf sawal samajhta hai → server hisaab karta hai | `services/query` |
| **C. Dashboards** | Seedhe MongoDB se numbers dikhao | `services/analytics`, `controllers/analyticsController.js` |

Sabse zaroori rule: **AI number kabhi calculate nahi karta.** AI sirf sawal ko ek "plan" me badalta hai. Hisaab server ka code karta hai.

---

## 2. Folder map (backend/)

```
server.js                  ← app yahan se start hota hai
src/config/db.js           ← MongoDB se connect
src/middleware/            ← har request ke raaste ke pehredaar (login check, security, rate limit)
src/routes/                ← URL → kaun sa controller
src/controllers/           ← request aayi, kaam shuru karo, jawab bhejo
src/models/                ← MongoDB ki tables (schema)
src/services/odbc/         ← Tally se HTTP baat
src/services/tally/        ← Tally ke rules (voucher type, ledger, GST, ownership)
src/services/parser/       ← Tally ka JSON padhna
src/services/mapper/       ← Tally voucher → TallyPulse ka apna format
src/services/sync/         ← background sync, reconciliation, recovery
src/services/import/       ← manual "Sync Now" import
src/services/auth/         ← company/tenant pehchan
src/services/analytics/    ← dashboards ka hisaab, period/date math
src/services/query/        ← AI query engine (sabse important)
verify-*.js                ← tests (node file.js se chalte hain)
```

Frontend (`frontend/src`, React) alag hai. Wo sirf API bulata hai.

---

## 3. Kuch shabd jo baar-baar aayenge

- **Tenant** = ek Tally company. Har record par `tenantId` hota hai. Ek company ka data doosri ko kabhi nahi dikhna chahiye.
- **companyGuid** = Tally company ki unique ID.
- **tallyGuid** = ek voucher ki unique ID. `{tenantId, tallyGuid}` se voucher dobara aaye to update hota hai, duplicate nahi.
- **AlterID** = Tally har badlav par ek badhta number deta hai. Sync isse pata lagata hai "kya naya/badla hai".
- **Checkpoint** (`SyncCheckpoint`) = "pichli baar kahan tak sync hua", ye number yaad rakhta hai.
- **Query Plan** = AI ka banaya structured plan: kaun sa metric, kaun sa period, kis cheez se group karna hai.
- **Catalog** (`semanticCatalog.js`) = business meanings ki dictionary. Kya allowed hai, kya nahi.

---

## 4. Journey 0: server start hona (`server.js`)

`server.js` me koi function nahi hai, ye sirf upar se neeche chalta hai:

1. `dotenv.config()` — `.env` file padhta hai (secrets yahin hote hain).
2. `connectDB()` — **`src/config/db.js`**. MongoDB se connect karta hai.
3. Connect hone ke **baad** do background workers shuru:
   - `startTallySyncWorker()` — **`sync/tallySyncWorker.js`**. Har 60 second me Tally se naya data lata hai.
   - `startReconciliationWorker()` — **`sync/reconciliationWorker.js`**. Har ~20 min me check karta hai ki Tally me kuch delete to nahi hua.
4. `express()` app banta hai. Middleware lagte hain (order important hai):
   - `applyHttpSecurity(app)` — **`middleware/httpSecurity.js`**. Security headers (helmet) + CORS (kaun si website API bula sakti hai).
   - `requestId` — **`middleware/requestId.js`**. Har response par ek request ID, taaki error dhundhna aasaan ho.
   - `express.json()` — body ko JSON me padhta hai.
5. Routes jodte hain: `/api/auth`, `/api/import`, `/api/odbc`, `/api/chat`, `/api/sync`, `/api/analytics`, `/api/vouchers`, `/api/reports`.
6. `notFoundHandler` (404) aur `errorHandler` — **`middleware/errorHandler.js`**. Error ka sirf safe message user ko jata hai, asli error server log me rehta hai.
7. `app.listen(PORT)`.

---

## 5. Journey 1: Login aur company chunna

**Files:** `routes/authRoutes.js` → `controllers/authController.js` → `models/user.model.js`, `company.js`, `userCompanyAccess.model.js`.

| Function | File | Kaam |
|---|---|---|
| `register()` | `authController.js` | Naya user banata hai. |
| `login()` | `authController.js` | Email/password check, phir JWT token deta hai (`signToken()` token banata hai). |
| `addCompany()` | `authController.js` | User ko Tally company se jodta hai. Pehle `detectOpenTallyCompany()` (`auth/tallyCompanyGuard.js`) se Tally me khuli company pehchanta hai, phir `ensureCompanyForGuid()` (`auth/companyIdentity.js`) company record banata/dhundhta hai. |
| `listCompanies()` | `authController.js` | User ki companies ki list. |
| `switchCompany()` | `authController.js` | Doosri company par jao. |
| `updateCompanyName()` | `authController.js` | Company ka naam badlo. |

**Rate limit:** `middleware/rateLimit.js` me `createRateLimiter()` hai. Login, register aur company connect par limit lagti hai, taaki koi baar-baar try na kare.

### Har protected request me kya hota hai

Jaise `routes/chatRoutes.js` me: `router.use(auth, activeCompanyContext)`.

1. **`auth()`** — `middleware/auth.js`.
   - Header se `Bearer` token nikalta hai, `jwt.verify` se check karta hai.
   - Phir DB me user ko dhundhta hai. User delete ho gaya ya `tokenVersion` badal gaya (session revoke) to request reject.
   - Sab theek ho to `req.user` set karta hai.
2. **`activeCompanyContext()`** — `services/auth/companyContext.js`.
   - Check karta hai ki ye user is company ko use karne ka haqdar hai (`UserCompanyAccess`).
   - `req.companyContext.tenantId` set karta hai.
   - Zaroori baat: **tenantId hamesha login/company record se aati hai, kabhi request body, Tally data ya AI se nahi.**

---

## 6. Journey 2: Tally se MongoDB tak (data lana)

Ye sabse bada hissa hai. Pehle poora chain, phir har step.

```
TallyPrime
  → odbcService.js        (HTTP request bhejo)
  → tallyCompanyGuard.js  (sahi company khuli hai?)
  → companyOwnership.js   (har GUID isi company ka hai?)
  → tallyParser.js        (JSON padho)
  → salesMapper.js ...    (apne format me badlo)
  → voucherPersistence.js (MongoDB me save / update)
  → SyncCheckpoint        (AlterID aage badhao)
```

### 6.1 Tally se baat: `services/odbc/odbcService.js` (sabse badi file, 1412 lines)

Ye file **Tally ko sawal bhejne ka ek hi darwaza** hai. Sab requests yahin se jaati hain.

| Function | Kaam |
|---|---|
| `getCompanyInfo()` | Khuli company ka naam/GUID poochta hai. |
| `getVoucherTypeMasters()` | Tally ke voucher types (Sales, Purchase, aur custom naam) mangta hai. |
| `getStockItemMasters()` | Stock items aur unka stock group (`Name, Parent, Guid`). |
| `getStockItemGstMasters()` | Stock items ka GST detail (naya kaam). |
| `getLedgerMasters()`, `getGroupMasters()` | Ledgers aur groups. |
| `getSalesVouchers()` | Date range ke sales vouchers (manual import ke liye). |
| `getSalesVouchersSinceAlterId()` | Ek AlterID ke baad ke sales vouchers (sync ke liye). |
| `getPurchaseVouchersSinceAlterId()` | Wahi purchase ke liye. |
| `getAdjustmentNoteVouchersSinceAlterId()` | Credit/Debit Notes ke liye. |
| `getPendingVoucherAlterIds()` | Pehle sirf AlterID ki list (halki request) mangta hai: "kya-kya badla?" |
| `getVouchersByAlterIds()` | Un chune hue AlterIDs ke poore vouchers. |
| `getAllSalesVoucherGuids()`, `getAllPurchaseVoucherGuids()` | Sirf GUIDs ki list (reconciliation me delete pakadne ke liye). |
| `buildVoucherTypeNameFilterClause()`, `buildAlterIdRangeClause()` | Tally ke filter text banate hain. `isSafeVoucherTypeNameForFormula()` check karta hai ki naam me kuch khatarnak na ho. |
| `formatTallyDate()`, `resolveDateBound()` | Date ko Tally ke format me badalte hain. |
| `postMasterCollection()` | Master collection ki request ka common helper. |

`services/odbc/tallyUrl.js` batata hai Tally ka URL kya hai (default `http://localhost:9000`).

Yaad rakho: Tally **ek hi request ek samay par** sambhalta hai. Bahut badi ya saath me aayi requests se hang ho jata hai. Isliye code chhote, bounded slices bhejta hai.

### 6.2 Parser: `services/parser/tallyParser.js`

Tally ka JSON ajeeb hota hai (values kabhi object me, kabhi string me). Parser use saaf karta hai.

| Function | Kaam |
|---|---|
| `unwrapJsonExValue()` | Tally ka lapeta hua value nikalta hai. |
| `safeString()` | Kuch bhi ho, safe string banata hai. |
| `parseTallyDate()` | Tally ki date → UTC midnight ki date. |
| `parseQuantity()`, `parseRate()`, `parseAmount()` | Quantity/rate/amount ko number banate hain. |
| `parseTallyId()` | AlterID jaisi IDs ko number banata hai. |
| `parseTallyBoolean()` | "Yes/No" → true/false. |
| `normalizeLedgerEntryType()` | Ledger entry ka type saaf karta hai. |
| `computePartyLedgerTotal()` | Party ledger line se invoice ka total nikalta hai (tax samet). |
| `parseDiscountPercentage()`, `deriveDiscountAmount()` | Line ka discount %, aur usse rupaye ka discount (list value − line amount) nikalte hain. |
| `findCollectionByKeywords()` | Reply ke andar voucher list dhundhta hai. |
| `parseTallyVoucher()` | **Mukhya function.** Ek voucher ko saaf object me badalta hai. |
| `extractOpenCompanies()` | Khuli companies ki list nikalta hai. |

Aur bhi parser files:
- `parser/adjustmentNoteParser.js` — Credit/Debit Note ke liye zyada detail wala parser.
- `parser/gstFields.js` — GST fields padhta hai (naya kaam).

### 6.3 Mapper: `services/mapper/`

Mapper Tally ke object ko TallyPulse ke **apne record format** me badalta hai.

| File / Function | Kaam |
|---|---|
| `salesMapper.js` → `mapTallySale()` | Sale voucher → `Sale` model ka shape. `normalizeVoucherType()` voucher type saaf karta hai. |
| `purchaseMapper.js` | Wahi purchase ke liye. |
| `adjustmentNoteMapper.js` | Credit/Debit Note ke liye. |

### 6.4 Rules: `services/tally/`

| File | Function(s) | Kaam |
|---|---|---|
| `voucherTypeClassifier.js` | `resolveVoucherTypeClassification()`, `classifyVoucherTypes()` | Tally me voucher types ka naam kuch bhi ho sakta hai. Ye parent chain dekh kar tay karta hai "ye Sales hai ya Purchase". Agar saaf nahi hai to `NEEDS_CONFIGURATION` (andaza nahi lagata). Result company-wise cache hota hai (`clearVoucherTypeClassificationCache()` cache saaf karta hai). |
| `companyOwnership.js` | `validateBatchOwnership()`, `assertBatchOwnership()`, `validateMasterOwnership()` | Har voucher GUID `<companyGuid>-<hex>` jaisi hoti hai. Agar ek bhi GUID doosri company ki mili to **poora batch reject**. Cross-company data mix na ho, isliye. |
| `ledgerMaster.js` | ledger refresh | Ledgers ko Mongo me rakhta hai; party ka role (debtor/creditor) aur account ka role (sales/purchase accounts) nikalta hai. Agar 50% se zyada ledger hatne wale ho to refuse karta hai. |
| `stockItemMaster.js` | stock refresh | Stock item → stock group. |
| `stockItemGst.js` | GST refresh | Stock item ka GST (naya). |
| `adjustmentNoteClassifier.js` | classify | Credit/Debit Note "return hai ya sirf value adjustment" tay karta hai. Sirf note ke naam se nahi, ledger dekh kar. |

`services/auth/tallyCompanyGuard.js`:
- `verifyOpenTallyCompany()` — jo company Tally me abhi khuli hai, kya wahi hamari company hai? Nahi to sync ruk jaata hai.
- `resolveSelectedOpenCompany()`, `selectedCompanyFromMasters()` — jab 2 companies khuli hon, Tally **selected** company ka hi jawab deta hai. Ye usi ko pehchanta hai.

### 6.5 Background sync: `services/sync/tallySyncWorker.js`

Ye har **60 second** me chalta hai.

| Function | Kaam |
|---|---|
| `startTallySyncWorker()` | Cron schedule shuru karta hai (`buildCronExpression()` schedule text banata hai). |
| `runSyncForAllCompanies()` | Saari companies (`Company.find()`) ke liye sync chalata hai. |
| `runSyncForCompanyModule()` | **Asli kaam.** Ek company ka ek module (Sales, Purchase, Credit/Debit Note). |
| `acquireLock()` / `releaseLock()` | Ek hi company ka sync 2 baar saath me na chale, isliye lock. |
| `ensureCheckpointExists()` | Is company ka `SyncCheckpoint` na ho to bana deta hai. |
| `resolveTallyBaseUrl()` | Company ka Tally URL nikalta hai. |
| `stopTallySyncWorker()` | Band karta hai. |

`runSyncForCompanyModule()` ke andar kya hota hai (mote taur par):

1. Lock lo.
2. `verifyOpenTallyCompany()` — sahi company khuli hai?
3. `resolveVoucherTypeClassification()` — kaun se voucher type Sales/Purchase hain.
4. Halki request: pichle checkpoint ke baad ke AlterIDs (`getPendingVoucherAlterIds()`).
5. `computeBatchWindow()` (**`sync/batchWindow.js`**) — itne saare me se ek chhota slice chuno.
6. Un AlterIDs ke poore vouchers lo.
7. `findMissingAlterIds()` (**`batchWindow.js`**) — completeness check: jitne mange, saare aaye? Kuch kam hai to checkpoint aage nahi badhega.
8. `assertBatchOwnership()` — sab GUID isi company ke?
9. Har voucher ke liye `processSingleVoucher()` (Sales) / `processSinglePurchaseVoucher()` (Purchase) / `processCreditNote()` / `processDebitNote()` chalta hai, ek ek voucher karke. Ye parse → map → save karte hain (6.6 dekho).
10. Slice poora safal hua tabhi checkpoint aage badhao. Kisi ek voucher me galti ho to checkpoint ruk jaata hai (abhi "quarantine" nahi hai).
11. Lock chhodo.

### 6.6 Save karna: `services/sync/voucherPersistence.js`

- `createVoucherPersistence({ Model, mapVoucher, entityLabel })` — ek "factory" hai: Model (Sale ya Purchase) aur mapper (`mapTallySale` ya `mapTallyPurchase`) dekar ek saver banata hai. Wapas deta hai `processSingleVoucher()`.
- `processSingleVoucher(voucher, tenantId)` ek voucher ke liye:
  1. `parseTallyVoucher()` (parser) se saaf object.
  2. `mapVoucher()` se apna format.
  3. Voucher ko `{tenantId, tallyGuid}` se **upsert** karta hai (nahi hai to banao, hai to update). Isliye wahi voucher dobara aaye to duplicate nahi banta.
  4. Agar `tallyGuid` nahi hai aur us voucher number ke ek se zyada record hain, to andaza nahi lagata, refuse karta hai.
  5. Cancelled/deleted voucher ke liye tombstone (nishaan) wala raasta hai.
- Wiring: `services/import/tallySalesImport.js` Sales ke liye saver banata hai (`Sale` + `mapTallySale`), `services/import/tallyPurchaseImport.js` Purchase ke liye (`Purchase` + `mapTallyPurchase`). Sync worker inhi dono ko import karke use karta hai.
- Cancelled vouchers store nahi hote.
- `sync/adjustmentNotePersistence.js` — Credit/Debit Notes ke liye alag saver.

### 6.7 Safety net: delete pakadna aur gap bharna

Tally sync ko "delete hua voucher" nahi dikhta. Isliye:

| File | Kaam |
|---|---|
| `sync/reconciliationWorker.js` | Har ~20 min me chalta hai (`startReconciliationWorker()`, `runReconciliationForAllCompanies()`). Tally ki saari GUIDs mangta hai, Mongo se compare karta hai. |
| `sync/reconciliation.js` | Compare ka hisaab. Jo Tally me nahi hai use Mongo me **deleted mark** karta hai (hataata nahi). 50% se zyada badlav ho to ruk jaata hai. |
| `sync/selfHeal.js` | `maybeSelfHeal()` — chhote gaps khud bharta hai. |
| `sync/voucherRecovery.js` | `recoverMissingVouchers()` — jo vouchers Mongo me kam hain unhe wapas laata hai. By default sirf dry run. Agar kisi ne Mongo se haath se docs hata diye to checkpoint reset mat karo, isse recover karo. |
| `sync/voucherLineBackfill.js` | Purane vouchers me naye line fields (GST/discount) bharne ka kaam. Isi file me database-target guard bhi hai (`checkWriteTarget`): `--apply` kisi non-local database par `--confirm-host` ke bina nahi chalta. |

### 6.8 Manual "Sync Now": `services/import/tallySalesImport.js`

Jab user button dabata hai (`POST /api/import/tally-live`):

- `importTallySalesFromTally()` — `getSalesVouchers()` se Tally se date range ke vouchers lata hai, `verifyOpenTallyCompany()`, `resolveVoucherTypeClassification()`, `assertBatchOwnership()` chalata hai.
- `importParsedVouchers()` — vouchers ki list ko save karwata hai (andar `processSingleVoucher()` use hota hai).
- `resolveTenantContext()` — kis tenant ke liye import ho raha hai.
- `extractVoucherCollection()` — reply me se voucher list nikalta hai.
- `sanitizeJsonText()`, `detectJsonEncoding()`, `decodeJsonBuffer()` — file upload wale JSON ko safe padhte hain.

---

## 7. Journey 3: Sawal se jawab tak (Ask AI) — sabse zaroori

User likhta hai: **"Show product-wise sales in August."**

### Raasta

```
POST /api/chat/message
 → routes/chatRoutes.js         (auth + activeCompanyContext)
 → chatController.sendChatMessage()
 → queryChat.tryAnswerWithQueryEngine()
 → queryChat.answerTurn()
      → planner.planQuestion()          (AI sirf plan banata hai)
      → validator.validateQueryPlan()   (server plan check karta hai)
      → coverage.assessCoverage()       (itne dates ka data hai bhi?)
      → execute.executeQuery()          (compile + MongoDB + hisaab)
      → answerFormatter.formatQueryAnswer()  (text)
      → presentation.buildPresentation()     (cards / charts)
      → followUp.buildQueryState()           (agle sawal ke liye plan yaad)
 → Chat model me save, jawab user ko
```

### Step by step

**1. `controllers/chatController.js` → `sendChatMessage()`**
Chat dhundhta/banata hai (`Chat.findOne`), user ka text lekar `createTurnDates()` (aaj ki date, har layer ke liye ek hi) aur `tryAnswerWithQueryEngine()` bulata hai. Baaki functions (`listChats`, `getChat`, `renameChat`, `deleteChat`) chat list/dekhna/naam badalna/hatana hain. Stop dabane par request band hoti hai to AI call bhi roki jaati hai.

**2. `services/query/queryChat.js`** (is feature ka manager)
- `tryAnswerWithQueryEngine()` — pichle plan (`readQueryState()`) padhta hai, `answerTurn()` bulata hai.
- `answerTurn()` — upar ka poora raasta yahi chalata hai. Ek sawal ke liye AI **sirf ek baar** bulaya jaata hai.
- `plannerFailureMessage()` — AI na chale to fixed message.
- `completePeriodNote()`, `futureVouchersNote()` — jawab ke saath notes (jaise "future-dated vouchers shamil nahi").
- `getSharedExecutor()`, `getPlannerClient()`, `getTenantResolver()` — shared helpers (executor, AI client, naam pehchanne wala).

**3. `services/query/planner.js`** (AI ka darwaza)
- Pehle checks **AI se pehle**: `isUnsafeQuestion()` (galat/khatarnak text), `mentionsRevenue()`.
- `getPlannerPrompt()` + `buildCatalogDigest()` — AI ko instructions banate hain. Instructions **catalog se bante hain**, haath se nahi likhe. Data (vouchers/totals) AI ko nahi bheja jaata.
- `createAnthropicPlannerClient()` — Claude ko call karne wala client.
- `planQuestion()` — AI se plan lekar `parseQueryPlan()` (`queryPlan.schema.js`) se shape check karta hai, phir guards lagata hai:
  - revenue guard, year guard (user ne likha nahi to saal nahi maanta), naye customer ka comparison refuse,
  - `uncalculableTermRefusal()` — "net sales", "turnover", "invoice sales excluding tax" jaise sawal ko seedha refuse karta hai, `mentionsOrders()` — "orders" par clarification maangta hai (D1–D3),
  - har naam ko tenant ke apne data se dobara match karta hai.
- `readPreviousPlan()`, `previousPlanMessage()` — follow-up sawal ke liye pichla plan AI ko JSON me deta hai (poori chat history kabhi nahi).

**4. `services/query/queryPlan.schema.js`**
Plan ka shape (zod). Metrics, groupBy, filters, period, limit kitna ho sakta hai, sab yahin tay hai. Galat shape ka plan yahin gir jaata hai.

**5. `services/query/validator.js`** → `validateQueryPlan()`
Plan ko catalog ke niyam se check karta hai:
- `resolvePlanPeriod()` — "August" ko asli date range me badalta hai.
- `resolveComparison()` — "pichle mahine se" jaisa comparison.
- Catalog ke rules: jaise invoice total ko product se group nahi kar sakte (`dimension_not_applicable_to_voucher_metric`), voucher-level aur line-level metric ek saath nahi.
- `estimateBuckets()` — date series bahut lambi to refuse.
- `defaultSort()` — high-cardinality grouping me sort tay karta hai.
- Result: ya to "resolved plan" ya saaf wajah ke saath refusal (`refuse()`).

**6. `services/query/semanticCatalog.js`** (dictionary)
Yahan metrics (`invoiceAmount`, `lineAmount`, `quantity`, `returnAmount`...), dimensions (date, customer, supplier, product, productGroup, voucherType), `LIMITS` (default 10, max 100), `UNSUPPORTED_CAPABILITIES` (jo nahi ho sakta aur kyun) aur `QUERY_RULES` hain. Validator, planner prompt aur compiler sab isi se padhte hain. Meaning badalni ho to yahan badlo, prompt me nahi.

**7. `services/analytics/coverage.js`** → `assessCoverage()`
Dekhta hai ki maange hue dates ka data sync hua hai ya nahi. Bahar ho to refuse, aadha bahar ho to caveat.

**8. `services/query/execute.js`** → `executeQuery()`
- Naam wale filters pehle resolve (jaise product group → item names: `defaultFindGroupItemNames()`, naye customers: `defaultFindNewParties()`, ye `LedgerMaster` se).
- `compileQuery()` (neeche) se MongoDB pipeline banwata hai, `buildAggregate()`/`defaultRunAggregate()` se chalata hai.
- Natija `toRows()`, `assemblePlain()`, `assembleScalarComparison()`, `assembleList()` se jodta hai. `growthFor()` growth nikalta hai. `rollupProductGroups()` product group me jodta hai. Jo item kisi group me nahi hai use bahar rakhkar warning deta hai (`unmappedWarning()`).
- Query bahut dheemi ho to `isTimeout()` pakad kar fixed error.

**9. `services/query/compile.js`** → `compileQuery()`
Plan → MongoDB aggregation pipeline. Isme:
- `scopeStage()` — **sabse pehla stage hamesha** tenant + active voucher ka filter hota hai.
- `accumulators()`, `derivedFields()`, `groupId()`, `bucketExpression()` — sum/count, average, group key, date bucket.
- `signedPath()`, `signFactor()` — purchase ke amounts Tally me negative aate hain, unhe sidha karta hai.
- `rowsPipeline()`, `totalsPipeline()`, `listPipeline()` — rows, total, list alag pipeline.
- `assertPipelineSafe()` — final check: pipeline tenant filter se shuru ho rahi hai? Nahi to refuse.

**10. `services/query/answerCache.js`**
`createDefaultCachedExecutor()` — **same plan + same data version** ka jawab dobara calculate nahi karta. `services/query/dataVersion.js` har tenant ka version counter rakhta hai; `tenantDataVersionPlugin()` har model par lagta hai, aur koi bhi write hone par `bumpTenantVersion()` counter badhata hai. Isse purane cached jawab apne aap invalid ho jaate hain.

**11. `services/query/entityResolver.js`**
`createEntityResolver()` — "ACME TRADERS", "Acme Traders." ko ek maanta hai (`normalizeText()`: chhota-bada, "&"→"and", punctuation hata deta hai). Koi fuzzy matching nahi. Sirf pehla poora shabd (4+ letters) agar sirf ek stored naam se mile to wahi maanta hai; do se zyada ho to andaza nahi lagata.

**12. Jawab banana**
- `answerFormatter.js` → `formatQueryAnswer()` — text jawab (paisa Indian format me: `fmtMoney()`, `fmtPct()`). Zyada se zyada 25 rows dikhata hai. `formatNonAnswer()` — refuse/clarify ka text.
- `presentation.js` → `buildPresentation()` — card, ranking, trend, table jaisa structured view. Numbers wahi jo engine ne diye.

**13. Follow-up yaad rakhna**
`followUp.js` → `buildQueryState()` plan ko chat me save karta hai; `readQueryState()` agle sawal par use dobara padhta hai. Isi se "ab usme se tax hata do" jaisa follow-up samajh aata hai.

**14. Telemetry**
`turnTelemetry.js` aur `usageStore.js` har sawal ka hisaab (kitne tokens, kitna time, fail hua ya nahi) `AiTurnUsage` me likhte hain. Sirf counters, text nahi.

### Ek example se jodte hain

"Show product-wise sales in August":
1. `planQuestion()` → AI plan: metric `lineAmount`, period August, groupBy `product`.
2. `validateQueryPlan()` → ok (line-level metric product se group ho sakta hai).
3. `executeQuery()` → `compileQuery()` pipeline banata hai: tenant filter → August ke vouchers → item lines alag → product se group → `lineAmount` ka sum.
4. MongoDB se rows aate hain, `formatQueryAnswer()` text banata hai, `buildPresentation()` chart/table.

---

## 8. Journey 4: Dashboards aur reports (bina AI)

`routes/analyticsRoutes.js` → `controllers/analyticsController.js` → `services/analytics/`.

- Controller me functions: `getSalesSummary()`, `getSalesComparison()`, `getTopProducts()`, `getTopCustomers()`, `getSalesTrend()`, `getPurchaseSummary()` ... Har ek URL ka ek function.
- `parsePeriodFromQuery()` (controller me) URL se period nikalta hai, `resolveRequestPeriod()` (`analytics/dateRanges.js`) use asli dates me badalta hai.

`services/analytics/`:

| File | Kaam |
|---|---|
| `analyticsScope.js` → `buildVoucherMatchStage()` | **Har analytics query ka pehla filter**: tenant + active vouchers + date. |
| `periodEngine.js` | "this month", "last quarter", financial year (April–March) jaise periods ka hisaab. |
| `dateRanges.js` | Date range helper. Voucher ki date UTC midnight me store hoti hai, ye use calendar-day se milata hai, taaki server ka timezone voucher ko doosre din na dhakel de. |
| `referenceDate.js` | "Aaj" kaun sa din hai. |
| `coverage.js`, `freshness.js` | Data kitne tak ka hai, kitna taaza hai. |
| `trustEnvelope.js` | Har response me "ye data kitna bharosemand hai" ki jaankari. |
| `salesAnalytics.js`, `purchaseAnalytics.js`, `stockGroupAnalytics.js`, `reportAnalytics.js` | Asli hisaab (top customers, trend, growth...). |

Dhyan: dashboards ka "reference date" aur AI engine ka "aaj" abhi alag tarah se kaam karte hain (ek open decision hai).

---

## 9. Models (MongoDB tables) ek line me

| Model | Kya rakhta hai |
|---|---|
| `sales.model.js` (`Sale`), `purchase.model.js` (`Purchase`) | Vouchers: header (number, date, party, total), inventory lines, ledgers, status (active/cancelled/deleted). |
| `adjustmentNote.model.js` | Credit/Debit Notes, `classification` (sales_return, purchase_return...). |
| `stockItemMaster.model.js` | Item → stock group (+ GST). |
| `ledgerMaster.model.js` | Ledgers, party role, account role, kab bana. |
| `syncCheckpoint.model.js` | "Kahan tak sync hua" (AlterID). |
| `reconciliationCheckpoint.model.js` | Delete-check ki progress. |
| `company.js`, `user.model.js`, `userCompanyAccess.model.js` | Company, user, aur kaun kis company ko use kar sakta hai. |
| `chat.model.js` | Chat messages + `queryContext` (pichla plan). |
| `tenantDataVersion.model.js` | Har tenant ka data-version counter (cache ke liye). |
| `aiTurnUsage.model.js` | AI sawal ka usage counters. |
| `gstSchemas.js` | GST ke chhote schema (naya). |

---

## 10. Padhne ka sahi order (10 files)

1. `docs/PROJECT_CONTEXT.md` — chhota overview.
2. `server.js` — app kaise shuru hota hai.
3. `middleware/auth.js` + `services/auth/companyContext.js` — request kaise pehchani jaati hai.
4. `models/sales.model.js` — data ka shape.
5. `services/odbc/odbcService.js` — sirf function ke naam aur comments (poori file nahi).
6. `services/parser/tallyParser.js` → `parseTallyVoucher()`.
7. `services/sync/tallySyncWorker.js` → `runSyncForCompanyModule()`.
8. `controllers/chatController.js` → `sendChatMessage()`.
9. `services/query/queryChat.js` → `answerTurn()`, phir `planner.js`, `validator.js`, `compile.js`, `execute.js`.
10. `services/query/semanticCatalog.js` — dictionary, ek baar zaroor.

Test se seekhna ho to `verify-query-engine.js` aur `verify-query-planner.js` chalao (`node verify-query-engine.js`, `backend/` ke andar). Ye DB-based hain, to pehle `docs/PROJECT_CONTEXT.md` ka "Test DB safety" wala hissa dekho. Atlas (asli DB) par mat chalana.

---

## 11. Kisi function me doosra function dikhe to kya karo

Example: `answerTurn()` me `validateQueryPlan(...)` dikha.

1. `CODE_REFERENCE.md` kholo, `validateQueryPlan` search karo.
2. Wahan milega: file `src/services/query/validator.js`, purpose, aur wo aage kya bulata hai.
3. Wapas aao aur agla call dekho.

Har function ke neeche do line hoti hain:
- **Calls in this file** — usi file ke doosre functions.
- **Calls other files** — `file → function()` ke roop me.

Aur file ke upar **Used by** likha hai: "is file ko kaun use karta hai". Ulta dekhna ho to wahi dekho.

---

## 12. Aam galtiyan jo naya developer karta hai

- Ek sawal me `tenantId` kisi aur source se (body, AI) lena. **Nahi.** Sirf login/company record se.
- Kisi nayi Mongo query me tenant filter bhoolna. Har pipeline tenant + active filter se shuru honi chahiye.
- Tally ko ek saath kai requests bhejna. Hang ho jaata hai.
- Prompt badal kar meaning badalna. Meaning `semanticCatalog.js` me hoti hai.
- Test file ko asli Atlas URI par chalana. Pehle DB safe karo.
- "Sales" (`invoiceAmount`, tax samet) aur "product sales" (`lineAmount`, tax se pehle) ko ek samajhna. Dono alag hain aur kabhi match nahi karenge.
