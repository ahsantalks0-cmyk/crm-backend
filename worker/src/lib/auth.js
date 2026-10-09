/* Dashboard authentication.
   Every /api/dashboard/* call carries X-Client-Id + X-Client-Password,
   which are checked against clients.dashboard_password. RLS is off (MVP),
   so this check is the only thing standing between a stranger and the CRM. */

import { sbSelect } from "./supabase.js";

const CLIENT_FIELDS = "id,business_name,industry,status,dashboard_password";

// Constant-ish comparison: same length + same characters. Plaintext column
// (user's schema), so this only blunts naive timing probes.
function secretsMatch(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (!x || !y || x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function findClient(env, clientId, password) {
  if (!clientId || !password) return null;
  const params = new URLSearchParams();
  params.set("select", CLIENT_FIELDS);
  params.set("id", `eq.${clientId}`);
  params.set("limit", "1");
  const rows = await sbSelect(env, "clients", params);
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return null;
  if (!secretsMatch(row.dashboard_password, password)) return null;
  return row;
}

// Reads the auth headers and resolves them to a client row (or null).
export async function validateClient(request, env) {
  const header = request.headers;
  const clientId = header.get("X-Client-Id");
  const password = header.get("X-Client-Password");
  return findClient(env, clientId, password);
}

// Never leak credentials back to the browser. A PATCH with
// return=representation hands back every column, so anything secret has to
// be dropped explicitly.
const PRIVATE_CLIENT_FIELDS = ["dashboard_password", "calendar_refresh_token"];

export function publicClient(row) {
  if (!row) return null;
  const safe = { ...row };
  for (const field of PRIVATE_CLIENT_FIELDS) delete safe[field];
  return safe;
}
