/* Appointments routes — /api/dashboard/appointments*
   The clinic-facing appointment book (separate from the voice agent's
   `bookings` table): patients are upserted by phone, slots are guarded by
   both a pre-insert check AND the partial unique index on
   (doctor_id, appointment_date, time_slot) WHERE status <> 'cancelled',
   so a slot can never end up double-booked even under concurrency.

   Response conventions match lib/dashboard routes:
     collections → { appointments: [...], count: n }
     mutations   → { success: true, appointment: {...} }
     failures    → { error: "<code>", message? } with a matching status */

import { jsonResponse, badRequest } from "../lib/response.js";
import { sbInsert, sbPatch, sbSelect } from "../lib/supabase.js";
import { addDaysStr, isValidDateStr, pktDateString, pktIso } from "../lib/pkt.js";
import {
  buildDaySchedule,
  clinicClosure,
  fetchDoctors,
  findConflictingBooking,
  generateSlots,
  isDoctorOnLeave,
  worksOnDate,
} from "../lib/slots.js";

const APPT_STATUSES = ["booked", "done", "cancelled", "no_show"];
const CANCEL_REASONS = ["patient_request", "doctor_unavailable", "no_response", "other"];
const CANCEL_REASON_LABELS = {
  patient_request: "Patient Request",
  doctor_unavailable: "Doctor Unavailable",
  no_response: "No Response",
  other: "Other",
};
const PAYMENT_METHODS = ["cash", "online", "pending"];
const PAYMENT_STATUSES = ["paid", "pending"];
const SOURCES = ["call", "walk-in", "website"];

const APPOINTMENT_SELECT =
  "id,client_id,patient_id,doctor_id,appointment_date,time_slot,fee,payment_method,payment_status,source,status,notes,cancellation_reason,updated_at,created_at,patients(name,phone,age,guardian),doctors(name,specialization)";

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

function flattenAppointment(row) {
  if (!row) return row;
  const { patients, doctors, ...rest } = row;
  return {
    ...rest,
    patient_name: patients?.name ?? null,
    patient_phone: patients?.phone ?? null,
    patient_age: patients?.age ?? null,
    guardian: patients?.guardian ?? null,
    doctor_name: doctors?.name ?? null,
    specialization: doctors?.specialization ?? null,
  };
}

const SLOT_TAKEN = () =>
  jsonResponse(
    {
      error: "slot_just_taken",
      message: "This slot was just booked. Please select another slot.",
    },
    409
  );

function isUniqueViolation(err) {
  return err && err.status === 409 && /23505|duplicate key/i.test(String(err.message || ""));
}

const LOCKED_MESSAGE =
  "Only booked appointments can be changed \u2014 done, cancelled and no-show records are permanent history.";

const lockedResponse = () =>
  jsonResponse({ error: "appointment_locked", message: LOCKED_MESSAGE }, 409);

