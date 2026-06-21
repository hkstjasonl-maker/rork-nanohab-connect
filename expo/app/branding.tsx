import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Plus, X, Image as ImageIcon } from "lucide-react-native";
import { Theme } from "@/constants/colors";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "@/lib/supabase";
import { getCurrentMemberId } from "@/lib/member";

type Profile = {
  id: string;
  display_name: string;
  legal_name: string | null;
  branding_tier: "cobrand" | "whitelabel";
  status: "pending" | "approved" | "rejected" | "suspended";
  owner_org_id: string | null;
  owner_member_id: string | null;
  logo_path: string | null;
};

type Me = { id: string; org_id: string | null; org_role: string | null };
async function fetchMe(): Promise<Me | null> {
  const id = await getCurrentMemberId();
  if (!id) return null;
  const { data, error } = await supabase
    .from("members").select("id, org_id, org_role").eq("id", id).maybeSingle();
  if (error || !data) return null;
  return data as Me;
}
async function fetchProfiles(): Promise<Profile[]> {
  const { data, error } = await supabase
    .from("practice_profiles")
    .select("id, display_name, legal_name, branding_tier, status, owner_org_id, owner_member_id, logo_path")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as Profile[];
}

const STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  approved: { bg: "#E3F1EC", fg: "#0F7B5A", label: "Approved" },
  pending: { bg: "#FBF0DC", fg: "#9A6B12", label: "Pending review" },
  rejected: { bg: "#FBE4E1", fg: "#B42318", label: "Rejected" },
  suspended: { bg: "#EDEFEE", fg: "#5E726B", label: "Suspended" },
};

export default function BrandingScreen() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({ queryKey: ["practice-profiles"], queryFn: fetchProfiles });
  const { data: me } = useQuery({ queryKey: ["me-role"], queryFn: fetchMe });
  const [formOpen, setFormOpen] = useState(false);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "Practice profiles" }} />

      <Text style={styles.intro}>
        Practice profiles let you brand exported PDF documents with your clinic or
        organisation. Each profile is reviewed before it can appear on a document.
      </Text>

      {isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : isError ? (
        <Text style={styles.muted}>Could not load your profiles.</Text>
      ) : (data && data.length > 0) ? (
        data.map((p) => <ProfileCard key={p.id} p={p} me={me ?? null} onChange={() => qc.invalidateQueries({ queryKey: ["practice-profiles"] })} />)
      ) : (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>No practice profiles yet.</Text>
          <Text style={styles.muted}>Add one to brand your exported documents.</Text>
        </View>
      )}

      {!formOpen ? (
        <Pressable style={({ pressed }) => [styles.addBtn, pressed && styles.addBtnPressed]} onPress={() => setFormOpen(true)}>
          <Plus size={18} color={Theme.primary} />
          <Text style={styles.addBtnText}>Add practice profile</Text>
        </Pressable>
      ) : (
        <ProfileForm onDone={() => { setFormOpen(false); qc.invalidateQueries({ queryKey: ["practice-profiles"] }); }}
                     onCancel={() => setFormOpen(false)} />
      )}
    </ScrollView>
  );
}

