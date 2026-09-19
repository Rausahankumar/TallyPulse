import client from "./client";

// GET /api/sync/status — backend/src/routes/syncRoutes.js. Real
// SyncCheckpoint/ReconciliationCheckpoint rows and the actual synced
// Sale/Purchase documents for the caller's active company (tenant
// re-derived server-side from the JWT's companyGuId, never trusted from
// the client). A checkpoint that hasn't run yet for this tenant comes
// back as `null`, not a fake placeholder.
export async function getSyncStatus() {
  const { data } = await client.get("/sync/status");
  return data.data;
}
