/* Agent knowledge base / personality — Phase 5 Part 1.
   Stored per client in client_configs.knowledge_base_json (free-form JSON).
   These defaults guarantee the widget always receives the full prompt shape,
   even for a client whose config row is missing or only partially filled. */

export const DEFAULT_KNOWLEDGE_BASE = {
  agent_name: "Aashi",
  tone: "warm, friendly and caring",
  greeting:
    "Assalam o Alaikum! Main Aashi hoon, Shine Dental Test ki taraf se. Kya madad kar sakti hoon?",
  business_info:
    "Shine Dental Test clinic, Lahore. Dr. Ayesha, fee 2000 PKR, timings 5-9 PM, 30-minute appointments.",
  booking_rules: "Always confirm name, phone, doctor, day and time before booking.",
  custom_instructions: "",
};

/* Defaults only fill keys the stored config is missing — stored values
   (including empty strings and legacy fields like timings / fees /
   slot_duration_minutes) always win, so nothing an owner saved is dropped. */
export function withDefaults(stored) {
  const base =
    stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  return { ...DEFAULT_KNOWLEDGE_BASE, ...base };
}