function ProfileCard({ p, me, onChange }: { p: Profile; me: Me | null; onChange: () => void }) {
  const s = STATUS_STYLE[p.status] ?? STATUS_STYLE.pending;
  const tier = p.branding_tier === "whitelabel" ? "White-label" : "Co-brand";
  const scope = p.owner_org_id ? "Organisation" : "Personal";
  const [busy, setBusy] = useState<null | "approved" | "rejected">(null);
  const [err, setErr] = useState<string | null>(null);

  // Org-owner of THIS profile's org can approve/reject a pending ORG profile.
  const canReview =
    p.status === "pending" &&
    !!p.owner_org_id &&
    !!me &&
    me.org_role === "org_owner" &&
    me.org_id === p.owner_org_id;

  const review = async (decision: "approved" | "rejected") => {
    setBusy(decision); setErr(null);
    try {
      const { error } = await supabase.rpc("review_practice_profile", {
        p_profile_id: p.id, p_decision: decision, p_note: null,
      });
      if (error) throw error;
      onChange();
    } catch (e: any) {
      setErr(e?.message ?? "Could not update. Please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardName}>{p.display_name}</Text>
        <View style={[styles.pill, { backgroundColor: s.bg }]}><Text style={[styles.pillText, { color: s.fg }]}>{s.label}</Text></View>
      </View>
      <Text style={styles.cardMeta}>{scope}  {"\u00b7"}  {tier}{p.legal_name ? `  ${"\u00b7"}  ${p.legal_name}` : ""}</Text>
      {canReview ? (
        <View style={styles.reviewRow}>
          <Pressable style={[styles.reviewBtn, styles.approveBtn]} onPress={() => review("approved")} disabled={busy !== null}>
            {busy === "approved" ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.approveText}>Approve</Text>}
          </Pressable>
          <Pressable style={[styles.reviewBtn, styles.rejectBtn]} onPress={() => review("rejected")} disabled={busy !== null}>
            {busy === "rejected" ? <ActivityIndicator color={Theme.text} size="small" /> : <Text style={styles.rejectText}>Reject</Text>}
          </Pressable>
        </View>
      ) : null}
      {err ? <Text style={styles.err}>{err}</Text> : null}
    </View>
  );
}

function ProfileForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [scope, setScope] = useState<"member" | "org">("member");
  const [tier, setTier] = useState<"cobrand" | "whitelabel">("cobrand");
  const [displayName, setDisplayName] = useState("");
  const [legalName, setLegalName] = useState("");
  const [address, setAddress] = useState("");
  const [regNo, setRegNo] = useState("");
  const [color, setColor] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!displayName.trim()) { setErr("Display name is required."); return; }
    setBusy(true); setErr(null);
    try {
      const { error } = await supabase.rpc("submit_practice_profile", {
        p_scope: scope,
        p_display_name: displayName.trim(),
        p_legal_name: legalName.trim() || null,
        p_address: address.trim() || null,
        p_registration_no: regNo.trim() || null,
        p_brand_color: color.trim() || null,
        p_branding_tier: tier,
      });
      if (error) throw error;
      onDone();
    } catch (e: any) {
      setErr(e?.message ?? "Could not submit. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.form}>
      <View style={styles.formHead}>
        <Text style={styles.formTitle}>New practice profile</Text>
        <Pressable onPress={onCancel} hitSlop={10}><X size={20} color={Theme.textMuted} /></Pressable>
      </View>

      <Text style={styles.fieldLabel}>This profile is for</Text>
      <Segmented value={scope} options={[{ k: "member", l: "Me" }, { k: "org", l: "My organisation" }]}
                 onPick={(k) => setScope(k as "member" | "org")} />

      <Text style={styles.fieldLabel}>Branding</Text>
      <Segmented value={tier} options={[{ k: "cobrand", l: "Co-brand" }, { k: "whitelabel", l: "White-label" }]}
                 onPick={(k) => setTier(k as "cobrand" | "whitelabel")} />
      <Text style={styles.hint}>
        {tier === "whitelabel"
          ? "White-label replaces NanoHab branding with yours. Documents stay verifiable."
          : "Co-brand shows your name alongside NanoHab Connect."}
      </Text>

      <Field label="Display name" value={displayName} onChange={setDisplayName} placeholder="e.g. Sunshine Speech Centre" />
      <Field label="Legal name (optional)" value={legalName} onChange={setLegalName} placeholder="Registered entity name" />
      <Field label="Address (optional)" value={address} onChange={setAddress} placeholder="Clinic address" />
      <Field label="Registration no. (optional)" value={regNo} onChange={setRegNo} placeholder="Clinic licence / reg." />
      <Field label="Brand colour (optional)" value={color} onChange={setColor} placeholder="#0F6E56" autoCapitalize="none" />

      {err ? <Text style={styles.err}>{err}</Text> : null}

      <Pressable style={[styles.submit, busy && styles.submitBusy]} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitText}>Submit for review</Text>}
      </Pressable>
      <Text style={styles.hint}>A profile must be approved before it can brand a document.</Text>
    </View>
  );
}

