/**
 * Golden test of the three "vouchers since AlterID" Tally requests (odbcService.getSalesVouchersSinceAlterId,
 * getPurchaseVouchersSinceAlterId, getAdjustmentNoteVouchersSinceAlterId). The sync worker depends on the exact request text
 * Tally receives, so this records, for each function and input, the URL, the full request body and the headers/timeout that
 * axios.post is called with (as a SHA-256 of the canonical JSON), plus the error log label and the missing-types error text.
 * It exists so the three near-identical functions can be merged without changing a byte of what is sent to Tally.
 *
 * Offline: axios.post is replaced by a recorder; nothing leaves the process. Run: node verify-tally-since-alterid-requests.js
 *       node verify-tally-since-alterid-requests.js --print   prints the current hashes (to refresh GOLDEN after an intended change)
 */
const crypto = require("crypto");
const assert = require("assert");
const axios = require("axios");

const sent = [];
axios.post = async (url, body, config) => { sent.push({ url, body, config }); return { data: { ok: true, echo: "reply" } }; };

const svc = require("./src/services/odbc/odbcService");

const sha = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const TYPES = ["Sales", "Tax Invoice"];
const FUNCS = {
  sales: svc.getSalesVouchersSinceAlterId,
  purchase: svc.getPurchaseVouchersSinceAlterId,
  adjustment: svc.getAdjustmentNoteVouchersSinceAlterId,
};
const CASES = {
  open: { afterAlterId: 100, voucherTypeNames: TYPES, baseUrl: "http://127.0.0.1:9000" },
  bounded: { afterAlterId: 100, upToAlterId: 250, voucherTypeNames: TYPES, baseUrl: "http://127.0.0.1:9000" },
  fromZero: { voucherTypeNames: ["Purchase"], baseUrl: "http://127.0.0.1:9000" },
};

async function snapshots() {
  const out = {};
  for (const [fname, fn] of Object.entries(FUNCS)) {
    for (const [cname, input] of Object.entries(CASES)) {
      sent.length = 0;
      const result = await fn(input);
      assert.strictEqual(sent.length, 1, `${fname}/${cname}: exactly one Tally request`);
      assert.deepStrictEqual(result, { ok: true, echo: "reply" }, `${fname}/${cname}: returns response.data unchanged`);
      out[`${fname}/${cname}`] = sha(sent[0]);
    }
    // missing voucher types: the message names the function and no request is sent
    sent.length = 0;
    const origErr = console.error; const logs = []; console.error = (...a) => logs.push(a);
    let msg = null;
    try { await fn({ afterAlterId: 1 }); } catch (e) { msg = e.message; }
    console.error = origErr;
    assert.strictEqual(sent.length, 0, `${fname}: no request without voucher types`);
    out[`${fname}/noTypes`] = sha({ msg, logLabel: logs[0] && logs[0][0] });
    // Tally failure: the error is logged under this function's own label and re-thrown unchanged
    const boom = new Error("ECONNREFUSED");
    const real = axios.post;
    axios.post = async () => { throw boom; };
    const logs2 = []; console.error = (...a) => logs2.push(a);
    let thrown = null;
    try { await fn(CASES.open); } catch (e) { thrown = e; }
    console.error = origErr; axios.post = real;
    assert.strictEqual(thrown, boom, `${fname}: the original error is re-thrown`);
    out[`${fname}/failure`] = sha({ label: logs2[0] && logs2[0][0], detail: logs2[0] && logs2[0][1] });
  }
  return out;
}

// Recorded from the code as it was BEFORE any consolidation (refresh with --print only for an intended change).
const GOLDEN = {
  "sales/open": "709aae6a5b996bc130d756e5d00dd64ab8837a12e5a6e7cdcc7ffd3d3dfee511",
  "sales/bounded": "15150fbfb5d3b132e04fd62b87b32a8b888f34634840917628a83d122691b408",
  "sales/fromZero": "f711c85534c2b15f52b68b1de54999cdf8eb8f54c867e77033b9b1f42df4b298",
  "sales/noTypes": "7497b335ff7cb101e04a9058bb6bb9978b5af17a7a50523efb56431ba18f7f67",
  "sales/failure": "c97e7d8750757f0a2ddd37d44ba9aa57c05c01df576644a813145a81093539f3",
  "purchase/open": "8f5f2a075c54dea4bd3d3fd1b1d03e0a414eda44e890bd3298e441faa5786845",
  "purchase/bounded": "68fe6f4e09cf45b3c0ef31bb936520f6182d13c049b188c104800fe245b4a96c",
  "purchase/fromZero": "3b4ea0683ebbcba406521d748a2ede517028b82c18614c7262b98f36257ec7bc",
  "purchase/noTypes": "3d27d0be6ce2861e7a467da664ef3d3d381f5a45f906d9b0877fb2001548be8b",
  "purchase/failure": "3a655b08475b8331de5142dd57f5e26bcb8c48ced4dfb066b41db889ee8fdb9c",
  "adjustment/open": "23a2e0d39793f39ec7756720834873dc602e8c1c1d3f8dd7ca2a07a53384cf7b",
  "adjustment/bounded": "ed2613774d98e17263c2d9c1c2b2dea7501292d51fea4a8a94282baa5afc42e4",
  "adjustment/fromZero": "64ed93d937576bffafaa6603d98729ee25377a33c061de3a1983526a5a7ef139",
  "adjustment/noTypes": "c53ce2b2a3be3780ec35237368670560bf9e5ed6e1392d05e171939037c591b3",
  "adjustment/failure": "a8bf895554a1ad83499ed48003f0cacc36c451f88abe14a594ebdc574d613322"
};

(async () => {
  const now = await snapshots();
  if (process.argv.includes("--print")) { console.log(JSON.stringify(now, null, 2)); return; }
  let pass = 0, fail = 0;
  for (const key of Object.keys(now)) {
    const ok = GOLDEN[key] === now[key];
    console.log(`${ok ? "PASS" : "FAIL"} | ${key}`);
    ok ? pass++ : fail++;
  }
  const extra = Object.keys(GOLDEN).filter((k) => !(k in now));
  if (extra.length) { console.log("FAIL | golden entries with no case:", extra.join(", ")); fail++; }
  console.log(`\nverify-tally-since-alterid-requests: ${pass} passed, ${fail} failed, ${pass + fail} total`);
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
