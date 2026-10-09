/* Patients routes — /api/dashboard/patients*
   Phone is the patient's unique identifier inside a clinic: it is stored
   in one canonical form (cleanPhone), matched raw-or-digits, and backed by
   the unique index (client_id, phone) so duplicates are impossible even
   under a race.

   Patients with appointments can never be deleted: DELETE answers 409 with
   the appointment count so the dashboard can offer deactivation
   (is_active=false) instead — history stays intact either way.

   Response conventions match the other dashboard routes:
     collections → { patients: [...], count: n }
     mutations   → { success: true, patient: {...} } (add may also set exists)
     failures    → { error: "<code>", message? } with a matching status */

import { jsonResponse, badRequest } from "../lib/response.js";
import { sbCount, sbDelete, sbInsert, sbPatch, sbSelect } from "../lib/supabase.js";
import { pktDateString } from "../lib/pkt.js";
import { cleanPhone, findPatientByPhone } from "./appointments.js";

const PATIENT_SOURCES = ["call", "walk-in", "website"];

const PATIENT_SELECT =
  "id,name,phone,age,guardian,first_source,is_active,created_at";

const HISTORY_SELECT =
  "id,appointment_date,time_slot,fee,payment_method,payment_status,source,status,notes,cancellation_reason,created_at,doctors(name,specialization)";

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

function query(params) {
  const p = new URLSearchParams();
  for (const [k, v] of params) p.append(k, v);
  return p;
}

function isUniqueViolation(err) {
  return err && err.status === 409 && /23505|duplicate key/i.test(String(err.message || ""));
}

function flattenHistory(row) {
  if (!row) return row;
  const { doctors, ...rest } = row;
  return {
    ...rest,
    doctor_name: doctors?.name ?? null,
    specialization: doctors?.specialization ?? null,
  };
}

// name/phone/age validation shared by add + edit. Returns either
// { error: <badRequest Response> } or { value: {...} }.
function validatePatientFields(body, { partial = false } = {}) {
  const out = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name ?? "").trim();
    if (!name) {
      return {
        error: badRequest({ error: "missing_field", field: "name", message: "Patient name is required." }),
      };
    }
    out.name = name;
  }

  if (body.phone !== undefined || !partial) {
    const phone = cleanPhone(body.phone);
    if (!phone || !/\d/.test(phone)) {
      return {
        error: badRequest({ error: "missing_field", field: "phone", message: "Phone number is required." }),
      };
    }
    out.phone = phone;
  }

  if (body.age !== undefined || !partial) {
    const age = Number(body.age);
    if (!Number.isInteger(age) || age < 0 || age > 120) {
      return {
        error: badRequest({ error: "invalid_age", age: body.age ?? null, message: "Age must be a whole number between 0 and 120." }),
      };
    }
    out.age = age;
  }

  if (body.guardian !== undefined) {
    out.guardian = body.guardian ? String(body.guardian).trim() : null;
  }

  return { value: out };
}

// ── GET /api/dashboard/patients ────────────────────────────────────
/* Newest patients first. Visit stats are aggregated in the worker from
   the client's appointments: total_visits = done count, last_visit =
   most recent non-cancelled appointment date. ?q= filters name/phone
   (the dashboard also filters live client-side). */
async function listPatients(env, client, url) {
  const rows = await sbSelect(
    env,
    "patients",
    query([
      ["client_id", `eq.${client.id}`],
      ["select", PATIENT_SELECT],
      ["order", "created_at.desc"],
    ])
  );
  const patients = Array.isArray(rows) ? rows : [];

  const agg = new Map();
  if (patients.length > 0) {
    const appts = await sbSelect(
      env,
      "appointments",
      query([
        ["client_id", `eq.${client.id}`],
        ["select", "patient_id,status,appointment_date"],
      ])
    );
    for (const a of Array.isArray(appts) ? appts : []) {
      if (!a.patient_id) continue;
      let e = agg.get(a.patient_id);
      if (!e) {
        e = { done: 0, last: null };
        agg.set(a.patient_id, e);
      }
      if (a.status === "done") e.done += 1;
      if (a.status !== "cancelled" && (!e.last || a.appointment_date > e.last)) {
        e.last = a.appointment_date;
      }
    }
  }

  let out = patients.map((p) => {
    const e = agg.get(p.id);
    return {
      ...p,
      total_visits: e ? e.done : 0,
      last_visit: e ? e.last : null,
    };
  });

  const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q) {
    const digits = q.replace(/\D/g, "");
    out = out.filter((p) => {
      const name = String(p.name ?? "").toLowerCase();
      const phone = String(p.phone ?? "");
      const phoneDigits = phone.replace(/\D/g, "");
      return name.includes(q) || phone.includes(q) || (digits && phoneDigits.includes(digits));
    });
  }

  return jsonResponse({ patients: out, count: out.length }, 200);
}