function Segmented({ value, options, onPick }: { value: string; options: { k: string; l: string }[]; onPick: (k: string) => void }) {
  return (
    <View style={styles.segmented}>
      {options.map((o) => (
        <Pressable key={o.k} style={[styles.seg, value === o.k && styles.segActive]} onPress={() => onPick(o.k)}>
          <Text style={[styles.segText, value === o.k && styles.segTextActive]}>{o.l}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function Field({ label, value, onChange, placeholder, autoCapitalize }:
  { label: string; value: string; onChange: (s: string) => void; placeholder?: string; autoCapitalize?: "none" | "sentences" }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} placeholder={placeholder}
                 placeholderTextColor={Theme.textMuted} autoCapitalize={autoCapitalize ?? "sentences"} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  content: { padding: 24, gap: 16 },
  intro: { fontSize: 14, color: Theme.textMuted, lineHeight: 20 },
  loader: { marginTop: 40 },
  muted: { color: Theme.textMuted, fontSize: 14 },
  empty: { paddingVertical: 28, alignItems: "center", gap: 4 },
  emptyText: { fontSize: 16, fontWeight: "600", color: Theme.text },
  card: { backgroundColor: Theme.surface, borderRadius: 16, borderWidth: 1, borderColor: Theme.border, padding: 18, gap: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  cardName: { fontSize: 17, fontWeight: "700", color: Theme.text, flexShrink: 1 },
  cardMeta: { fontSize: 13.5, color: Theme.textMuted },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 12, fontWeight: "700" },
  addBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderColor: Theme.border, borderRadius: 12, paddingVertical: 16 },
  addBtnPressed: { backgroundColor: Theme.surface },
  addBtnText: { color: Theme.primary, fontSize: 16, fontWeight: "600" },
  form: { backgroundColor: Theme.surface, borderRadius: 16, borderWidth: 1, borderColor: Theme.border, padding: 18, gap: 10 },
  formHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  formTitle: { fontSize: 17, fontWeight: "700", color: Theme.text },
  fieldLabel: { fontSize: 13, fontWeight: "600", color: Theme.textMuted, marginTop: 6 },
  field: { gap: 0 },
  input: { borderWidth: 1, borderColor: Theme.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 15, color: Theme.text, marginTop: 6, backgroundColor: Theme.background },
  hint: { fontSize: 12.5, color: Theme.textMuted, lineHeight: 18 },
  segmented: { flexDirection: "row", backgroundColor: Theme.background, borderRadius: 10, borderWidth: 1, borderColor: Theme.border, padding: 3, marginTop: 6 },
  seg: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: "center" },
  segActive: { backgroundColor: Theme.primary },
  segText: { fontSize: 14, fontWeight: "600", color: Theme.textMuted },
  segTextActive: { color: "#fff" },
  err: { color: "#B42318", fontSize: 13, marginTop: 4 },
  logoRow: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 8, alignSelf: "flex-start" },
  logoRowText: { color: Theme.primary, fontSize: 14, fontWeight: "600" },
  reviewRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  reviewBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: "center" },
  approveBtn: { backgroundColor: Theme.primary },
  approveText: { color: "#fff", fontSize: 14.5, fontWeight: "700" },
  rejectBtn: { borderWidth: 1, borderColor: Theme.border },
  rejectText: { color: Theme.text, fontSize: 14.5, fontWeight: "600" },
  submit: { backgroundColor: Theme.primary, borderRadius: 12, paddingVertical: 15, alignItems: "center", marginTop: 12 },
  submitBusy: { opacity: 0.7 },
  submitText: { color: "#fff", fontSize: 16, fontWeight: "700" },
});
