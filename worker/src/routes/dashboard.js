/* Dashboard routes — everything under /api/dashboard/* is gated by
   X-Client-Id / X-Client-Password (see lib/auth.js) and is scoped to that
   client only, so one clinic can never read or mutate another's rows.

   /api/login is public (it is how you get credentials to send), and
   /api/change-password authenticates with the header like the rest.

   Response conventions:
     * collections → { <name>: [...], count: n }
     * mutations   → { success: true, <entity>: {...} }
     * failures    → { error: "<code>", ... } with a matching HTTP status */

import { jsonResponse, badRequest, unauthorized } from "../lib/response.js";
import { sbCount, sbDelete, sbInsert, sbPatch, sbSelect } from "../lib/supabase.js";
import { findClient, publicClient, validateClient } from "../lib/auth.js";
import { withDefaults } from "../lib/agentConfig.js";
import {
  PKT_TZ_NAME,
  addDaysStr,
  isValidDateStr,
  nextDateStr,
  parseHmToMinutes,
  pktDateString,
  pktDayBounds,
  pktHmFromInstant,
  pktIso,
  pktMonthBounds,
} from "../lib/pkt.js";
import { ACTIVE_OR_UNSET, buildDaySchedule, fetchClinicSettings, fetchDoctors, WORKING_DAY_KEYS } from "../lib/slots.js";
import { handleAppointments } from "./appointments.js";
import { handlePatients } from "./patients.js";

const BOOKING_STATUSES = ["confirmed", "cancelled", "completed"];
const DOCTOR_STATUSES = ["active", "inactive"];

const BOOKING_SELECT =
  "id,client_id,doctor_id,customer_name,phone,details_json,slot_time,status,created_at,doctors(name)";

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    return body;
  } catch (e) {
    return null;
  }
}

function flattenBooking(row) {
  if (!row) return row;
  const { doctors, ...rest } = row;
  return { ...rest, doctor_name: doctors ? doctors.name ?? null : null };
}

function query(params) {
  const p = new URLSearchParams();
  for (const [k, v] of params) p.append(k, v);
  return p;
}

// ── POST /api/login ──────────────────────────────────────────────────
async function login(request, env) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const clientId = String(body.client_id ?? "").trim();
  const password = String(body.password ?? "");
  if (!clientId || !password) {
    return badRequest({ error: "missing_fields", fields: ["client_id", "password"] });
  }

  const client = await findClient(env, clientId, password);
  if (!client) return unauthorized();

  return jsonResponse({
    success: true,
    client_id: client.id,
    business_name: client.business_name ?? null,
    industry: client.industry ?? null,
    status: client.status ?? null,
  });
}

// ── GET /api/dashboard/stats ─────────────────────────────────────────
/* Counts are PKT-calendar based and ignore cancelled bookings:
     today        → today 00:00 PKT → tomorrow 00:00 PKT
     next7        → today 00:00 PKT → today+7d 00:00 PKT  (today + 6 more)
     this_month   → 1st of PKT month → 1st of next PKT month */
async function countBookingsBetween(env, clientId, startIso, endIso) {
  return sbCount(
    env,
    "bookings",
    query([
      ["client_id", `eq.${clientId}`],
      ["status", "neq.cancelled"],
      ["slot_time", `gte.${startIso}`],
      ["slot_time", `lt.${endIso}`],
    ])
  );
}

async function stats(env, client) {
  const today = pktDateString(new Date());
  const todayBounds = pktDayBounds(today);
  const next7End = pktDayBounds(addDaysStr(today, 7)).start;
  const month = pktMonthBounds(today);

  const [todayCount, next7Count, monthCount, activeDoctors] = await Promise.all([
    countBookingsBetween(env, client.id, todayBounds.start, todayBounds.end),
    countBookingsBetween(env, client.id, todayBounds.start, next7End),
    countBookingsBetween(env, client.id, month.start, month.end),
    sbCount(
      env,
      "doctors",
      query([
        ["client_id", `eq.${client.id}`],
        ["or", ACTIVE_OR_UNSET],
      ])
    ),
  ]);

  return jsonResponse(
    {
      today: todayCount,
      next7: next7Count,
      this_month: monthCount,
      active_doctors: activeDoctors,
      date: today,
      timezone: PKT_TZ_NAME,
    },
    200
  );
}

