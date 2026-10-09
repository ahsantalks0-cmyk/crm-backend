/* Public routes — reachable by the voice widget and the marketing site.
   No auth headers required. /get-token hands out short-lived Gemini
   Live tokens; the rest is the booking CRM the widget talks to. */

import { jsonResponse, textResponse, badRequest, serverError } from "../lib/response.js";
import { sbInsert, sbSelect } from "../lib/supabase.js";
import { withDefaults } from "../lib/agentConfig.js";
import { PKT_TZ_NAME, isValidDateStr, pktDateString } from "../lib/pkt.js";
import {
  buildDaySchedule,
  clinicClosure,
  fetchDoctors,
  findConflictingBooking,
  findDoctorByName,
  isDoctorOnLeave,
  worksOnDate,
} from "../lib/slots.js";

const GEMINI_TOKEN_URL =
  "https://generativelanguage.googleapis.com/v1beta/auth_tokens";

function isoNow(offsetMinutes) {
  const d = new Date(Date.now() + offsetMinutes * 60 * 1000);
  return d.toISOString().replace(/\.(\d{3})Z$/, "Z");
}

export function health() {
  return textResponse("OK");
}

export async function getToken(env) {
  const geminiApiKey = env.GEMINI_API_KEY;
  if (!geminiApiKey) {
    return jsonResponse({ error: "GEMINI_API_KEY not set on worker" }, 500);
  }

  try {
    const expireTime = isoNow(30);
    const newSessionExpireTime = isoNow(2);

    const geminiRes = await fetch(GEMINI_TOKEN_URL, {
      method: "POST",
      headers: {
        "x-goog-api-key": geminiApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime }),
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text().catch(() => "");
      return new Response(errText, {
        status: geminiRes.status,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const data = await geminiRes.json();
    return jsonResponse(
      { token: data?.name ?? null, expireTime, newSessionExpireTime },
      200
    );
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

/* GET /api/config?client=<id>
   The client's knowledge base / personality (agent_name, tone, greeting,
   business_info, booking_rules, custom_instructions …). Public on purpose:
   the widget must be able to load it before any dashboard credential exists,
   and this content is not secret. Missing keys fall back to the standard
   defaults so the widget always receives a complete prompt. 404 when the
   client id does not exist. */
export async function getConfig(env, url) {
  try {
    const clientId = url.searchParams.get("client");
    if (!clientId) return badRequest({ error: "Missing ?client=<client_id>" });

    // Only `id` is selected — never dashboard_password.
    const clientParams = new URLSearchParams();
    clientParams.set("select", "id");
    clientParams.set("id", `eq.${clientId}`);
    clientParams.set("limit", "1");
    const clients = await sbSelect(env, "clients", clientParams);
    const client = Array.isArray(clients) ? clients[0] : null;
    if (!client) return jsonResponse({ error: "not_found", client: clientId }, 404);

    const cfgParams = new URLSearchParams();
    cfgParams.set("select", "knowledge_base_json");
    cfgParams.set("client_id", `eq.${clientId}`);
    cfgParams.set("limit", "1");
    const rows = await sbSelect(env, "client_configs", cfgParams);
    const row = Array.isArray(rows) ? rows[0] : null;

    return jsonResponse(withDefaults(row?.knowledge_base_json), 200);
  } catch (err) {
    return serverError(err);
  }
}

/* GET /api/check-slots?client=<id>&date=YYYY-MM-DD
   { date, timezone, doctors: [{ doctor_name, fee, available_slots[] }] }
   A doctor on leave reports an empty list plus reason:"on_leave"; on a day
   outside their working_days, reason:"not_working".
   Only doctors with status 'active' are ever offered. */
export async function checkSlots(env, url) {
  try {
    const clientId = url.searchParams.get("client");
    const dateStr = url.searchParams.get("date");

    if (!clientId) return badRequest({ error: "Missing ?client=<client_id>" });
    if (!isValidDateStr(dateStr)) {
      return badRequest({
        error: "Missing or invalid ?date=YYYY-MM-DD",
        date: dateStr,
        timezone: PKT_TZ_NAME,
      });
    }

    const doctors = await fetchDoctors(env, clientId, { activeOnly: true });
    const schedule = await buildDaySchedule(env, doctors, dateStr);

    const doctorsOut = schedule.map((entry) => {
      if (entry.clinic_closed) {
        return {
          doctor_name: entry.doctor.name,
          available_slots: [],
          reason: "clinic_closed",
          message: entry.closed_message ?? "Clinic closed.",
        };
      }
      if (entry.on_leave) {
        return {
          doctor_name: entry.doctor.name,
          available_slots: [],
          reason: "on_leave",
        };
      }
      if (entry.off_day) {
        return {
          doctor_name: entry.doctor.name,
          available_slots: [],
          reason: "not_working",
        };
      }
      return {
        doctor_name: entry.doctor.name,
        // Stored on the doctor so any booking form can auto-fetch the fee
        // the moment this doctor is selected.
        fee: entry.doctor.fee ?? null,
        available_slots: entry.slots
          .filter((s) => s.status === "free")
          .map((s) => s.time),
      };
    });

    return jsonResponse(
      { date: dateStr, timezone: PKT_TZ_NAME, doctors: doctorsOut },
      200
    );
  } catch (err) {
    return serverError(err);
  }
}

/* POST /api/book
   { client, doctor_name, name, phone, slot_iso, service, notes }
   slot_iso MUST carry an explicit +05:00 offset — a bare timestamp would be
   read by Postgres as UTC and silently store the wrong instant. */
export async function book(request, env) {
  try {
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ success: false, reason: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object") {
      return jsonResponse({ success: false, reason: "invalid_json" }, 400);
    }

    const clientId = body.client;
    const doctorName = body.doctor_name;
    const customerName = body.name;
    const phone = body.phone;
    const slotIso = typeof body.slot_iso === "string" ? body.slot_iso.trim() : "";

    const missing = [];
    if (!clientId) missing.push("client");
    if (!doctorName) missing.push("doctor_name");
    if (!customerName) missing.push("name");
    if (!slotIso) missing.push("slot_iso");
    if (missing.length > 0) {
      return jsonResponse({ success: false, reason: "missing_fields", missing }, 400);
    }

    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(slotIso)) {
      return jsonResponse(
        {
          success: false,
          reason: "slot_iso_missing_offset",
          detail:
            "slot_iso must carry an explicit offset, e.g. 2026-10-09T18:30:00+05:00",
          slot_iso: slotIso,
        },
        400
      );
    }
    if (Number.isNaN(Date.parse(slotIso))) {
      return jsonResponse(
        { success: false, reason: "invalid_slot_iso", slot_iso: slotIso },
        400
      );
    }

    const doctor = await findDoctorByName(env, clientId, doctorName, {
      activeOnly: true,
    });
    if (!doctor) {
      return jsonResponse(
        { success: false, reason: "doctor_not_found", doctor: doctorName, client: clientId },
        404
      );
    }

    // Slots only exist on the doctor's working days — reject the rest.
    if (!worksOnDate(doctor, pktDateString(slotIso))) {
      return jsonResponse(
        { success: false, reason: "doctor_not_working", doctor: doctor.name, slot: slotIso },
        200
      );
    }

    // A doctor on leave must not be booked through the API either.
    if (await isDoctorOnLeave(env, doctor.id, pktDateString(slotIso))) {
      return jsonResponse(
        { success: false, reason: "doctor_on_leave", doctor: doctor.name, slot: slotIso },
        200
      );
    }

    // Clinic-wide closure (holiday / closed day) blocks every doctor.
    const closure = await clinicClosure(env, clientId, pktDateString(slotIso));
    if (closure) {
      return jsonResponse(
        {
          success: false,
          reason: "clinic_closed",
          message: closure.message,
          doctor: doctor.name,
          slot: slotIso,
        },
        200
      );
    }

    const conflict = await findConflictingBooking(env, doctor.id, slotIso);
    if (conflict) {
      return jsonResponse(
        { success: false, reason: "slot_taken", doctor: doctor.name, slot: slotIso },
        200
      );
    }

    let rows;
    try {
      rows = await sbInsert(env, "bookings", {
        client_id: clientId,
        doctor_id: doctor.id,
        customer_name: customerName,
        phone: phone ?? null,
        slot_time: slotIso,
        status: "confirmed",
        details_json: { service: body.service ?? null, notes: body.notes ?? null },
      });
    } catch (err) {
      return jsonResponse(
        { success: false, reason: "insert_failed", detail: err.message },
        500
      );
    }

    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.id) {
      return jsonResponse({ success: false, reason: "insert_returned_no_row" }, 500);
    }

    return jsonResponse(
      {
        success: true,
        booking_id: row.id,
        doctor: doctor.name,
        slot: slotIso,
        name: customerName,
      },
      200
    );
  } catch (err) {
    return jsonResponse({ success: false, error: err.message }, 500);
  }
}
