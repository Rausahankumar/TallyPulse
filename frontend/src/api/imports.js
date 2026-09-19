import client from "./client";

// POST /api/import/tally-json — backend/src/routes/importRoutes.js.
// multipart/form-data, field name must be exactly "file" (multer
// config in src/middleware/upload.js).
export async function importTallyJsonFile(file) {
  const form = new FormData();
  form.append("file", file);
  const { data } = await client.post("/import/tally-json", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

// POST /api/import/tally-live?fromDate&toDate — live Sales-only fetch
// straight from TallyPrime. No Purchase equivalent exists on the
// backend today (docs §7.5, §16).
//
// Root cause of a real bug found in QA: passing `null` as the axios
// body here got JSON-stringified to the literal text "null" (because
// the client sets a default application/json Content-Type), and
// Express's body-parser runs in "strict" mode by default — it only
// accepts a top-level object or array, so a bare `null` body is
// rejected with "Unexpected token 'n', \"null\" is not valid JSON"
// before this controller ever runs. This endpoint takes no body at
// all (just query params), so an empty object is the correct payload.
export async function importTallyLive({ fromDate, toDate } = {}) {
  const { data } = await client.post("/import/tally-live", {}, {
    params: { fromDate, toDate },
  });
  return data;
}
