/* ============================================================
   voice-agent-backend  —  thin router

   Public (no auth):
     GET  /health                        → "OK"
     POST /get-token                     → Gemini Live ephemeral token
     GET  /api/check-slots               → free slots per doctor for a PKT date     POST /api/book                     → book a slot (Supabase CRM)
     POST /api/login                     → dashboard sign-in
     GET  /api/config?client=            → agent knowledge base (public)

   Dashboard (X-Client-Id + X-Client-Password):
     GET    /api/dashboard/stats
     GET    /api/dashboard/bookings
     PATCH  /api/dashboard/bookings/{id}
     GET    /api/dashboard/doctors
     POST   /api/dashboard/doctors
     PATCH  /api/dashboard/doctors/{id}
     DELETE /api/dashboard/doctors/{id}   (409 + list if it has appointments)
     GET    /api/dashboard/appointments          (default: today)
     POST   /api/dashboard/appointments          (patient auto-add + slot lock)
     PATCH  /api/dashboard/appointments/{id}     (status / payment_status)
     GET    /api/dashboard/appointments/slots    (?doctor_id=&date=)
     GET    /api/dashboard/patients             (+ aggregates, ?q=)
     POST   /api/dashboard/patients             (phone dedupe → exists:true)
     GET    /api/dashboard/patients/{id}        (profile + stats + history)
     PATCH  /api/dashboard/patients/{id}        (edit / is_active)
     DELETE /api/dashboard/patients/{id}        (409 + count if has appointments)
     GET    /api/dashboard/leaves
     POST   /api/dashboard/leaves
     DELETE /api/dashboard/leaves/{id}
     GET    /api/dashboard/availability?date=
     GET    /api/dashboard/agent-config
     PUT    /api/dashboard/agent-config
     POST   /api/change-password

   TIMEZONE RULE: every slot calculation runs through lib/pkt.js
   (Asia/Karachi, UTC+5, no DST). Instants are always written and compared
   with an explicit +05:00 offset — never UTC, never server-local.
   ============================================================ */

import { preflightResponse, textResponse } from "./lib/response.js";
import { book, checkSlots, getConfig, getToken, health } from "./routes/public.js";
import { handleApi } from "./routes/dashboard.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // ── CORS preflight ──
    if (method === "OPTIONS") return preflightResponse();

    try {
      if (pathname === "/health" && method === "GET") return health();
      if (pathname === "/get-token" && method === "POST") return getToken(env);
      if (pathname === "/api/check-slots" && method === "GET") {
        return checkSlots(env, url);
      }
      if (pathname === "/api/book" && method === "POST") return book(request, env);
      if (pathname === "/api/config" && method === "GET") return getConfig(env, url);

      if (pathname.startsWith("/api/")) {
        const res = await handleApi(request, env, url);
        if (res) return res;
      }
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err && err.message ? err.message : String(err) }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    return textResponse("Voice Agent Backend");
  },
};
