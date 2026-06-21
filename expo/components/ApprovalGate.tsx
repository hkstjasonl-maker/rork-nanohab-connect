// expo/components/ApprovalGate.tsx
// Wraps the "Save as note" (approve) action with a clinical sign-off gate:
//  - if the member's profile is missing registration_no/credentials, shows an
//    amber notice with inline fields to add them now (saves immediately), and
//  - on Approve, if still incomplete, asks for explicit confirmation before
//    proceeding (the snapshot will store nulls -> rendered as "[not provided]").
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react-native";
import { Theme } from "@/constants/colors";
import { getMyProfile, updateMyProfile } from "@/lib/member";

type Props = {
  onApprove: () => void;
  busy: boolean;
};

export default function ApprovalGate({ onApprove, busy }: Props) {
  const queryClient = useQueryClient();
  const profileQ = useQuery({ queryKey: ["my-profile"], queryFn: getMyProfile });
  const profile = profileQ.data;

  const [reg, setReg] = useState("");
  const [cred, setCred] = useState("");
  const [saving, setSaving] = useState(false);

  const missingReg = !profile?.registration_no;
  const missingCred = !profile?.credentials;
  const incomplete = missingReg || missingCred;

  const saveInline = async () => {
    const patch: { registration_no?: string; credentials?: string } = {};
    if (missingReg && reg.trim()) patch.registration_no = reg.trim();
    if (missingCred && cred.trim()) patch.credentials = cred.trim();
    if (Object.keys(patch).length === 0) return;
    try {
      setSaving(true);
      await updateMyProfile(patch);
      await queryClient.invalidateQueries({ queryKey: ["my-profile"] });
      setReg("");
      setCred("");
    } catch (e) {
      Alert.alert("Couldn't save", (e as Error).message ?? "Please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = () => {
    if (incomplete) {
      const missingBits = [
        missingReg ? "registration number" : null,
        missingCred ? "credentials" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      Alert.alert(
        "Approve without complete details?",
        `Your ${missingBits} ${missingReg && missingCred ? "are" : "is"} not set. ` +
          `The approval will record this as "[not provided]". You can add it above first if you prefer.`,
        [
          { text: "Go back", style: "cancel" },
          { text: "Approve anyway", style: "destructive", onPress: onApprove },
        ],
      );
    } else {
      onApprove();
    }
  };

  return (
    <View style={styles.wrap}>
      {incomplete && !profileQ.isLoading ? (
        <View style={styles.notice}>
          <View style={styles.noticeHead}>
            <TriangleAlert color={Theme.coral} size={16} />
            <Text style={styles.noticeTitle}>Complete your sign-off details</Text>
          </View>
          <Text style={styles.noticeBody}>
            These appear on the approved note. Add them now, or approve and record
            them as “[not provided]”.
          </Text>

          {missingReg ? (
            <TextInput
              style={styles.input}
              value={reg}
              onChangeText={setReg}
              placeholder="Registration number"
              placeholderTextColor={Theme.textMuted}
              autoCapitalize="characters"
            />
          ) : null}
          {missingCred ? (
            <TextInput
              style={styles.input}
              value={cred}
              onChangeText={setCred}
              placeholder="Credentials (e.g. Speech-Language Pathologist)"
              placeholderTextColor={Theme.textMuted}
            />
          ) : null}

          {(reg.trim() || cred.trim()) ? (
            <Pressable style={styles.saveBtn} onPress={saveInline} disabled={saving}>
              {saving ? (
                <ActivityIndicator color={Theme.primary} size="small" />
              ) : (
                <Text style={styles.saveBtnText}>Save details</Text>
              )}
            </Pressable>
          ) : null}
        </View>
      ) : null}

      <Pressable
        style={({ pressed }) => [styles.primaryBtn, (busy || pressed) && styles.btnPressed]}
        onPress={handleApprove}
        disabled={busy}
        testID="save-note-button"
      >
        {busy ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Text style={styles.primaryBtnText}>Save as note</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  notice: {
    backgroundColor: "#FBEAE3",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#F0C9BB",
    padding: 14,
    gap: 10,
  },
  noticeHead: { flexDirection: "row", alignItems: "center", gap: 8 },
  noticeTitle: { fontSize: 14, fontWeight: "700", color: "#8A4B36" },
  noticeBody: { fontSize: 13, color: "#8A4B36", lineHeight: 18 },
  input: {
    backgroundColor: "#FFFFFF",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#F0C9BB",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: Theme.text,
  },
  saveBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.primary,
    backgroundColor: "#FFFFFF",
  },
  saveBtnText: { color: Theme.primary, fontWeight: "700", fontSize: 13 },
  primaryBtn: {
    backgroundColor: Theme.primary,
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  primaryBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
  btnPressed: { opacity: 0.85 },
});
