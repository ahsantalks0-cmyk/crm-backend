/* Minimal Supabase REST (PostgREST) client used by every route. */

import { PKT_TZ_NAME } from "./pkt.js";

export function sbHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    ...extra,
  };
}

export function buildUrl(env, path, params) {
  const qs = params ? `?${params.toString()}` : "";
  return `${env.SUPABASE_URL}/rest/v1/${path}${qs}`;
}

function assertEnv(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_KEY not set on worker");
  }
}

function parseJson(text, path) {
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Supabase returned non-JSON from ${path}: ${String(text).slice(0, 300)}`);
  }
}

export async function sbSelect(env, path, params) {
  assertEnv(env);
  const res = await fetch(buildUrl(env, path, params), { headers: sbHeaders(env) });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Supabase read failed (${res.status}) on ${path}: ${text || "(empty body)"}`
    );
  }
  return parseJson(text, path);
}

// Row count without downloading rows (uses Content-Range from PostgREST).
export async function sbCount(env, path, params) {
  assertEnv(env);
  const p = new URLSearchParams(params || []);
  p.set("select", "id");
  p.set("limit", "1");
  const res = await fetch(buildUrl(env, path, p), {
    headers: sbHeaders(env, { Prefer: "count=exact" }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Supabase count failed (${res.status}) on ${path}: ${text || "(empty body)"}`
    );
  }
  const range = res.headers.get("content-range") || "";
  const total = range.split("/")[1];
  const n = parseInt(total, 10);
  return Number.isNaN(n) ? 0 : n;
}

export async function sbInsert(env, path, rows, { onConflict, ignoreDuplicates = false } = {}) {
  assertEnv(env);
  const p = new URLSearchParams();
  if (onConflict) p.set("on_conflict", onConflict);
  let prefer = "return=representation";
  if (ignoreDuplicates) prefer += ",resolution=ignore-duplicates";
  const res = await fetch(buildUrl(env, path, p), {
    method: "POST",
    headers: sbHeaders(env, { "Content-Type": "application/json", Prefer: prefer }),
    body: JSON.stringify(rows),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      `Supabase insert failed (${res.status}) on ${path}: ${text || "(empty body)"}`
    );
    err.status = res.status;
    throw err;
  }
  return parseJson(text, path);
}

export async function sbPatch(env, path, params, patch) {
  assertEnv(env);
  const res = await fetch(buildUrl(env, path, params), {
    method: "PATCH",
    headers: sbHeaders(env, {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    }),
    body: JSON.stringify(patch),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      `Supabase update failed (${res.status}) on ${path}: ${text || "(empty body)"}`
    );
    err.status = res.status;
    throw err;
  }
  return parseJson(text, path);
}

export async function sbDelete(env, path, params) {
  assertEnv(env);
  const res = await fetch(buildUrl(env, path, params), {
    method: "DELETE",
    headers: sbHeaders(env, { Prefer: "return=representation" }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(
      `Supabase delete failed (${res.status}) on ${path}: ${text || "(empty body)"}`
    );
    err.status = res.status;
    throw err;
  }
  return parseJson(text, path);
}

export { PKT_TZ_NAME };
