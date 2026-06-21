import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Languages, X } from "lucide-react-native";
import React, { useState } from "react";
import { Modal, Pressable, StyleSheet, Switch, Text, View } from "react-native";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

const OPTIONS: { label: string; code: string | null }[] = [
  { label: "Off (show original)", code: null },
  { label: "English", code: "en" },
  { label: "繁體中文", code: "zh-Hant" },
  { label: "简体中文", code: "zh-Hans" },
];

// Globe control: pick which language to read in, and whether to auto-translate
// (eager) or show originals first (long-press to translate on demand).
export function DisplayLanguageButton({
  current,
  autoTranslate,
}: {
  current: string | null;
  autoTranslate: boolean;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<boolean>(false);

  const setLang = useMutation({
    mutationFn: async (code: string | null): Promise<void> => {
      const { error } = await supabase.rpc("set_my_display_language", {
        p_lang: code,
      });
      if (error) {
        throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-display-language"] }),
    onError: (e) => console.error("Set display language failed:", e),
  });

  const setAuto = useMutation({
    mutationFn: async (on: boolean): Promise<void> => {
      const { error } = await supabase.rpc("set_my_auto_translate", {
        p_on: on,
      });
      if (error) {
        throw error;
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["my-display-language"] }),
    onError: (e) => console.error("Set auto-translate failed:", e),
  });

  const languageOff = current == null;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        hitSlop={12}
        testID="display-language-button"
      >
        <Languages color={Theme.primary} size={22} />
      </Pressable>

      <Modal
        visible={open}
        animationType="fade"
        transparent
        onRequestClose={() => setOpen(false)}
      >
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <View style={styles.head}>
              <Text style={styles.title}>Show messages in…</Text>
              <Pressable onPress={() => setOpen(false)} hitSlop={12}>
                <X color={Theme.textMuted} size={22} />
              </Pressable>
            </View>

            {OPTIONS.map((o) => {
              const selected =
                current === o.code || (current == null && o.code == null);
              return (
                <Pressable
                  key={o.label}
                  style={styles.option}
                  disabled={setLang.isPending}
                  onPress={() => setLang.mutate(o.code)}
                >
                  <Text style={styles.optionText}>{o.label}</Text>
                  {selected ? <Check size={18} color={Theme.primary} /> : null}
                </Pressable>
              );
            })}

            <View style={styles.divider} />

            <View style={[styles.option, languageOff && styles.optionDisabled]}>
              <View style={styles.toggleLabelWrap}>
                <Text style={styles.optionText}>Auto-translate messages</Text>
                <Text style={styles.toggleHint}>
                  {languageOff
                    ? "Pick a language above to enable"
                    : autoTranslate
                      ? "Others' messages are translated for you"
                      : "Originals shown — long-press a message to translate"}
                </Text>
              </View>
              <Switch
                value={autoTranslate}
                disabled={languageOff || setAuto.isPending}
                onValueChange={(v) => setAuto.mutate(v)}
                trackColor={{ true: Theme.primary, false: Theme.border }}
              />
            </View>
          </View>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: Theme.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 36,
    gap: 8,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 4,
  },
  title: { fontSize: 17, fontWeight: "700", color: Theme.text },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: Theme.surface,
  },
  optionDisabled: { opacity: 0.55 },
  optionText: { fontSize: 16, color: Theme.text, fontWeight: "600" },
  toggleLabelWrap: { flex: 1, paddingRight: 12, gap: 2 },
  toggleHint: { fontSize: 11, color: Theme.textMuted },
  divider: { height: 1, backgroundColor: Theme.border, marginVertical: 4 },
});