// ── GET /api/dashboard/bookings?from&to&doctor_id&status&q ───────────
async function listBookings(env, client, url) {
  const params = query([["client_id", `eq.${client.id}`]]);
  params.set("select", BOOKING_SELECT);
  params.set("order", "slot_time.asc");

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if (from) {
    if (!isValidDateStr(from)) return badRequest({ error: "invalid_from", from });
    params.append("slot_time", `gte.${pktIso(from, "00:00")}`);
  }
  if (to) {
    if (!isValidDateStr(to)) return badRequest({ error: "invalid_to", to });
    params.append("slot_time", `lt.${pktIso(nextDateStr(to), "00:00")}`);
  }

  const status = url.searchParams.get("status");
  if (status) {
    if (!BOOKING_STATUSES.includes(status)) {
      return badRequest({ error: "invalid_status", status });
    }
    params.set("status", `eq.${status}`);
  }

  const doctorId = url.searchParams.get("doctor_id");
  if (doctorId) params.set("doctor_id", `eq.${doctorId}`);

  const rows = await sbSelect(env, "bookings", params);
  let bookings = (Array.isArray(rows) ? rows : []).map(flattenBooking);

  // `q` is matched in the worker so we can search phone digits and names
  // case-insensitively without a full-text index.
  const q = String(url.searchParams.get("q") ?? "").trim().toLowerCase();
  if (q) {
    bookings = bookings.filter((b) => {
      const haystack = `${b.customer_name ?? ""} ${b.phone ?? ""}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  return jsonResponse({ bookings, count: bookings.length }, 200);
}

// ── PATCH /api/dashboard/bookings/{id} ───────────────────────────────
async function updateBooking(request, env, client, id) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const status = String(body.status ?? "").trim();
  if (!BOOKING_STATUSES.includes(status)) {
    return badRequest({ error: "invalid_status", status, allowed: BOOKING_STATUSES });
  }

  const patch = { status };
  // Optional reschedule: slot_iso must carry an offset, same rule as /api/book.
  if (body.slot_iso !== undefined && body.slot_iso !== null && body.slot_iso !== "") {
    const slotIso = String(body.slot_iso).trim();
    if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(slotIso) || Number.isNaN(Date.parse(slotIso))) {
      return badRequest({ error: "invalid_slot_iso", slot_iso: slotIso });
    }
    patch.slot_time = slotIso;
  }

  const rows = await sbPatch(
    env,
    "bookings",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
    ]),
    patch
  );

  // Filter matched nothing → PostgREST answers 204 with an empty body.
  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.id) return jsonResponse({ error: "not_found", id }, 404);

  return jsonResponse({ success: true, booking: row }, 200);
}

// ── GET|POST /api/dashboard/doctors, PATCH /{id} ─────────────────────
async function listDoctors(env, client) {
  const doctors = await fetchDoctors(env, client.id);
  return jsonResponse({ doctors, count: doctors.length }, 200);
}

// Accepts {start:"17:00",end:"21:00"} or "17:00-21:00".
function normalizeTimings(raw) {
  let start;
  let end;
  if (typeof raw === "string") {
    const m = /^\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s*$/.exec(raw);
    if (!m) return null;
    start = m[1];
    end = m[2];
  } else if (raw && typeof raw === "object") {
    start = String(raw.start ?? "").trim();
    end = String(raw.end ?? "").trim();
  } else {
    return null;
  }
  const s = parseHmToMinutes(start);
  const e = parseHmToMinutes(end);
  if (s === null || e === null || e <= s) return null;
  const pad = (hm) => {
    const [h, mi] = hm.split(":");
    return `${String(Number(h)).padStart(2, "0")}:${mi}`;
  };
  return { start: pad(start), end: pad(end) };
}

function normalizeFee(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined; // invalid
  return Math.round(n);
}

/* working_days: ["mon",…] → canonical MON…SUN order, null → every day
   (legacy rows), anything invalid → undefined (→ 400). A doctor with no
   working day could never be booked, so an empty array is rejected. */
function normalizeWorkingDays(raw) {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (!Array.isArray(raw)) return undefined;
  const wanted = new Set();
  for (const d of raw) {
    const key = String(d ?? "").trim().toLowerCase();
    if (!WORKING_DAY_KEYS.includes(key)) return undefined;
    wanted.add(key);
  }
  if (wanted.size === 0) return undefined;
  return WORKING_DAY_KEYS.filter((k) => wanted.has(k));
}

/* Clinic-rule validation (Settings → Clinic Timings): a doctor's working
   days must be clinic open days and their hours inside the clinic's
   open–close window. No clinic settings saved yet → no constraint. */
async function validateDoctorAgainstClinic(env, clientId, doctorName, timings, workingDays) {
  const settings = await fetchClinicSettings(env, clientId);
  if (!settings) return null;

  const openDays = Array.isArray(settings.open_days) ? settings.open_days : null;
  if (openDays && openDays.length) {
    // NULL working_days means "every day" — that includes clinic-closed days.
    const effDays = workingDays && workingDays.length ? workingDays : WORKING_DAY_KEYS;
    const closed = effDays.filter((d) => !openDays.includes(d));
    if (closed.length > 0) {
      return badRequest({
        error: "doctor_on_closed_day",
        working_days: closed,
        message: `${doctorName} is scheduled on clinic-closed day(s): ${closed.join(", ")} — change the doctor\u2019s working days or the clinic timings.`,
      });
    }
  }

  const open = parseHmToMinutes(settings.open_time);
  const close = parseHmToMinutes(settings.close_time);
  if (timings && open !== null && close !== null) {
    const s = parseHmToMinutes(timings.start);
    const e = parseHmToMinutes(timings.end);
    if (s !== null && e !== null && (s < open || e > close)) {
      return badRequest({
        error: "outside_clinic_hours",
        clinic_hours: { open: settings.open_time, close: settings.close_time },
        message: `Clinic hours are ${settings.open_time}\u2013${settings.close_time} — ${doctorName}\u2019s ${timings.start}\u2013${timings.end} schedule falls outside them.`,
      });
    }
  }
  return null;
}

async function createDoctor(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const name = String(body.name ?? "").trim();
  if (!name) return badRequest({ error: "missing_field", field: "name" });

  const timings = normalizeTimings(body.timings);
  if (!timings) {
    return badRequest({
      error: "invalid_timings",
      detail: 'timings must be {start:"HH:MM", end:"HH:MM"} with end after start',
      timings: body.timings ?? null,
    });
  }

  const fee = normalizeFee(body.fee);
  if (fee === undefined || fee === null) {
    return badRequest({
      error: "invalid_fee",
      fee: body.fee ?? null,
      detail: "fee (PKR) is required when creating a doctor",
    });
  }

  // Omitted working_days on create = every day (same as legacy NULL);
  // only a genuinely invalid array is rejected.
  const workingDays =
    body.working_days === undefined || body.working_days === null || body.working_days === ""
      ? null
      : normalizeWorkingDays(body.working_days);
  if (workingDays === undefined) {
    return badRequest({ error: "invalid_working_days", working_days: body.working_days ?? null });
  }

  const duration = Number(body.slot_duration_minutes);
  const clinicViolation = await validateDoctorAgainstClinic(
    env,
    client.id,
    name,
    timings,
    workingDays === undefined ? null : workingDays
  );
  if (clinicViolation) return clinicViolation;

  const rows = await sbInsert(env, "doctors", {
    client_id: client.id,
    name,
    specialization: body.specialization ? String(body.specialization).trim() : null,
    qualification: body.qualification ? String(body.qualification).trim() : null,
    timings,
    slot_duration_minutes: Number.isFinite(duration) && duration > 0 ? duration : 30,
    fee,
    status: DOCTOR_STATUSES.includes(body.status) ? body.status : "active",
    phone: body.phone ? String(body.phone).trim() : null,
    working_days: workingDays,
  });

  const row = Array.isArray(rows) ? rows[0] : rows;
  return jsonResponse({ success: true, doctor: row ?? null }, 201);
}

async function updateDoctor(request, env, client, id) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const patch = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim();
    if (!name) return badRequest({ error: "invalid_name" });
    patch.name = name;
  }
  if (body.specialization !== undefined) {
    patch.specialization = body.specialization
      ? String(body.specialization).trim()
      : null;
  }
  if (body.qualification !== undefined) {
    patch.qualification = body.qualification
      ? String(body.qualification).trim()
      : null;
  }
  if (body.phone !== undefined) {
    patch.phone = body.phone ? String(body.phone).trim() : null;
  }
  if (body.working_days !== undefined) {
    const days = normalizeWorkingDays(body.working_days);
    if (days === undefined) {
      return badRequest({ error: "invalid_working_days", working_days: body.working_days });
    }
    patch.working_days = days;
  }
  if (body.timings !== undefined) {
    const timings = normalizeTimings(body.timings);
    if (!timings) return badRequest({ error: "invalid_timings", timings: body.timings });
    patch.timings = timings;
  }
  if (body.slot_duration_minutes !== undefined) {
    const d = Number(body.slot_duration_minutes);
    if (!Number.isFinite(d) || d <= 0) {
      return badRequest({ error: "invalid_slot_duration", slot_duration_minutes: body.slot_duration_minutes });
    }
    patch.slot_duration_minutes = d;
  }
  if (body.fee !== undefined) {
    const fee = normalizeFee(body.fee);
    if (fee === undefined) return badRequest({ error: "invalid_fee", fee: body.fee });
    patch.fee = fee;
  }
  if (body.status !== undefined) {
    const status = String(body.status ?? "").trim();
    if (!DOCTOR_STATUSES.includes(status)) {
      return badRequest({ error: "invalid_status", status, allowed: DOCTOR_STATUSES });
    }
    patch.status = status;
  }

  if (Object.keys(patch).length === 0) {
    return badRequest({ error: "no_fields_to_update" });
  }

  // Clinic rules only need re-checking when the schedule itself changed.
  if (patch.working_days !== undefined || patch.timings !== undefined) {
    const existingRows = await sbSelect(env, "doctors", query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
      ["select", "name,timings,working_days"],
      ["limit", "1"],
    ]));
    const existing = Array.isArray(existingRows) ? existingRows[0] : null;
    if (existing) {
      const clinicViolation = await validateDoctorAgainstClinic(
        env,
        client.id,
        patch.name ?? existing.name,
        patch.timings !== undefined ? patch.timings : existing.timings,
        patch.working_days !== undefined ? patch.working_days : existing.working_days
      );
      if (clinicViolation) return clinicViolation;
    }
  }

  const rows = await sbPatch(
    env,
    "doctors",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
    ]),
    patch
  );

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.id) return jsonResponse({ error: "not_found", id }, 404);

  return jsonResponse({ success: true, doctor: row }, 200);
}

/* ── DELETE /api/dashboard/doctors/{id} ────────────────────────────
   Deleting a doctor is refused while anyone still depends on them:
     * upcoming (non-cancelled) appointments → 409 WITH the list, so the
       dashboard can warn and show them instead of silently deleting;
     * any older booking history → 409 too — past bookings resolve the
       doctor's name through this row and the FK would reject the delete.
   Doctors with no bookings at all delete cleanly (leaves cascade). */
async function deleteDoctor(env, client, id) {
  const rows = await sbSelect(
    env,
    "doctors",
    query([
      ["id", `eq.${id}`],
      ["client_id", `eq.${client.id}`],
      ["select", "id,name"],
      ["limit", "1"],
    ])
  );
  const doctor = Array.isArray(rows) ? rows[0] : null;
  if (!doctor) return jsonResponse({ error: "not_found", id }, 404);

  const today = pktDateString(new Date());
  const nowHm = pktHmFromInstant(new Date());
  const [upBookings, upApptRows] = await Promise.all([
    sbSelect(
      env,
      "bookings",
      query([
        ["select", "id,customer_name,phone,slot_time,status"],
        ["doctor_id", `eq.${id}`],
        ["slot_time", `gte.${new Date().toISOString()}`],
        ["status", "neq.cancelled"],
        ["order", "slot_time.asc"],
      ])
    ),
    sbSelect(
      env,
      "appointments",
      query([
        ["select", "appointment_date,time_slot,status,patients(name,phone)"],
        ["client_id", `eq.${client.id}`],
        ["doctor_id", `eq.${id}`],
        ["status", "neq.cancelled"],
        ["appointment_date", `gte.${today}`],
        ["order", "appointment_date.asc,time_slot.asc"],
      ])
    ),
  ]);
  const upcoming = (Array.isArray(upBookings) ? upBookings : [])
    .concat(
      (Array.isArray(upApptRows) ? upApptRows : [])
        .filter((a) => {
          const hm = String(a.time_slot || "").padStart(5, "0");
          return a.appointment_date > today || (a.appointment_date === today && hm >= nowHm);
        })
        .map((a) => ({
          customer_name: a.patients?.name ?? "Patient",
          phone: a.patients?.phone ?? null,
          slot_time: pktIso(a.appointment_date, String(a.time_slot).padStart(5, "0")),
          // the dashboard warning modal labels this as "Confirmed"
          status: a.status === "booked" ? "confirmed" : a.status,
        }))
    )
    .sort((a, b) => String(a.slot_time).localeCompare(String(b.slot_time)));
  if (upcoming.length > 0) {
    return jsonResponse(
      {
        error: "has_upcoming_bookings",
        doctor: doctor.name,
        count: upcoming.length,
        bookings: upcoming,
        detail:
          "Reschedule or cancel these appointments first — or deactivate the doctor instead.",
      },
      409
    );
  }

  const [bookingHistory, apptHistory] = await Promise.all([
    sbCount(env, "bookings", query([["doctor_id", `eq.${id}`]])),
    sbCount(
      env,
      "appointments",
      query([["client_id", `eq.${client.id}`], ["doctor_id", `eq.${id}`]])
    ),
  ]);
  const history = bookingHistory + apptHistory;
  if (history > 0) {
    return jsonResponse(
      {
        error: "has_booking_history",
        doctor: doctor.name,
        count: history,
        detail: "Past bookings reference this doctor — mark them inactive instead.",
      },
      409
    );
  }

  await sbDelete(env, "doctors", query([
    ["id", `eq.${id}`],
    ["client_id", `eq.${client.id}`],
  ]));
  return jsonResponse({ success: true, deleted_id: id }, 200);
}

// ── GET|POST /api/dashboard/leaves, DELETE /{id} ─────────────────────
// Leaves are scoped through the client's own doctors (doctor_id ownership).
async function listLeaves(env, client, url) {
  const doctors = await fetchDoctors(env, client.id);
  if (doctors.length === 0) return jsonResponse({ leaves: [], count: 0 }, 200);

  const nameById = new Map(doctors.map((d) => [d.id, d.name]));
  const doctorId = url.searchParams.get("doctor_id");
  if (doctorId && !nameById.has(doctorId)) {
    return jsonResponse({ leaves: [], count: 0 }, 200);
  }

  const params = query([
    ["doctor_id", `in.(${doctors.map((d) => d.id).join(",")})`],
  ]);
  params.set("select", "id,doctor_id,leave_date,start_date,end_date,reason,created_at");
  params.set("order", "start_date.asc");
  if (doctorId) params.set("doctor_id", `eq.${doctorId}`);

  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  // Range overlap: leave covers [from,to] when end_date >= from and start_date <= to.
  if (from && isValidDateStr(from)) params.append("end_date", `gte.${from}`);
  if (to && isValidDateStr(to)) params.append("start_date", `lte.${to}`);

  const rows = await sbSelect(env, "doctor_leaves", params);
  const leaves = (Array.isArray(rows) ? rows : []).map((r) => ({
    ...r,
    doctor_name: nameById.get(r.doctor_id) ?? null,
  }));

  return jsonResponse({ leaves, count: leaves.length }, 200);
}

async function createLeave(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const doctorId = String(body.doctor_id ?? "").trim();
  // Single-day callers send leave_date; the range API sends start/end.
  const startDate = String(body.start_date ?? body.leave_date ?? "").trim();
  const endDate = String(body.end_date ?? body.leave_date ?? "").trim();
  if (!doctorId) return badRequest({ error: "missing_field", field: "doctor_id" });
  if (!isValidDateStr(startDate)) {
    return badRequest({ error: "invalid_leave_date", start_date: startDate });
  }
  if (!isValidDateStr(endDate)) {
    return badRequest({ error: "invalid_leave_date", end_date: endDate });
  }
  if (endDate < startDate) {
    return badRequest({
      error: "invalid_leave_range",
      message: "End date must be on or after the start date.",
    });
  }

  const doctors = await fetchDoctors(env, client.id);
  const doctor = doctors.find((d) => d.id === doctorId);
  if (!doctor) return jsonResponse({ error: "doctor_not_found", doctor_id: doctorId }, 404);

  // Exact-duplicate ranges are a no-op (the old unique index only covered
  // single days and was dropped when ranges arrived).
  const dupes = await sbSelect(env, "doctor_leaves", query([
    ["doctor_id", `eq.${doctorId}`],
    ["start_date", `eq.${startDate}`],
    ["end_date", `eq.${endDate}`],
    ["limit", "1"],
  ]));
  if (Array.isArray(dupes) && dupes.length) {
    return jsonResponse(
      { success: true, duplicate: true, leave: { ...dupes[0], doctor_name: doctor.name } },
      200
    );
  }

  const inserted = await sbInsert(env, "doctor_leaves", {
    doctor_id: doctorId,
    // Legacy column kept in sync with start_date for older readers.
    leave_date: startDate,
    start_date: startDate,
    end_date: endDate,
    reason: body.reason ? String(body.reason).trim() : null,
  });

  const fresh = Array.isArray(inserted) ? inserted[0] : inserted;
  return jsonResponse(
    {
      success: true,
      duplicate: false,
      leave: fresh ? { ...fresh, doctor_name: doctor.name } : null,
    },
    201
  );
}

async function deleteLeave(env, client, id) {
  const rows = await sbSelect(
    env,
    "doctor_leaves",
    query([
      ["id", `eq.${id}`],
      ["limit", "1"],
    ])
  );
  const leave = Array.isArray(rows) ? rows[0] : null;
  if (!leave) return jsonResponse({ error: "not_found", id }, 404);

  const doctors = await fetchDoctors(env, client.id);
  if (!doctors.some((d) => d.id === leave.doctor_id)) {
    return jsonResponse({ error: "not_found", id }, 404);
  }

  await sbDelete(env, "doctor_leaves", query([["id", `eq.${id}`]]));
  return jsonResponse({ success: true, deleted_id: id }, 200);
}

// ── GET /api/dashboard/availability?date=YYYY-MM-DD ──────────────────
/* Same engine as the public /api/check-slots, but returns the booked slots
   too (with customer names) so the owner sees the whole day at a glance. */
async function availability(env, client, url) {
  const dateStr = url.searchParams.get("date") || pktDateString(new Date());
  if (!isValidDateStr(dateStr)) return badRequest({ error: "invalid_date", date: dateStr });

  const doctors = await fetchDoctors(env, client.id, { activeOnly: true });
  const schedule = await buildDaySchedule(env, doctors, dateStr);

  return jsonResponse(
    {
      date: dateStr,
      timezone: PKT_TZ_NAME,
      doctors: schedule.map((entry) => ({
        doctor_id: entry.doctor.id,
        doctor_name: entry.doctor.name,
        specialization: entry.doctor.specialization ?? null,
        qualification: entry.doctor.qualification ?? null,
        timings: entry.doctor.timings ?? null,
        slot_duration_minutes: entry.doctor.slot_duration_minutes ?? null,
        fee: entry.doctor.fee ?? null,
        working_days: entry.doctor.working_days ?? null,
        off_day: Boolean(entry.off_day),
        on_leave: entry.on_leave,
        leave_id: entry.leave_id,
        leave_reason: entry.leave_reason,
        clinic_closed: Boolean(entry.clinic_closed),
        closed_kind: entry.closed_kind ?? null,
        closed_message: entry.closed_message ?? null,
        slots: entry.slots,
      })),
    },
    200
  );
}

// ── POST /api/change-password ────────────────────────────────────────
async function changePassword(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const oldPassword = String(body.old_password ?? "");
  const newPassword = String(body.new_password ?? "");

  if (!oldPassword || !newPassword) {
    return badRequest({ error: "missing_fields", fields: ["old_password", "new_password"] });
  }
  if (String(client.dashboard_password ?? "") !== oldPassword) {
    return badRequest({ error: "wrong_old_password" });
  }
  if (newPassword === oldPassword) {
    return badRequest({ error: "same_password" });
  }

  const rows = await sbPatch(
    env,
    "clients",
    query([["id", `eq.${client.id}`]]),
    { dashboard_password: newPassword }
  );

  const row = Array.isArray(rows) ? rows[0] : rows;
  if (!row || !row.id) return jsonResponse({ error: "update_failed" }, 500);

  return jsonResponse({ success: true, client: publicClient(row) }, 200);
}

// ── GET|PUT /api/dashboard/agent-config ─────────────────────────────────
/* One object per client: the agent's knowledge base / personality
   (agent_name, tone, greeting, business_info, booking_rules,
   custom_instructions …, plus any legacy fields the clinic saved).
   GET fills missing keys from the defaults; PUT validates the shape
   (plain object + non-empty string agent_name) and replaces the stored
   value for this client only. */
async function getAgentConfig(env, client) {
  const rows = await sbSelect(
    env,
    "client_configs",
    query([
      ["client_id", `eq.${client.id}`],
      ["limit", "1"],
    ])
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  return jsonResponse({ agent_config: withDefaults(row?.knowledge_base_json) }, 200);
}

async function putAgentConfig(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const agentName =
    typeof body.agent_name === "string" ? body.agent_name.trim() : "";
  if (!agentName) {
    return badRequest({
      error: "invalid_agent_name",
      detail: "config must be an object with a non-empty string agent_name",
    });
  }

  // Exactly one config row per client (client_id): update it when present,
  // create it when the clinic has never saved a config.
  const existing = await sbSelect(
    env,
    "client_configs",
    query([
      ["client_id", `eq.${client.id}`],
      ["select", "id"],
      ["limit", "1"],
    ])
  );
  const row = Array.isArray(existing) ? existing[0] : null;

  if (row && row.id) {
    await sbPatch(env, "client_configs", query([["id", `eq.${row.id}`]]), {
      knowledge_base_json: body,
    });
  } else {
    await sbInsert(env, "client_configs", {
      client_id: client.id,
      knowledge_base_json: body,
    });
  }

  return jsonResponse({ success: true, agent_config: body }, 200);
}

// ── GET|PUT /api/dashboard/settings (clinic profile + timings) ───
/* One row per client in clinic_settings (keyed by client_id) — the API
   the voice agent and every form read clinic-wide facts from. PUT
   profile and PUT timings validate independently so one can be saved
   before the other exists. */
const DEFAULT_SETTINGS = {
  clinic_name: "",
  tagline: null,
  phone: "",
  whatsapp: null,
  address: "",
  maps_link: null,
  email: null,
  open_days: null,
  open_time: null,
  close_time: null,
  updated_at: null,
};

async function getSettings(env, client) {
  const row = await fetchClinicSettings(env, client.id);
  return jsonResponse({ settings: { ...DEFAULT_SETTINGS, ...(row || {}) } }, 200);
}

async function upsertSettings(env, client, patch) {
  const rows = await sbPatch(
    env,
    "clinic_settings",
    query([["client_id", `eq.${client.id}`]]),
    patch
  );
  let row = Array.isArray(rows) ? rows[0] : rows;
  if (!row) {
    const inserted = await sbInsert(env, "clinic_settings", {
      client_id: client.id,
      ...patch,
    });
    row = Array.isArray(inserted) ? inserted[0] : inserted;
  }
  return { ...DEFAULT_SETTINGS, ...(row || {}) };
}

async function putSettingsProfile(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const clinicName = String(body.clinic_name ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const address = String(body.address ?? "").trim();
  if (!clinicName) {
    return badRequest({ error: "missing_field", field: "clinic_name", message: "Clinic name is required." });
  }
  if (!phone) {
    return badRequest({ error: "missing_field", field: "phone", message: "Phone number is required." });
  }
  if (!address) {
    return badRequest({ error: "missing_field", field: "address", message: "Address is required." });
  }

  const settings = await upsertSettings(env, client, {
    clinic_name: clinicName,
    tagline: body.tagline ? String(body.tagline).trim() : null,
    phone,
    whatsapp: body.whatsapp ? String(body.whatsapp).trim() : null,
    address,
    maps_link: body.maps_link ? String(body.maps_link).trim() : null,
    email: body.email ? String(body.email).trim() : null,
    updated_at: new Date().toISOString(),
  });
  return jsonResponse({ success: true, settings }, 200);
}

async function putSettingsTimings(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  if (!Array.isArray(body.open_days) || body.open_days.length === 0) {
    return badRequest({
      error: "invalid_open_days",
      message: "Pick at least one clinic opening day.",
    });
  }
  const wanted = new Set();
  for (const d of body.open_days) {
    const key = String(d ?? "").trim().toLowerCase();
    if (!WORKING_DAY_KEYS.includes(key)) {
      return badRequest({ error: "invalid_open_days", open_days: body.open_days });
    }
    wanted.add(key);
  }
  const openDays = WORKING_DAY_KEYS.filter((k) => wanted.has(k));

  const openTime = String(body.open_time ?? "").trim();
  const closeTime = String(body.close_time ?? "").trim();
  const open = parseHmToMinutes(openTime);
  const close = parseHmToMinutes(closeTime);
  if (open === null || close === null || close <= open) {
    return badRequest({
      error: "invalid_clinic_hours",
      open_time: openTime,
      close_time: closeTime,
      message: "Pick an opening and closing time with closing after opening.",
    });
  }

  const settings = await upsertSettings(env, client, {
    open_days: openDays,
    open_time: openTime,
    close_time: closeTime,
    updated_at: new Date().toISOString(),
  });
  return jsonResponse({ success: true, settings }, 200);
}

// ── GET|POST|DELETE /api/dashboard/holidays ─────────────────────
async function listHolidays(env, client, url) {
  const params = query([
    ["client_id", `eq.${client.id}`],
    ["order", "holiday_date.asc"],
  ]);
  params.set("select", "id,holiday_date,reason,created_at");
  const from = url.searchParams.get("from");
  if (from && isValidDateStr(from)) params.append("holiday_date", `gte.${from}`);
  const rows = await sbSelect(env, "clinic_holidays", params);
  const holidays = Array.isArray(rows) ? rows : [];
  return jsonResponse({ holidays, count: holidays.length }, 200);
}

async function createHoliday(request, env, client) {
  const body = await readJson(request);
  if (!body) return badRequest({ error: "invalid_json" });

  const dateStr = String(body.holiday_date ?? "").trim();
  const reason = String(body.reason ?? "").trim();
  if (!isValidDateStr(dateStr)) {
    return badRequest({ error: "invalid_date", holiday_date: dateStr, message: "Pick a valid date." });
  }
  if (!reason) {
    return badRequest({ error: "missing_field", field: "reason", message: "Give the holiday a name (e.g. Eid ul Fitr)." });
  }

  let row;
  try {
    const inserted = await sbInsert(env, "clinic_holidays", {
      client_id: client.id,
      holiday_date: dateStr,
      reason,
    });
    row = Array.isArray(inserted) ? inserted[0] : inserted;
  } catch (err) {
    // Unique (client_id, holiday_date) — that day is already a holiday.
    if (err && err.status === 409 && /23505|duplicate key/i.test(String(err.message || ""))) {
      const existing = await sbSelect(env, "clinic_holidays", query([
        ["client_id", `eq.${client.id}`],
        ["holiday_date", `eq.${dateStr}`],
        ["limit", "1"],
      ]));
      const dup = Array.isArray(existing) ? existing[0] : null;
      return jsonResponse(
        { success: true, duplicate: true, holiday: dup ?? null },
        200
      );
    }
    throw err;
  }
  return jsonResponse({ success: true, duplicate: false, holiday: row ?? null }, 201);
}

async function deleteHoliday(env, client, id) {
  const rows = await sbSelect(env, "clinic_holidays", query([
    ["id", `eq.${id}`],
    ["client_id", `eq.${client.id}`],
    ["limit", "1"],
  ]));
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) return jsonResponse({ error: "not_found", id }, 404);
  await sbDelete(env, "clinic_holidays", query([
    ["id", `eq.${id}`],
    ["client_id", `eq.${client.id}`],
  ]));
  return jsonResponse({ success: true, deleted_id: id }, 200);
}

/* Router for /api/*. Returns null only for paths this module does not own,
   which lets index.js fall through to its plain-text landing response. */
export async function handleApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/login" && method === "POST") return login(request, env);
  if (pathname === "/api/change-password" && method === "POST") {
    const client = await validateClient(request, env);
    if (!client) return unauthorized();
    return changePassword(request, env, client);
  }

  if (!pathname.startsWith("/api/dashboard")) return null;

  const client = await validateClient(request, env);
  if (!client) return unauthorized();

  // The dashboard calls it at /api/dashboard/change-password; the alias
  // /api/change-password keeps working for anything older.
  if (pathname === "/api/dashboard/change-password" && method === "POST") {
    return changePassword(request, env, client);
  }

  if (pathname === "/api/dashboard/agent-config" && method === "GET") {
    return getAgentConfig(env, client);
  }
  if (pathname === "/api/dashboard/agent-config" && method === "PUT") {
    return putAgentConfig(request, env, client);
  }

  if (pathname.startsWith("/api/dashboard/appointments")) {
    return handleAppointments(request, env, url, client);
  }

  if (pathname.startsWith("/api/dashboard/patients")) {
    return handlePatients(request, env, url, client);
  }

  if (pathname === "/api/dashboard/settings" && method === "GET") {
    return getSettings(env, client);
  }
  if (pathname === "/api/dashboard/settings/profile" && method === "PUT") {
    return putSettingsProfile(request, env, client);
  }
  if (pathname === "/api/dashboard/settings/timings" && method === "PUT") {
    return putSettingsTimings(request, env, client);
  }

  if (pathname === "/api/dashboard/holidays" && method === "GET") {
    return listHolidays(env, client, url);
  }
  if (pathname === "/api/dashboard/holidays" && method === "POST") {
    return createHoliday(request, env, client);
  }
  const holidayMatch = /^\/api\/dashboard\/holidays\/([^/]+)$/.exec(pathname);
  if (holidayMatch && method === "DELETE") {
    return deleteHoliday(env, client, decodeURIComponent(holidayMatch[1]));
  }

  if (pathname === "/api/dashboard/stats" && method === "GET") return stats(env, client);

  if (pathname === "/api/dashboard/bookings" && method === "GET") {
    return listBookings(env, client, url);
  }
  const bookingMatch = /^\/api\/dashboard\/bookings\/([^/]+)$/.exec(pathname);
  if (bookingMatch && method === "PATCH") {
    return updateBooking(request, env, client, decodeURIComponent(bookingMatch[1]));
  }

  if (pathname === "/api/dashboard/doctors" && method === "GET") {
    return listDoctors(env, client);
  }
  if (pathname === "/api/dashboard/doctors" && method === "POST") {
    return createDoctor(request, env, client);
  }
  const doctorMatch = /^\/api\/dashboard\/doctors\/([^/]+)$/.exec(pathname);
  if (doctorMatch && method === "PATCH") {
    return updateDoctor(request, env, client, decodeURIComponent(doctorMatch[1]));
  }
  if (doctorMatch && method === "DELETE") {
    return deleteDoctor(env, client, decodeURIComponent(doctorMatch[1]));
  }

  if (pathname === "/api/dashboard/leaves" && method === "GET") {
    return listLeaves(env, client, url);
  }
  if (pathname === "/api/dashboard/leaves" && method === "POST") {
    return createLeave(request, env, client);
  }
  const leaveMatch = /^\/api\/dashboard\/leaves\/([^/]+)$/.exec(pathname);
  if (leaveMatch && method === "DELETE") {
    return deleteLeave(env, client, decodeURIComponent(leaveMatch[1]));
  }

  if (pathname === "/api/dashboard/availability" && method === "GET") {
    return availability(env, client, url);
  }

  return jsonResponse({ error: "not_found", path: pathname, method }, 404);
}
