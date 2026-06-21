// expo/lib/branding.ts — approved branding profiles a clinician may apply on export.
import { supabase } from "@/lib/supabase";

export type BrandingOption = {
  id: string | null;            // null = NanoHab default (no profile)
  display_name: string;
  branding_tier: "cobrand" | "whitelabel" | null;
  is_org_default: boolean;
};

const NANOHAB_DEFAULT: BrandingOption = {
  id: null, display_name: "NanoHab Connect (default)", branding_tier: null, is_org_default: false,
};

/** Approved profiles the current member may use: org profiles for their org +
 *  any profiles they're linked to. Always includes the NanoHab default first. */
export async function fetchBrandingOptions(): Promise<BrandingOption[]> {
  const opts: BrandingOption[] = [NANOHAB_DEFAULT];
  // RLS already scopes practice_profiles to owned/org/linked rows; we filter approved.
  const { data: profs, error } = await supabase
    .from("practice_profiles")
    .select("id, display_name, branding_tier, status")
    .eq("status", "approved");
  if (error) { console.error("fetchBrandingOptions", error); return opts; }

  // which are org-default for me?
  const { data: links } = await supabase
    .from("member_practice_profiles")
    .select("profile_id, is_org_default");
  const defaults = new Map<string, boolean>(
    (links ?? []).map((l: any) => [l.profile_id, !!l.is_org_default]));

  for (const p of profs ?? []) {
    opts.push({
      id: p.id,
      display_name: p.display_name,
      branding_tier: p.branding_tier ?? null,
      is_org_default: defaults.get(p.id) ?? false,
    });
  }
  // org-default profile floats just under the NanoHab default
  opts.sort((a, b) => Number(b.is_org_default) - Number(a.is_org_default));
  // keep NanoHab default pinned first
  return [NANOHAB_DEFAULT, ...opts.filter((o) => o.id !== null)];
}
