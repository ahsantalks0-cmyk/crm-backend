# Voice Agent SaaS — Database Schema

## Overview

Multi-client voice agent SaaS backend database schema.
Postgres (Supabase). RLS disabled for MVP testing phase.

---

## Table: `clients`

Stores each business/client onboarded on the platform.

| Column                | Type       | Constraints                          |
|-----------------------|------------|--------------------------------------|
| id                    | text       | PRIMARY KEY                          |
| business_name         | text       | NOT NULL                             |
| industry              | text       | NOT NULL                             |
| google_calendar_id    | text       | nullable                             |
| calendar_refresh_token| text       | nullable                             |
| status                | text       | DEFAULT 'active'                     |
| created_at            | timestamptz| DEFAULT now()                        |

### Relationships

- `client_configs.client_id` → `clients.id` (ON DELETE CASCADE)
- `bookings.client_id` → `clients.id` (ON DELETE CASCADE)

### Test Data

| id               | business_name    | industry | google_calendar_id | status |
|------------------|------------------|----------|-------------------|--------|
| clinic-test-01   | Shine Dental Test| dentist  | eb07042b4c0946f3bb14a62bc05c4792c57b2862f9eeb297078c39f145c0cefb@group.calendar.google.com | active |

---

## Table: `client_configs`

Per-client configuration: knowledge base, custom fields, notification settings.

| Column               | Type     | Constraints                             |
|----------------------|----------|-----------------------------------------|
| id                   | uuid     | PRIMARY KEY, DEFAULT gen_random_uuid()  |
| client_id            | text     | NOT NULL, FK → clients(id) ON DELETE CASCADE |
| knowledge_base_json  | jsonb    | nullable                                |
| custom_fields_json   | jsonb    | nullable                                |
| email_notifications  | text     | nullable                                |
| created_at           | timestamptz | DEFAULT now()                         |

### JSON Shapes (test data)

**knowledge_base_json:**
```json
{
  "doctors": ["Dr. Ayesha"],
  "timings": "5 PM - 9 PM",
  "fees": "2000 PKR",
  "slot_duration_minutes": 30,
  "services": ["checkup", "cleaning", "filling", "root canal"]
}
```

**custom_fields_json:**
```json
{
  "required": ["name", "phone"],
  "optional": ["service", "notes"]
}
```

### Test Data

| id (uuid) | client_id     | email_notifications        |
|-----------|---------------|---------------------------|
| (generated) | clinic-test-01 | Ahsanmarketer6@gmail.com |

---

## Table: `bookings`

Customer booking slots for each client.

| Column          | Type       | Constraints                          |
|-----------------|------------|--------------------------------------|
| id              | uuid       | PRIMARY KEY, DEFAULT gen_random_uuid() |
| client_id       | text       | NOT NULL, FK → clients(id) ON DELETE CASCADE |
| customer_name   | text       | NOT NULL                             |
| phone           | text       | nullable                             |
| details_json    | jsonb      | nullable                             |
| slot_time       | timestamptz| NOT NULL                             |
| status          | text       | DEFAULT 'confirmed'                  |
| created_at      | timestamptz| DEFAULT now()                        |

### Index

- `idx_bookings_client_slot` on `bookings(client_id, slot_time)` — efficient lookup by client + time range

### Test Data

Empty (0 rows) at MVP setup.

---

## ER Diagram (text)

```
clients 1 ──── N client_configs
  │
  └──── N bookings
```

---

## Notes

- RLS is **disabled** on all tables (MVP testing phase)
- `clients.id` is text (business-specific identifier), not auto-generated
- `client_configs.id` and `bookings.id` are uuid, auto-generated via `gen_random_uuid()`
