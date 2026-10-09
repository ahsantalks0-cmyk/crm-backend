/* Shared slot engine.
   /api/check-slots (public, customer-facing) and
   /api/dashboard/availability (owner-facing) both build their day from
   buildDaySchedule(), so the two can never drift apart.

   A doctor is "on duty" only when status = 'active'. Rows written before
   Phase 4 may carry NULL, which is treated as active as well. */

import { sbSelect } from "./supabase.js";
import {
  pktDayBounds,
  pktDateString,
  pktHmFromInstant,
  pktMinutesOfDay,
  parseHmToMinutes,
  minutesToHm,
} from "./pkt.js";

// Never select `dashboard_password`/tokens here — doctors are public-ish data.
const DOCTOR_FIELDS =
  "id,client_id,name,specialization,qualification,timings,slot_duration_minutes,fee,status,phone,working_days,created_at";

const ACTIVE_OR_UNSET = "(status.eq.active,status.is.null)";

// Canonical order used everywhere working days are stored/displayed.
export const WORKING_DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
// JS Date.getUTCDay() order (0 = Sunday) → our day keys.
const DOW_KEY = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/* Is `doctor` working on the PKT calendar date `dateStr`?
   working_days is a JSONB array of day keys (e.g. ["mon","tue",…]);
   NULL or [] means every day — that is what rows written before this
   column existed mean, so legacy doctors keep their old behaviour. */
export function worksOnDate(doctor, dateStr) {
  const days = Array.isArray(doctor?.working_days) ? doctor.working_days : null;
  if (!days || days.length === 0) return true;
  const dow = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  const key = DOW_KEY[dow];
  return days.some((d) => String(d ?? "").trim().toLowerCase() === key);
}

// "17:00"→"21:00" @30min → ["17:00","17:30",...,"20:30"]
export function generateSlots(timings, durationMinutes) {
  const start = parseHmToMinutes(timings?.start);
  const end = parseHmToMinutes(timings?.end);
  const step = Number(durationMinutes) > 0 ? Number(durationMinutes) : 30;
  if (start === null || end === null || end <= start) return [];
  const slots = [];
  for (let t = start; t + step <= end; t += step) slots.push(minutesToHm(t));
  return slots;
}

export async function fetchDoctors(env, clientId, { activeOnly = false } = {}) {
  const params = new URLSearchParams();
  params.set("select", DOCTOR_FIELDS);
  params.set("client_id", `eq.${clientId}`);
  if (activeOnly) params.set("or", ACTIVE_OR_UNSET);
  params.set("order", "name.asc");
  const rows = await sbSelect(env, "doctors", params);
  return Array.isArray(rows) ? rows : [];
}

export async function findDoctorByName(env, clientId, doctorName, { activeOnly = false } = {}) {
  const doctors = await fetchDoctors(env, clientId, { activeOnly });
  const wanted = String(doctorName ?? "").trim().toLowerCase();
  return (
    doctors.find((d) => String(d.name || "").trim().toLowerCase() === wanted) || null
  );
}

// Every non-cancelled booking for the given doctors inside one PKT day.
export async function fetchBookingsForDay(env, doctorIds, dateStr) {
  if (!doctorIds.length) return [];
  const { start, end } = pktDayBounds(dateStr);
  const params = new URLSearchParams();
  params.set(
    "select",
    "id,doctor_id,customer_name,phone,slot_time,status,details_json"
  );
  params.set("doctor_id", `in.(${doctorIds.join(",")})`);
  params.set("status", "neq.cancelled");
  params.append("slot_time", `gte.${start}`);
  params.append("slot_time", `lt.${end}`);
  params.set("order", "slot_time.asc");
  const rows = await sbSelect(env, "bookings", params);
  return Array.isArray(rows) ? rows : [];
}

export async function fetchLeavesOnDate(env, doctorIds, dateStr) {
  if (!doctorIds.length) return [];
  const params = new URLSearchParams();
  params.set("select", "id,doctor_id,leave_date,start_date,end_date,reason");
  params.set("doctor_id", `in.(${doctorIds.join(",")})`);
  // Range leaves: a date is covered when start_date <= date <= end_date.
  params.append("start_date", `lte.${dateStr}`);
  params.append("end_date", `gte.${dateStr}`);
  const rows = await sbSelect(env, "doctor_leaves", params);
  return Array.isArray(rows) ? rows : [];
}

export async function isDoctorOnLeave(env, doctorId, dateStr) {
  const params = new URLSearchParams();
  params.set("select", "id");
  params.set("doctor_id", `eq.${doctorId}`);
  params.append("start_date", `lte.${dateStr}`);
  params.append("end_date", `gte.${dateStr}`);
  params.set("limit", "1");
  const rows = await sbSelect(env, "doctor_leaves", params);
  return Array.isArray(rows) && rows.length > 0;
}

// ── clinic-wide closure ──────────────────────────────────────────
const CLINIC_SETTINGS_FIELDS =
  "client_id,clinic_name,tagline,phone,whatsapp,address,maps_link,email,open_days,open_time,close_time,updated_at";

