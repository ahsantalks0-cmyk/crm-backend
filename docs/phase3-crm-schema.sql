ALTER TABLE clients ADD COLUMN IF NOT EXISTS dashboard_password TEXT;

CREATE TABLE IF NOT EXISTS doctors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  specialization TEXT,
  timings JSONB NOT NULL,
  slot_duration_minutes INTEGER DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS doctor_id UUID REFERENCES doctors(id);

CREATE INDEX IF NOT EXISTS idx_bookings_doctor_slot ON bookings(doctor_id, slot_time);