async function fetchAppointmentRow(env, client, id) {
  const params = query([
    ["select", APPOINTMENT_SELECT],
    ["id", `eq.${id}`],
    ["client_id", `eq.${client.id}`],
    ["limit", "1"],
  ]);
  const rows = await sbSelect(env, "appointments", params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Live double-booking check for a (doctor, date, slot) write — the same
// protection the booking form uses. `excludeId` lets an appointment keep
// moving within its own slot row without blocking itself.
async function assertSlotFree(env, doctorId, dateStr, slot, excludeId) {
  const params = query([
    ["select", "id"],
    ["doctor_id", `eq.${doctorId}`],
    ["appointment_date", `eq.${dateStr}`],
    ["time_slot", `eq.${slot}`],
    ["status", "neq.cancelled"],
    ["limit", "2"],
  ]);
  if (excludeId) params.append("id", `neq.${excludeId}`);
  const rows = await sbSelect(env, "appointments", params);
  if (Array.isArray(rows) && rows.length) return false;
  const clash = await findConflictingBooking(env, doctorId, pktIso(dateStr, slot));
  return !clash;
}

// Free slots for one doctor-day: generated grid minus non-cancelled
// appointments (optionally excluding one row) minus voice bookings/past.
async function dayFreeSlots(env, doctor, dateStr, excludeId) {
  if (!worksOnDate(doctor, dateStr)) return [];
  const closure = await clinicClosure(env, doctor.client_id, dateStr);
  if (closure) return [];
  if (await isDoctorOnLeave(env, doctor.id, dateStr)) return [];
  const [schedule] = await buildDaySchedule(env, [doctor], dateStr);
  const busy = new Set(
    schedule.slots.filter((s) => s.status !== "free").map((s) => s.time)
  );
  const params = query([
    ["select", "time_slot"],
    ["doctor_id", `eq.${doctor.id}`],
    ["appointment_date", `eq.${dateStr}`],
    ["status", "neq.cancelled"],
  ]);
  if (excludeId) params.append("id", `neq.${excludeId}`);
  const rows = await sbSelect(env, "appointments", params);
  for (const r of Array.isArray(rows) ? rows : []) busy.add(r.time_slot);
  return generateSlots(doctor.timings, doctor.slot_duration_minutes).filter(
    (t) => !busy.has(t)
  );
}

// First working day after the appointment's own date (never in the past)
// with at least one free slot. Prefers the patient's original time.
async function findNextAvailableDay(env, doctor, fromDate, preferredSlot, excludeId) {
  const today = pktDateString(new Date());
  let cursor = addDaysStr(fromDate, 1);
  if (cursor < today) cursor = today;
  for (let i = 0; i < 30; i += 1, cursor = addDaysStr(cursor, 1)) {
    const free = await dayFreeSlots(env, doctor, cursor, excludeId);
    if (!free.length) continue;
    return { date: cursor, time_slot: free.includes(preferredSlot) ? preferredSlot : free[0] };
  }
  return null;
}

async function applyAppointmentPatch(env, id, clientId, patch) {
  let rows;
  try {
    rows = await sbPatch(
      env,
      "appointments",
      query([
        ["id", `eq.${id}`],
        ["client_id", `eq.${clientId}`],
        // Re-check the lock at write time — rows loaded earlier may have
        // been completed/cancelled by someone else.
        ["status", "eq.booked"],
      ]),
      patch
    );
  } catch (err) {
    if (isUniqueViolation(err)) return SLOT_TAKEN();
    throw err;
  }
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.id) return lockedResponse();
  return jsonResponse({ success: true, appointment: flattenAppointment(row) }, 200);
}

// Canonical patient-phone form: digits plus an optional leading '+',
// commas/parens stripped (PostgREST or= filter safety). Storing one
// canonical shape is what makes (client_id, phone) a real unique
// identifier — "0300 111-2223" and "03001112223" are the same patient.
export function cleanPhone(raw) {
  return String(raw ?? "").trim().replace(/[^\d+]/g, "");
}

export async function findPatientByPhone(env, clientId, phone) {
  const digits = phone.replace(/\D/g, "");
  const candidates = digits && digits !== phone ? [phone, digits] : [phone];
  const params = new URLSearchParams();
  params.set("select", "id,name,phone,age,guardian,first_source");
  params.set("client_id", `eq.${clientId}`);
  params.set(
    "or",
    `(${candidates.map((c) => `phone.eq.${c}`).join(",")})`
  );
  params.set("limit", "1");
  const rows = await sbSelect(env, "patients", params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// ── GET /api/dashboard/appointments ────────────────────────────────
/* Filters: ?date= (exact, defaults to today), ?from=&to=, ?doctor_id=,
   ?status=. Joins patient + doctor so one call feeds the whole table. */
async function listAppointments(env, client, url) {
  const params = new URLSearchParams();
  params.set("select", APPOINTMENT_SELECT);
  params.set("client_id", `eq.${client.id}`);
  params.set("order", "appointment_date.asc,time_slot.asc");

  const date = url.searchParams.get("date");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (date) {
    if (!isValidDateStr(date)) return badRequest({ error: "invalid_date", date });
    params.set("appointment_date", `eq.${date}`);
  } else if (from || to) {
    if (from && !isValidDateStr(from)) return badRequest({ error: "invalid_from", from });
    if (to && !isValidDateStr(to)) return badRequest({ error: "invalid_to", to });
    if (from) params.append("appointment_date", `gte.${from}`);
    if (to) params.append("appointment_date", `lte.${to}`);
  } else {
    // Default view: today (PKT).
    params.set("appointment_date", `eq.${pktDateString(new Date())}`);
  }

  const doctorId = url.searchParams.get("doctor_id");
  if (doctorId) params.set("doctor_id", `eq.${doctorId}`);

  const status = url.searchParams.get("status");
  if (status) {
    if (!APPT_STATUSES.includes(status)) {
      return badRequest({ error: "invalid_status", status, allowed: APPT_STATUSES });
    }
    params.set("status", `eq.${status}`);
  }

  const rows = await sbSelect(env, "appointments", params);
  const appointments = (Array.isArray(rows) ? rows : []).map(flattenAppointment);
  return jsonResponse({ appointments, count: appointments.length }, 200);
}

// ── GET /api/dashboard/appointments/slots?doctor_id=&date= ────────
/* Dynamic slot grid: generated from the doctor's timings + duration for
   exactly this date, merged against both the voice agent's bookings and
   this system's appointments. Never writes anything to the database. */
async function appointmentSlots(env, client, url) {
  const doctorId = String(url.searchParams.get("doctor_id") ?? "").trim();
  const dateStr = url.searchParams.get("date");
  if (!doctorId) return badRequest({ error: "missing_field", field: "doctor_id", message: "Pick a doctor." });
  if (!isValidDateStr(dateStr)) {
    return badRequest({ error: "invalid_date", date: dateStr, message: "Pick a valid date." });
  }

  const doctors = await fetchDoctors(env, client.id, { activeOnly: true });
  const doctor = doctors.find((d) => d.id === doctorId);
  if (!doctor) return jsonResponse({ error: "doctor_not_found", doctor_id: doctorId }, 404);

  const base = {
    date: dateStr,
    doctor_id: doctor.id,
    doctor_name: doctor.name,
    fee: doctor.fee ?? null,
    timings: doctor.timings ?? null,
    slot_duration_minutes: doctor.slot_duration_minutes ?? null,
    working_days: doctor.working_days ?? null,
  };

  // (a)/(b) Clinic holiday or closed day → no slots for anyone.
  const closure = await clinicClosure(env, client.id, dateStr);
  if (closure) {
    return jsonResponse(
      {
        ...base,
        working: false,
        on_leave: false,
        clinic_closed: true,
        closed_kind: closure.kind,
        closed_message: closure.message,
        slots: [],
      },
      200
    );
  }

  if (!worksOnDate(doctor, dateStr)) {
    return jsonResponse({ ...base, working: false, on_leave: false, slots: [] }, 200);
  }
  if (await isDoctorOnLeave(env, doctor.id, dateStr)) {
    return jsonResponse({ ...base, working: true, on_leave: true, slots: [] }, 200);
  }

  const [schedule] = await buildDaySchedule(env, [doctor], dateStr);
  const apptRows = await sbSelect(
    env,
    "appointments",
    query([
      ["select", "time_slot"],
      ["doctor_id", `eq.${doctor.id}`],
      ["appointment_date", `eq.${dateStr}`],
      ["status", "neq.cancelled"],
    ])
  );
  const taken = new Set((Array.isArray(apptRows) ? apptRows : []).map((a) => a.time_slot));

  // Customer names from voice bookings stay server-side — the grid only
  // needs free/booked/past.
  const slots = schedule.slots.map((s) => ({
    time: s.time,
    status: s.status === "free" && taken.has(s.time) ? "booked" : s.status,
  }));

  return jsonResponse({ ...base, working: true, on_leave: false, slots }, 200);
}

// ── POST /api/dashboard/appointments ───────────────────────────────
async function createAppointment(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const patientName = String(body.patient_name ?? "").trim();
  const phone = cleanPhone(body.phone);
  const ageRaw = Number(body.age);
  const age = Number.isInteger(ageRaw) ? ageRaw : NaN;
  const guardian = body.guardian ? String(body.guardian).trim() : null;

  if (!patientName) {
    return badRequest({ error: "missing_field", field: "patient_name", message: "Patient name is required." });
  }
  if (!phone) {
    return badRequest({ error: "missing_field", field: "phone", message: "Phone number is required." });
  }
  if (Number.isNaN(age) || age < 0 || age > 120) {
    return badRequest({ error: "invalid_age", age: body.age ?? null, message: "Age must be a number between 0 and 120." });
  }
  if (age < 14 && !guardian) {
    return badRequest({
      error: "guardian_required",
      message: "Guardian name is required for patients under 14.",
    });
  }

  const doctorId = String(body.doctor_id ?? "").trim();
  const dateStr = String(body.appointment_date ?? "").trim();
  const slot = String(body.time_slot ?? "").trim();
  if (!doctorId) {
    return badRequest({ error: "missing_field", field: "doctor_id", message: "Pick a doctor." });
  }
  if (!isValidDateStr(dateStr)) {
    return badRequest({ error: "invalid_date", date: dateStr, message: "Pick a valid date." });
  }

  const doctors = await fetchDoctors(env, client.id, { activeOnly: true });
  const doctor = doctors.find((d) => d.id === doctorId);
  if (!doctor) return jsonResponse({ error: "doctor_not_found", doctor_id: doctorId }, 404);

  if (!worksOnDate(doctor, dateStr)) {
    return badRequest({
      error: "doctor_not_working",
      message: `${doctor.name} does not work on the selected date.`,
    });
  }
  const closure = await clinicClosure(env, client.id, dateStr);
  if (closure) {
    return badRequest({ error: "clinic_closed", message: closure.message });
  }
  const validSlots = generateSlots(doctor.timings, doctor.slot_duration_minutes);
  if (!/^\d{1,2}:\d{2}$/.test(slot) || !validSlots.includes(slot)) {
    return badRequest({
      error: "invalid_time_slot",
      time_slot: slot,
      slots: validSlots,
      message: "Pick one of the available time slots.",
    });
  }
  if (await isDoctorOnLeave(env, doctor.id, dateStr)) {
    return badRequest({ error: "doctor_on_leave", message: `${doctor.name} is on leave on the selected date.` });
  }

  let fee = body.fee;
  if (fee === undefined || fee === null || fee === "") fee = doctor.fee ?? null;
  const feeNum = Number(fee);
  if (fee !== null && (!Number.isFinite(feeNum) || feeNum < 0)) {
    return badRequest({ error: "invalid_fee", fee: body.fee, message: "Fee must be a positive number." });
  }
  fee = fee === null ? null : Math.round(feeNum);

  const method = String(body.payment_method ?? "pending").trim().toLowerCase();
  if (!PAYMENT_METHODS.includes(method)) {
    return badRequest({ error: "invalid_payment_method", payment_method: method, allowed: PAYMENT_METHODS });
  }
  let source = String(body.source ?? "call").trim().toLowerCase();
  if (source === "walkin" || source === "walk in") source = "walk-in";
  if (!SOURCES.includes(source)) {
    return badRequest({ error: "invalid_source", source, allowed: SOURCES });
  }
  const notes = body.notes ? String(body.notes).trim().slice(0, 2000) : null;

  // ── Double-booking protection (pre-insert check) ──
  const clash = await sbSelect(
    env,
    "appointments",
    query([
      ["select", "id"],
      ["doctor_id", `eq.${doctor.id}`],
      ["appointment_date", `eq.${dateStr}`],
      ["time_slot", `eq.${slot}`],
      ["status", "neq.cancelled"],
      ["limit", "1"],
    ])
  );
  if (Array.isArray(clash) && clash.length > 0) return SLOT_TAKEN();

  // The voice agent books into `bookings` — that slot is taken too.
  const voiceBooking = await findConflictingBooking(env, doctor.id, pktIso(dateStr, slot));
  if (voiceBooking) return SLOT_TAKEN();

  // ── Patient auto-add: match by phone, create when new ──
  let patient = await findPatientByPhone(env, client.id, phone);
  let createdPatient = false;
  if (!patient) {
    const inserted = await sbInsert(env, "patients", {
      client_id: client.id,
      name: patientName,
      phone,
      age,
      guardian,
      first_source: source,
    });
    patient = Array.isArray(inserted) ? inserted[0] : inserted;
    createdPatient = true;
  }
  if (!patient || !patient.id) {
    return jsonResponse({ error: "patient_save_failed" }, 500);
  }

  let row;
  try {
    const inserted = await sbInsert(env, "appointments", {
      client_id: client.id,
      patient_id: patient.id,
      doctor_id: doctor.id,
      appointment_date: dateStr,
      time_slot: slot,
      fee,
      payment_method: method,
      payment_status: "pending",
      source,
      status: "booked",
      notes,
    });
    row = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    // Partial unique index fired → someone took the slot between our
    // check and the insert.
    if (isUniqueViolation(err)) return SLOT_TAKEN();
    throw err;
  }
  if (!row || !row.id) {
    return jsonResponse({ error: "insert_returned_no_row" }, 500);
  }

  return jsonResponse(
    {
      success: true,
      created_patient: createdPatient,
      appointment: {
        id: row.id,
        appointment_date: dateStr,
        time_slot: slot,
        fee,
        payment_method: method,
        payment_status: "pending",
        source,
        status: "booked",
        notes,
        patient_id: patient.id,
        doctor_id: doctor.id,
        patient_name: patient.name,
        patient_phone: patient.phone,
        doctor_name: doctor.name,
      },
      summary: {
        patient_name: patient.name,
        doctor_name: doctor.name,
        appointment_date: dateStr,
        time_slot: slot,
        fee,
      },
    },
    201
  );
}

// ── action helpers (detail view) ───────────────────────────────────
async function validateTargetSlot(env, doctor, dateStr, slot, excludeId) {
  if (!isValidDateStr(dateStr)) {
    return badRequest({ error: "invalid_date", date: dateStr, message: "Pick a valid date." });
  }
  if (!/^\d{1,2}:\d{2}$/.test(slot)) {
    return badRequest({ error: "invalid_time_slot", time_slot: slot, message: "Pick a time slot." });
  }
  const closure = await clinicClosure(env, doctor.client_id, dateStr);
  if (closure) {
    return badRequest({ error: "clinic_closed", message: closure.message });
  }
  if (!worksOnDate(doctor, dateStr)) {
    return badRequest({
      error: "doctor_not_working",
      message: `${doctor.name} does not work on the selected date.`,
    });
  }
  const valid = generateSlots(doctor.timings, doctor.slot_duration_minutes);
  if (!valid.includes(slot)) {
    return badRequest({
      error: "invalid_time_slot",
      time_slot: slot,
      slots: valid,
      message: "Pick one of the available time slots.",
    });
  }
  if (await isDoctorOnLeave(env, doctor.id, dateStr)) {
    return badRequest({ error: "doctor_on_leave", message: `${doctor.name} is on leave on the selected date.` });
  }
  if (!(await assertSlotFree(env, doctor.id, dateStr, slot, excludeId))) return SLOT_TAKEN();
  return null;
}

async function runAppointmentAction(body, env, client, row) {
  const action = String(body.action ?? "").trim();
  const now = new Date().toISOString();
  const doctors = await fetchDoctors(env, client.id, { activeOnly: true });
  const currentDoctor = doctors.find((d) => d.id === row.doctor_id) || null;

  if (action === "done") {
    const received = body.payment_received === true || body.payment_received === "true";
    let method = String(body.payment_method ?? "cash").trim().toLowerCase();
    if (method !== "cash" && method !== "online") method = "cash";
    const patch = {
      status: "done",
      payment_status: received ? "paid" : "pending",
      payment_method: received ? method : (row.payment_method || "pending"),
      updated_at: now,
    };
    if (body.fee !== undefined && body.fee !== null && body.fee !== "") {
      const feeNum = Number(body.fee);
      if (!Number.isFinite(feeNum) || feeNum < 0) {
        return badRequest({ error: "invalid_fee", fee: body.fee, message: "Amount must be a positive number." });
      }
      patch.fee = Math.round(feeNum);
    }
    return applyAppointmentPatch(env, row.id, client.id, patch);
  }

  if (action === "no_show") {
    return applyAppointmentPatch(env, row.id, client.id, { status: "no_show", updated_at: now });
  }

  if (action === "cancel") {
    const reasonKey = String(body.reason ?? "").trim().toLowerCase();
    if (!CANCEL_REASONS.includes(reasonKey)) {
      return badRequest({
        error: "invalid_reason",
        reason: reasonKey,
        allowed: CANCEL_REASONS,
        message: "Pick a cancellation reason.",
      });
    }
    const note = body.note ? String(body.note).trim().slice(0, 500) : "";
    let label = CANCEL_REASON_LABELS[reasonKey];
    if (note) label = reasonKey === "other" ? `Other: ${note}` : `${label}: ${note}`;
    return applyAppointmentPatch(env, row.id, client.id, {
      status: "cancelled",
      cancellation_reason: label,
      updated_at: now,
    });
  }

  if (action === "reschedule") {
    if (!currentDoctor) return jsonResponse({ error: "doctor_not_found", doctor_id: row.doctor_id }, 404);
    const dateStr = String(body.appointment_date ?? "").trim();
    const slot = String(body.time_slot ?? "").trim();
    const invalid = await validateTargetSlot(env, currentDoctor, dateStr, slot, row.id);
    if (invalid) return invalid;
    return applyAppointmentPatch(env, row.id, client.id, {
      appointment_date: dateStr,
      time_slot: slot,
      updated_at: now,
    });
  }

  if (action === "reassign") {
    const targetId = String(body.doctor_id ?? "").trim();
    const target = doctors.find((d) => d.id === targetId);
    if (!target) return badRequest({ error: "invalid_doctor", message: "Pick an active doctor." });
    const dateStr = body.appointment_date
      ? String(body.appointment_date).trim()
      : row.appointment_date;
    const slot = String(body.time_slot ?? "").trim();
    const invalid = await validateTargetSlot(env, target, dateStr, slot, row.id);
    if (invalid) return invalid;
    let fee;
    if (body.fee === undefined || body.fee === null || body.fee === "") {
      fee = target.fee ?? row.fee ?? null;
    } else {
      const feeNum = Number(body.fee);
      if (!Number.isFinite(feeNum) || feeNum < 0) {
        return badRequest({ error: "invalid_fee", fee: body.fee, message: "Fee must be a positive number." });
      }
      fee = Math.round(feeNum);
    }
    return applyAppointmentPatch(env, row.id, client.id, {
      doctor_id: target.id,
      appointment_date: dateStr,
      time_slot: slot,
      fee,
      updated_at: now,
    });
  }

  if (action === "move_next_day") {
    if (!currentDoctor) return jsonResponse({ error: "doctor_not_found", doctor_id: row.doctor_id }, 404);
    const found = await findNextAvailableDay(env, currentDoctor, row.appointment_date, row.time_slot, row.id);
    if (!found) {
      return jsonResponse({
        error: "no_available_slot",
        message: `${currentDoctor.name} has no free slots in the next 30 days.`,
      }, 409);
    }
    const invalid = await validateTargetSlot(env, currentDoctor, found.date, found.time_slot, row.id);
    if (invalid) return invalid;
    return applyAppointmentPatch(env, row.id, client.id, {
      appointment_date: found.date,
      time_slot: found.time_slot,
      updated_at: now,
    });
  }

  return badRequest({ error: "invalid_action", action, message: "Unknown appointment action." });
}

// ── PATCH /api/dashboard/appointments/{id} ─────────────────────────
/* Legacy field patch {status?, payment_status?} and the detail-view
   action patch {action: done|cancel|no_show|reschedule|reassign|move_next_day}.
   Only booked rows are mutable — done/cancelled/no_show are permanent. */
async function updateAppointment(request, env, client, id) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const row = await fetchAppointmentRow(env, client, id);
  if (!row) return jsonResponse({ error: "not_found", id }, 404);
  if (row.status !== "booked") return lockedResponse();

  if (body.action !== undefined) return runAppointmentAction(body, env, client, row);

  const patch = {};
  if (body.status !== undefined) {
    const status = String(body.status ?? "").trim();
    if (!APPT_STATUSES.includes(status)) {
      return badRequest({ error: "invalid_status", status, allowed: APPT_STATUSES });
    }
    patch.status = status;
  }
  if (body.payment_status !== undefined) {
    const paymentStatus = String(body.payment_status ?? "").trim();
    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
      return badRequest({
        error: "invalid_payment_status",
        payment_status: paymentStatus,
        allowed: PAYMENT_STATUSES,
      });
    }
    patch.payment_status = paymentStatus;
  }
  if (Object.keys(patch).length === 0) {
    return badRequest({ error: "no_fields_to_update" });
  }
  patch.updated_at = new Date().toISOString();
  return applyAppointmentPatch(env, row.id, client.id, patch);
}

// ── POST /api/dashboard/appointments/bulk ──────────────────────────
/* "Doctor unavailable" batch tool.
   body: { action: reassign|move_next_day|cancel, appointment_ids: [...],
           doctor_id, date, target_doctor_id?, preview? }
   preview=true computes the plan without writing; apply re-validates
   every row live (status + slot clash) immediately before each write. */
async function bulkAppointments(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const action = String(body.action ?? "").trim();
  if (!["reassign", "move_next_day", "cancel"].includes(action)) {
    return badRequest({
      error: "invalid_action",
      action,
      allowed: ["reassign", "move_next_day", "cancel"],
    });
  }
  const ids = Array.isArray(body.appointment_ids)
    ? body.appointment_ids.map(String).filter(Boolean).slice(0, 200)
    : [];
  if (!ids.length) {
    return badRequest({
      error: "missing_field",
      field: "appointment_ids",
      message: "Select at least one appointment.",
    });
  }
  const dateStr = String(body.date ?? "").trim();
  const doctorId = String(body.doctor_id ?? "").trim();
  if (!doctorId || !isValidDateStr(dateStr)) {
    return badRequest({ error: "missing_field", field: "doctor_id", message: "Pick a doctor and a date." });
  }
  const preview = body.preview === true;
  const now = new Date().toISOString();

  const fetched = await sbSelect(env, "appointments", query([
    ["select", APPOINTMENT_SELECT],
    ["client_id", `eq.${client.id}`],
    ["id", `in.(${ids.join(",")})`],
    ["order", "time_slot.asc"],
  ]));
  const rows = Array.isArray(fetched) ? fetched : [];
  const doctors = await fetchDoctors(env, client.id, { activeOnly: true });
  const sourceDoctor = doctors.find((d) => d.id === doctorId) || null;

  const plan = [];
  const actionable = [];
  const seen = new Set();
  for (const r of rows) {
    seen.add(r.id);
    const entry = {
      id: r.id,
      patient_name: r.patients?.name ?? null,
      patient_phone: r.patients?.phone ?? null,
      time_slot: r.time_slot,
      appointment_date: r.appointment_date,
      fee: r.fee ?? null,
    };
    if (r.status !== "booked" || r.doctor_id !== doctorId || r.appointment_date !== dateStr) {
      plan.push({ ...entry, outcome: "manual", reason: "not_booked" });
      continue;
    }
    actionable.push({ row: r, entry });
  }
  for (const id of ids) {
    if (!seen.has(id)) plan.push({ id, outcome: "manual", reason: "not_found" });
  }

  if (action === "cancel") {
    for (const { entry } of actionable) plan.push({ ...entry, outcome: "ok" });
  } else if (action === "move_next_day") {
    if (!sourceDoctor) return badRequest({ error: "invalid_doctor", message: "Doctor not found." });
    for (const { row, entry } of actionable) {
      const found = await findNextAvailableDay(
        env, sourceDoctor, row.appointment_date, row.time_slot, row.id
      );
      if (found) {
        plan.push({ ...entry, outcome: "ok", new_date: found.date, new_time_slot: found.time_slot });
      } else {
        plan.push({ ...entry, outcome: "manual", reason: "no_free_slot" });
      }
    }
  } else {
    // reassign
    const targetId = String(body.target_doctor_id ?? "").trim();
    const target = doctors.find((d) => d.id === targetId);
    if (!target) {
      return badRequest({ error: "invalid_doctor", message: "Pick a doctor to reassign to." });
    }
    if (!sourceDoctor) return badRequest({ error: "invalid_doctor", message: "Doctor not found." });
    let free = null;
    if (!worksOnDate(target, dateStr)) free = null;
    else if (await isDoctorOnLeave(env, target.id, dateStr)) free = null;
    else free = await dayFreeSlots(env, target, dateStr, null);

    for (const { row, entry } of actionable) {
      if (free === null) {
        plan.push({ ...entry, outcome: "manual", reason: "target_unavailable" });
        continue;
      }
      let newTime = null;
      if (free.includes(row.time_slot)) newTime = row.time_slot;
      else if (free.length) newTime = free[0];
      if (!newTime) {
        plan.push({ ...entry, outcome: "manual", reason: "no_room" });
        continue;
      }
      free.splice(free.indexOf(newTime), 1);
      plan.push({
        ...entry,
        outcome: "ok",
        new_date: dateStr,
        new_time_slot: newTime,
        new_doctor_id: target.id,
        new_doctor_name: target.name,
        new_fee: target.fee ?? row.fee ?? null,
        fee_changed: (target.fee ?? null) !== (row.fee ?? null),
      });
    }
  }

  const summary = {
    total: plan.length,
    ready: plan.filter((p) => p.outcome === "ok").length,
    manual: plan.filter((p) => p.outcome === "manual").length,
  };

  if (preview) {
    return jsonResponse({ success: true, preview: true, summary, plan }, 200);
  }

  // ── apply: re-validate each row live right before its write ──
  let applied = 0;
  let failed = 0;
  for (const item of plan) {
    if (item.outcome !== "ok") continue;
    let patch = { updated_at: now };
    if (action === "cancel") {
      patch = { status: "cancelled", cancellation_reason: "Doctor Unavailable", updated_at: now };
    } else if (action === "move_next_day") {
      if (!(await assertSlotFree(env, doctorId, item.new_date, item.new_time_slot, item.id))) {
        item.outcome = "manual";
        item.reason = "slot_just_taken";
        failed += 1;
        continue;
      }
      patch = { appointment_date: item.new_date, time_slot: item.new_time_slot, updated_at: now };
    } else {
      if (!(await assertSlotFree(env, item.new_doctor_id, item.new_date, item.new_time_slot, item.id))) {
        item.outcome = "manual";
        item.reason = "slot_just_taken";
        failed += 1;
        continue;
      }
      patch = {
        doctor_id: item.new_doctor_id,
        appointment_date: item.new_date,
        time_slot: item.new_time_slot,
        fee: item.new_fee,
        updated_at: now,
      };
    }
    try {
      const rows2 = await sbPatch(env, "appointments", query([
        ["id", `eq.${item.id}`],
        ["client_id", `eq.${client.id}`],
        ["status", "eq.booked"],
      ]), patch);
      if (Array.isArray(rows2) && rows2.length) applied += 1;
      else {
        item.outcome = "manual";
        item.reason = "not_booked";
        failed += 1;
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        item.outcome = "manual";
        item.reason = "slot_just_taken";
        failed += 1;
      } else {
        throw err;
      }
    }
  }

  return jsonResponse({
    success: true,
    preview: false,
    summary: { ...summary, applied, failed, manual: summary.manual + failed },
    plan,
  }, 200);
}

/* Router for /api/dashboard/appointments*. Called from handleApi after
   auth; anything it does not own falls through to the 404 there. */
export async function handleAppointments(request, env, url, client) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/dashboard/appointments" && method === "GET") {
    return listAppointments(env, client, url);
  }
  if (pathname === "/api/dashboard/appointments" && method === "POST") {
    return createAppointment(request, env, client);
  }
  if (pathname === "/api/dashboard/appointments/slots" && method === "GET") {
    return appointmentSlots(env, client, url);
  }
  if (pathname === "/api/dashboard/appointments/bulk" && method === "POST") {
    return bulkAppointments(request, env, client);
  }
  const match = /^\/api\/dashboard\/appointments\/([^/]+)$/.exec(pathname);
  if (match && method === "PATCH") {
    return updateAppointment(request, env, client, decodeURIComponent(match[1]));
  }

  return jsonResponse({ error: "not_found", path: pathname, method }, 404);
}
