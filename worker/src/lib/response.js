/* Shared HTTP helpers: CORS + JSON/text responses. */

export function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Id, X-Client-Password",
    // The dashboard's auth headers make every call preflight-triggered, so let
    // the browser cache the preflight instead of re-asking on each request.
    "Access-Control-Max-Age": "86400",
  };
}

export function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

export function textResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...corsHeaders(), "Content-Type": "text/plain" },
  });
}

export function preflightResponse() {
  return new Response(null, {
    status: 204,
    headers: { ...corsHeaders(), "Content-Type": "text/plain" },
  });
}

export function unauthorized() {
  return jsonResponse({ error: "unauthorized" }, 401);
}

export function badRequest(payload) {
  return jsonResponse(payload, 400);
}

export function serverError(err) {
  return jsonResponse({ error: err && err.message ? err.message : String(err) }, 500);
}