export async function fetchClinicSettings(env, clientId) {
  const params = new URLSearchParams();
  params.set("select", CLINIC_SETTINGS_FIELDS);
  params.set("client_id", `eq.${clientId}`);
  params.set("limit", "1");
  const rows = await sbSelect(env, "clinic_settings", params);
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

/* Clinic-wide closure for one PKT date — checked in spec order:
   (a) holiday → (b) closed day of week per clinic settings.
   Returns null when the clinic is open, else { kind, message } where
   message is the user-facing line every slot grid should show. */
export async function clinicClosure(env, clientId, dateStr) {
  const holidayParams = new URLSearchParams();
  holidayParams.set("select", "reason");
  holidayParams.set("client_id", `eq.${clientId}`);
  holidayParams.set("holiday_date", `eq.${dateStr}`);
  holidayParams.set("limit", "1");

  const [holidays, settings] = await Promise.all([
    sbSelect(env, "clinic_holidays", holidayParams),
    fetchClinicSettings(env, clientId),
  ]);
  if (Array.isArray(holidays) && holidays.length) {
    const reason = String(holidays[0].reason ?? "").trim();
    return { kind: "holiday", message: `Clinic closed: ${reason || "Holiday"}` };
  }
  const days = Array.isArray(settings?.open_days) ? settings.open_days : null;
  if (days && days.length) {
    const key = DOW_KEY[new Date(`${dateStr}T00:00:00Z`).getUTCDay()];
    const open = days.some((d) => String(d ?? "").trim().toLowerCase() === key);
    if (!open) {
      return { kind: "closed_day", message: "Clinic closed \u2014 this day is outside clinic timings." };
    }
  }
  return null;
}

export async function findConflictingBooking(env, doctorId, slotIso) {
  const params = new URLSearchParams();
  params.set("select", "id,status");
  params.set("doctor_id", `eq.${doctorId}`);
  params.set("slot_time", `eq.${slotIso}`);
  params.set("status", "neq.cancelled");
  params.set("limit", "1");
  const rows = await sbSelect(env, "bookings", params);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

/* The single source of truth for "what does this doctor's day look like".
   Returns one entry per doctor:
     { doctor, on_leave, leave_id, leave_reason,
       slots: [{ time, status: "free"|"booked"|"past",
                 customer_name?, phone?, booking_id? }] }
   "past" only ever appears for today, measured against PKT wall-clock. */
export async function buildDaySchedule(env, doctors, dateStr, { now = new Date() } = {}) {
  const ids = doctors.map((d) => d.id).filter(Boolean);
  const clientId = doctors.find((d) => d.client_id)?.client_id ?? null;
  const [bookings, leaves, closure] = await Promise.all([
    fetchBookingsForDay(env, ids, dateStr),
    fetchLeavesOnDate(env, ids, dateStr),
    clientId ? clinicClosure(env, clientId, dateStr) : Promise.resolve(null),
  ]);

  const leaveByDoctor = new Map(leaves.map((l) => [l.doctor_id, l]));

  const bookingsByDoctor = new Map();
  for (const b of bookings) {
    const hm = pktHmFromInstant(b.slot_time);
    if (!hm) continue;
    if (!bookingsByDoctor.has(b.doctor_id)) {
      bookingsByDoctor.set(b.doctor_id, new Map());
    }
    bookingsByDoctor.get(b.doctor_id).set(hm, b);
  }

  const isToday = dateStr === pktDateString(now);
  const nowMinutes = isToday ? pktMinutesOfDay(now) : -1;

  return doctors.map((doctor) => {
    // (a)/(b) Clinic-wide closure beats everything — no slots for anyone.
    if (closure) {
      return {
        doctor,
        on_leave: false,
        leave_id: null,
        leave_reason: null,
        off_day: true,
        clinic_closed: true,
        closed_kind: closure.kind,
        closed_message: closure.message,
        slots: [],
      };
    }
    // (c) Doctor on leave → no slots for this doctor.
    const leave = leaveByDoctor.get(doctor.id) || null;
    if (leave) {
      return {
        doctor,
        on_leave: true,
        leave_id: leave.id,
        leave_reason: leave.reason ?? null,
        off_day: false,
        clinic_closed: false,
        closed_message: null,
        slots: [],
      };
    }
    // (d) Outside the doctor's working days → no slots, distinct from leave.
    if (!worksOnDate(doctor, dateStr)) {
      return {
        doctor,
        on_leave: false,
        leave_id: null,
        leave_reason: null,
        off_day: true,
        clinic_closed: false,
        closed_message: null,
        slots: [],
      };
    }
    const booked = bookingsByDoctor.get(doctor.id) || new Map();

    const slots = generateSlots(doctor.timings, doctor.slot_duration_minutes).map(
      (time) => {
        const booking = booked.get(time) || null;
        if (booking) {
          return {
            time,
            status: "booked",
            customer_name: booking.customer_name ?? null,
            phone: booking.phone ?? null,
            booking_id: booking.id ?? null,
            // booking_status is the appointment state (confirmed/completed);
            // `status` above is the slot state (free/booked/past).
            booking_status: booking.status ?? null,
          };
        }
        const mins = parseHmToMinutes(time);
        if (isToday && mins !== null && mins <= nowMinutes) {
          return { time, status: "past" };
        }
        return { time, status: "free" };
      }
    );

    return {
      doctor,
      on_leave: false,
      leave_id: null,
      leave_reason: null,
      off_day: false,
      clinic_closed: false,
      closed_message: null,
      slots,
    };
  });
}

export { ACTIVE_OR_UNSET, DOCTOR_FIELDS };
