// expo/components/SignatureBlock.tsx
// Renders the immutable e-signature stamp on an approved/posted clinical note,
// from ai_artifacts.approver_snapshot. Missing fields show "[not provided]".
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Check } from "lucide-react-native";
import { Theme } from "@/constants/colors";

export type ApproverSnapshot = {
  member_id?: string | null;
  full_name?: string | null;
  credentials?: string | null;
  registration_no?: string | null;
  discipline?: string | null;
  signed_at?: string | null;
};

const DISCIPLINE_LABEL: Record<string, string> = {
  medical: "Doctor",
  nursing: "Nurse",
  allied_health: "Allied health professional",
  universal: "",
};

function fmtTime(iso?: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const NP = "[not provided]";

export default function SignatureBlock({ snapshot }: { snapshot?: ApproverSnapshot | null }) {
  if (!snapshot) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.caption}>This note is final.</Text>
      </View>
    );
  }
  const name = snapshot.full_name?.trim() || NP;
  const cred = snapshot.credentials?.trim();
  const disc = snapshot.discipline ? DISCIPLINE_LABEL[snapshot.discipline] ?? snapshot.discipline : "";
  const role = cred || disc || NP;
  const reg = snapshot.registration_no?.trim() || NP;
  const when = fmtTime(snapshot.signed_at);

  return (
    <View style={styles.wrap}>
      <View style={styles.headerRow}>
        <View style={styles.checkCircle}>
          <Check color="#FFFFFF" size={13} strokeWidth={3} />
        </View>
        <Text style={styles.title}>Electronically approved</Text>
      </View>
      <Text style={styles.name}>
        {name}
        {role ? <Text style={styles.role}>{"  ·  " + role}</Text> : null}
      </Text>
      <Text style={styles.meta}>
        Reg. No. <Text style={reg === NP ? styles.missing : styles.metaStrong}>{reg}</Text>
        {when ? `   ·   ${when}` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginTop: 4,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    backgroundColor: Theme.surface,
    gap: 4,
  },
  headerRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 },
  checkCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: Theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 13, fontWeight: "700", color: Theme.primary, letterSpacing: 0.3 },
  name: { fontSize: 15, fontWeight: "700", color: Theme.text },
  role: { fontSize: 14, fontWeight: "500", color: Theme.textMuted },
  meta: { fontSize: 13, color: Theme.textMuted, marginTop: 2 },
  metaStrong: { color: Theme.text, fontWeight: "600" },
  missing: { color: Theme.coral, fontWeight: "600" },
  caption: { fontSize: 13, color: Theme.textMuted },
});