// ── GET /api/dashboard/patients/{id} ───────────────────────────────
/* Profile view: full record + summary stats + complete history. */
async function getPatient(env, client, id) {
  const rows = await sbSelect(
    env,
    "patients",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
      ["select", PATIENT_SELECT],
      ["limit", "1"],
    ])
  );
  const patient = Array.isArray(rows) ? rows[0] : null;
  if (!patient) return jsonResponse({ error: "patient_not_found", id }, 404);

  const apptRows = await sbSelect(
    env,
    "appointments",
    query([
      ["client_id", `eq.${client.id}`],
      ["patient_id", `eq.${id}`],
      ["select", HISTORY_SELECT],
      ["order", "appointment_date.desc,time_slot.desc"],
    ])
  );
  const appointments = (Array.isArray(apptRows) ? apptRows : []).map(flattenHistory);

  const today = pktDateString(new Date());
  let totalVisits = 0;
  let upcoming = 0;
  let totalPaid = 0;
  for (const a of appointments) {
    if (a.status === "done") totalVisits += 1;
    if (a.status === "booked" && a.appointment_date >= today) upcoming += 1;
    if (a.payment_status === "paid") totalPaid += Number(a.fee) || 0;
  }

  return jsonResponse(
    {
      patient,
      stats: {
        total_visits: totalVisits,
        upcoming_appointments: upcoming,
        total_paid: totalPaid,
      },
      appointments,
      count: appointments.length,
    },
    200
  );
}

// ── POST /api/dashboard/patients ───────────────────────────────────
/* Manual add. An existing phone never creates a duplicate: the response
   comes back 200 {exists:true, patient} so the dashboard can show the
   "Patient already exists" message and open that profile instead. */
async function createPatient(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const check = validatePatientFields(body);
  if (check.error) return check.error;
  const { name, phone, age } = check.value;

  if (age < 14 && !check.value.guardian) {
    const guardian = body.guardian ? String(body.guardian).trim() : "";
    if (!guardian) {
      return badRequest({
        error: "guardian_required",
        message: "Guardian name is required for patients under 14.",
      });
    }
    check.value.guardian = guardian;
  }
  const guardian = check.value.guardian ?? null;

  let source = String(body.source ?? "walk-in").trim().toLowerCase();
  if (source === "walkin" || source === "walk in") source = "walk-in";
  if (!PATIENT_SOURCES.includes(source)) source = "walk-in";

  const existing = await findPatientByPhone(env, client.id, phone);
  if (existing) {
    return jsonResponse({ success: true, exists: true, patient: existing }, 200);
  }

  let patient;
  try {
    const inserted = await sbInsert(env, "patients", {
      client_id: client.id,
      name,
      phone,
      age,
      guardian,
      first_source: source,
    });
    patient = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Race: someone registered the same phone between our check + insert.
      const raced = await findPatientByPhone(env, client.id, phone);
      if (raced) return jsonResponse({ success: true, exists: true, patient: raced }, 200);
      return badRequest({ error: "phone_exists" });
    }
    throw err;
  }
  if (!patient || !patient.id) {
    return jsonResponse({ error: "insert_returned_no_row" }, 500);
  }
  return jsonResponse({ success: true, exists: false, patient }, 201);
}

// ── PATCH /api/dashboard/patients/{id} ─────────────────────────────
/* Edits name/phone/age/guardian/is_active. Changing the phone onto a
   number another patient already owns is refused (phone = identity). */
