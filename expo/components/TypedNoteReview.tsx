// expo/components/TypedNoteReview.tsx
// Review/edit/approve surface for a typed note-draft. Keyboard-safe on iOS:
// KeyboardAvoidingView keeps the action bar above the keyboard, a Done button
// dismisses it, and tapping the scroll area dismisses it too.
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  TouchableWithoutFeedback,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const C = {
  primary: "#0F6E56",
  coral: "#F08A6E",
  text: "#1A1F1D",
  textMuted: "#5C6661",
  surface: "#F4F6F5",
  border: "#E2E6E4",
  bg: "#FFFFFF",
  warnBg: "#FBEAE3",
};

type Props = {
  draft: string;
  templateName: string;
  riskTier: "narrative" | "extract_flag";
  onSaveEdit?: (text: string) => Promise<void> | void;
  onApprove?: (text: string) => Promise<void> | void;
  onClose?: () => void;
};

export default function TypedNoteReview({
  draft,
  templateName,
  riskTier,
  onSaveEdit,
  onApprove,
  onClose,
}: Props) {
  const [text, setText] = useState(draft);
  const [busy, setBusy] = useState<"save" | "approve" | null>(null);
  const insets = useSafeAreaInsets();

  const run = async (which: "save" | "approve") => {
    try {
      setBusy(which);
      if (which === "save") await onSaveEdit?.(text);
      else await onApprove?.(text);
    } finally {
      setBusy(null);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.wrap}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{templateName}</Text>
          <Text style={styles.subtitle}>Draft for review - edit before approving</Text>
        </View>
        {onClose && (
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Close</Text>
          </Pressable>
        )}
        <Pressable onPress={() => Keyboard.dismiss()} hitSlop={12} style={{ marginLeft: 14 }}>
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>

      {riskTier === "extract_flag" && (
        <View style={styles.warn}>
          <Text style={styles.warnText}>
            Values captured and flagged, not interpreted. Confirm every value against
            the source; clinical interpretation is yours.
          </Text>
        </View>
      )}

      <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
        <ScrollView
          style={styles.editorWrap}
          contentContainerStyle={{ padding: 12 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
        >
          <TextInput
            style={styles.editor}
            value={text}
            onChangeText={setText}
            multiline
            scrollEnabled={false}
            textAlignVertical="top"
          />
        </ScrollView>
      </TouchableWithoutFeedback>

      <View style={[styles.actions, { paddingBottom: insets.bottom + 10 }]}>
        <Pressable
          style={[styles.btn, styles.btnGhost]}
          disabled={busy !== null}
          onPress={() => run("save")}
        >
          {busy === "save" ? (
            <ActivityIndicator color={C.primary} />
          ) : (
            <Text style={styles.btnGhostText}>Save edit</Text>
          )}
        </Pressable>
        <Pressable
          style={[styles.btn, styles.btnPrimary]}
          disabled={busy !== null}
          onPress={() => run("approve")}
        >
          {busy === "approve" ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnPrimaryText}>Approve</Text>
          )}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 16,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  title: { fontSize: 18, fontWeight: "700", color: C.text },
  subtitle: { fontSize: 13, color: C.textMuted, marginTop: 2 },
  close: { fontSize: 15, color: C.textMuted, fontWeight: "600" },
  done: { fontSize: 15, color: C.primary, fontWeight: "700" },
  warn: { backgroundColor: C.warnBg, borderRadius: 10, padding: 10, margin: 16, marginBottom: 0 },
  warnText: { color: "#8A4B36", fontSize: 12, lineHeight: 17 },
  editorWrap: { flex: 1, margin: 16, borderWidth: 1, borderColor: C.border, borderRadius: 12, backgroundColor: C.surface },
  editor: { fontSize: 15, color: C.text, lineHeight: 22, minHeight: 200 },
  actions: { flexDirection: "row", gap: 12, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: "center" },
  btnGhost: { borderWidth: 1, borderColor: C.primary, backgroundColor: C.bg },
  btnGhostText: { color: C.primary, fontWeight: "700", fontSize: 15 },
  btnPrimary: { backgroundColor: C.primary },
  btnPrimaryText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
