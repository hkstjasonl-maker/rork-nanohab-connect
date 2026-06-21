// expo/lib/typedNotes.ts
// Theme-2 client helpers: read the document_templates registry straight from
// Supabase (it is non-PHI config, readable by any authenticated member), read the
// signed-in member's discipline (for the picker default), and call the backend
// drafting endpoint.
//
// Adjust the two imports below to match this app's actual paths:
//   - the supabase client (used elsewhere as `supabase`)
//   - getCurrentMemberId() from "@/lib/member"
import { supabase } from "@/lib/supabase";
import { getCurrentMemberId } from "@/lib/member";

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL as string;

export type Discipline = "medical" | "nursing" | "allied_health" | "universal";
export type RiskTier = "narrative" | "extract_flag";

export type DocumentTemplate = {
  template_key: string;
  display_name: string;
  discipline: Discipline;
  risk_tier: RiskTier;
  code: string | null;
  output_sections: string[];
  structured_fields: string[];
  framework: string | null;
  sort_order: number;
};

export type TypedNoteResult = {
  artifact_id: string;
  state: string;
  template_key: string;
  draft: string;
  engine: string;
};

/** All active templates, ordered for grouped display. */
export async function listTemplates(): Promise<DocumentTemplate[]> {
  const { data, error } = await supabase
    .from("document_templates")
    .select(
      "template_key, code, display_name, discipline, risk_tier, output_sections, structured_fields, framework, sort_order"
    )
    .eq("is_active", true)
    .order("discipline", { ascending: true })
    .order("sort_order", { ascending: true });
  if (error) throw error;
  return (data ?? []) as DocumentTemplate[];
}

/** The signed-in member's discipline, for defaulting the picker. Null if unset. */
export async function getMyDiscipline(): Promise<Discipline | null> {
  const memberId = await getCurrentMemberId();
  if (!memberId) return null;
  const { data, error } = await supabase
    .from("members")
    .select("discipline")
    .eq("id", memberId)
    .limit(1)
    .single();
  if (error) return null;
  const d = (data?.discipline ?? null) as Discipline | null;
  return d;
}

/** Optional localized labels for a template (e.g. the generic quick-consults). */
export async function getTemplateI18n(templateKey: string, language: string) {
  const { data, error } = await supabase
    .from("document_template_i18n")
    .select("display_name, output_sections")
    .eq("template_key", templateKey)
    .eq("language", language)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return data as { display_name: string; output_sections: string[] } | null;
}

/** Create a typed clinical note-draft from text + a chosen template. */
export async function createTypedNote(params: {
  roomId: string;
  templateKey: string;
  text: string;
  language?: string;
  focus?: string;
}): Promise<TypedNoteResult> {
  const { data: sess } = await supabase.auth.getSession();
  const token = sess.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${BASE}/thread/typed-note`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      room_id: params.roomId,
      template_key: params.templateKey,
      text: params.text,
      language: params.language ?? "",
      focus: params.focus ?? "",
    }),
  });
  if (!res.ok) {
    throw new Error(`typed-note failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TypedNoteResult;
}

/**
 * Lightweight, transparent auto-detect: suggest a template from the dictated text
 * by keyword. NEVER auto-applies — the picker shows it as a suggestion to confirm.
 * Deliberately simple; the clinician's choice always wins.
 */
export function suggestTemplateKey(
  text: string,
  templates: DocumentTemplate[]
): string | null {
  const t = (text || "").toLowerCase();
  const rules: Array<[RegExp, string]> = [
    [/\bswallow|dysphagia|iddsi|aspiration\b/, "dysphagia_assessment"],
    [/\bward round|overnight|on call\b/, "ward_round"],
    [/\bdischarge\b/, "discharge_summary"],
    [/\binr|warfarin|anticoag\b/, "anticoagulation_monitoring"],
    [/\bweight\b/, "weight_monitoring"],
    [/\bblood|lab|potassium|sodium|creatinine|haemoglobin|hemoglobin\b/, "blood_labs"],
    [/\bfall|balance|berg|timed up\b/, "falls_balance_assessment"],
    [/\bwound|pressure|dressing|ulcer\b/, "wound_assessment"],
    [/\bvoice|hoarse|dysphonia|grbas\b/, "voice_assessment"],
    [/\bstutter|fluency|disfluen\b/, "fluency_assessment"],
  ];
  const present = new Set(templates.map((x) => x.template_key));
  for (const [re, key] of rules) {
    if (re.test(t) && present.has(key)) return key;
  }
  return null;
}

export const DISCIPLINE_LABEL: Record<Discipline, string> = {
  medical: "Medical",
  nursing: "Nursing",
  allied_health: "Allied health",
  universal: "Shared",
};