async function updatePatient(request, env, client, id) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const rows = await sbSelect(
    env,
    "patients",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
      ["select", PATIENT_SELECT],
      ["limit", "1"],
    ])
  );
  const current = Array.isArray(rows) ? rows[0] : null;
  if (!current) return jsonResponse({ error: "patient_not_found", id }, 404);

  const check = validatePatientFields(body, { partial: true });
  if (check.error) return check.error;
  const patch = check.value;

  if (patch.phone !== undefined && patch.phone !== current.phone) {
    const other = await findPatientByPhone(env, client.id, patch.phone);
    if (other && other.id !== id) {
      return badRequest({
        error: "phone_exists",
        existing_patient_id: other.id,
        message: "Another patient already uses this phone number.",
      });
    }
  }

  // Enforce the under-14 guardian rule against the EFFECTIVE values.
  const effAge = patch.age !== undefined ? patch.age : current.age;
  const effGuardian = "guardian" in patch ? patch.guardian : current.guardian;
  if (effAge !== null && effAge !== undefined && Number(effAge) < 14 && !effGuardian) {
    return badRequest({ error: "guardian_required", message: "Guardian name is required for patients under 14." });
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return badRequest({ error: "invalid_is_active", message: "is_active must be true or false." });
    }
    patch.is_active = body.is_active;
  }

  if (Object.keys(patch).length === 0) {
    return badRequest({ error: "no_fields_to_update" });
  }

  let updated;
  try {
    const patched = await sbPatch(
      env,
      "patients",
      query([
        ["id", `eq.${id}`],
        ["client_id", `eq.${client.id}`],
      ]),
      patch
    );
    updated = Array.isArray(patched) ? patched[0] : patched;
  } catch (err) {
    if (isUniqueViolation(err)) {
      return badRequest({ error: "phone_exists", message: "Another patient already uses this phone number." });
    }
    throw err;
  }
  if (!updated || !updated.id) return jsonResponse({ error: "patient_not_found", id }, 404);

  return jsonResponse({ success: true, patient: { ...current, ...updated } }, 200);
}

// ── DELETE /api/dashboard/patients/{id} ────────────────────────────
async function deletePatient(env, client, id) {
  const rows = await sbSelect(
    env,
    "patients",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
      ["select", "id,name"],
      ["limit", "1"],
    ])
  );
  const patient = Array.isArray(rows) ? rows[0] : null;
  if (!patient) return jsonResponse({ error: "patient_not_found", id }, 404);

  const appointmentCount = await sbCount(
    env,
    "appointments",
    query([
      ["client_id", `eq.${client.id}`],
      ["patient_id", `eq.${id}`],
    ])
  );
  if (appointmentCount > 0) {
    return jsonResponse(
      {
        error: "patient_has_appointments",
        patient_name: patient.name,
        count: appointmentCount,
        message: `${patient.name} has ${appointmentCount} appointment${appointmentCount === 1 ? "" : "s"} on record — deactivate them instead so the history stays.`,
      },
      409
    );
  }

  await sbDelete(
    env,
    "patients",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
    ])
  );
  return jsonResponse({ success: true, deleted_id: id }, 200);
}

/* Router for /api/dashboard/patients*. Called from handleApi after auth;
   anything it does not own falls through to the 404 there. */
export async function handlePatients(request, env, url, client) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/dashboard/patients" && method === "GET") {
    return listPatients(env, client, url);
  }
  if (pathname === "/api/dashboard/patients" && method === "POST") {
    return createPatient(request, env, client);
  }
  const match = /^\/api\/dashboard\/patients\/([^/]+)$/.exec(pathname);
  if (match && method === "GET") {
    return getPatient(env, client, decodeURIComponent(match[1]));
  }
  if (match && method === "PATCH") {
    return updatePatient(request, env, client, decodeURIComponent(match[1]));
  }
  if (match && method === "DELETE") {
    return deletePatient(env, client, decodeURIComponent(match[1]));
  }

  return jsonResponse({ error: "not_found", path: pathname, method }, 404);
}
