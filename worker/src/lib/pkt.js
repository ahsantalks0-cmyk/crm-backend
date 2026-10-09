/* Asia/Karachi (UTC+5, no DST) time helpers.
   Every slot calculation in this worker goes through these functions —
   never UTC, never server-local. */

export const PKT_OFFSET_MINUTES = 300;
export const PKT_TZ_NAME = "Asia/Karachi";

const pad2 = (n) => String(n).padStart(2, "0");

// Returns a Date whose *UTC* getters reveal the PKT wall-clock of `input`.
export function pktWallClock(input) {
  const ms = input instanceof Date ? input.getTime() : Date.parse(input);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + PKT_OFFSET_MINUTES * 60 * 1000);
}

export function pktDateString(input = new Date()) {
  const p = pktWallClock(input);
  if (!p) return null;
  return `${p.getUTCFullYear()}-${pad2(p.getUTCMonth() + 1)}-${pad2(p.getUTCDate())}`;
}

export function pktMinutesOfDay(input = new Date()) {
  const p = pktWallClock(input);
  if (!p) return null;
  return p.getUTCHours() * 60 + p.getUTCMinutes();
}

// Any instant → "HH:MM" in Pakistan time.
export function pktHmFromInstant(input) {
  const p = pktWallClock(input);
  if (!p) return null;
  return `${pad2(p.getUTCHours())}:${pad2(p.getUTCMinutes())}`;
}

// "YYYY-MM-DD" → next calendar day (same format).
export function nextDateStr(dateStr) {
  return addDaysStr(dateStr, 1);
}

// "YYYY-MM-DD" shifted by `n` days (n may be negative).
export function addDaysStr(dateStr, n) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + n * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

// PKT calendar day expressed as explicit +05:00 instants for DB queries.
export function pktDayBounds(dateStr) {
  return {
    start: `${dateStr}T00:00:00+05:00`,
    end: `${nextDateStr(dateStr)}T00:00:00+05:00`,
  };
}

// First day of the PKT month containing `dateStr`.
export function pktMonthBounds(dateStr) {
  const first = `${dateStr.slice(0, 7)}-01`;
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7));
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  const nextFirst = `${nextY}-${pad2(nextM)}-01`;
  return {
    start: `${first}T00:00:00+05:00`,
    end: `${nextFirst}T00:00:00+05:00`,
  };
}

export function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const ms = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === s; // rejects 2026-02-31
}

export function parseHmToMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

export function minutesToHm(total) {
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

// Local PKT slot string → absolute ISO instant with explicit offset.
export function pktIso(dateStr, hm) {
  return `${dateStr}T${hm}:00+05:00`;
}
