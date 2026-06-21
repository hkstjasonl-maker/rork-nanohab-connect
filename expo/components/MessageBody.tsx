import { useQuery } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { Languages, Volume2, X } from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import {
  speakMessage,
  translateMessage,
  type MessageTranslation,
} from "@/lib/api";

type MessageItem = { id: string; body: string | null };

const TARGETS: { label: string; code: string }[] = [
  { label: "English", code: "en" },
  { label: "繁體中文", code: "zh-Hant" },
  { label: "简体中文", code: "zh-Hans" },
];

// A text message. The row itself shows only text (plus a tiny "show original"
// toggle when auto-translated). Everything else — translate to a language,
// read aloud — lives behind a long-press, to keep the thread uncluttered.
export function MessageBody({
  item,
  displayLanguage,
  autoTranslate,
}: {
  item: MessageItem;
  displayLanguage?: string | null;
  autoTranslate?: boolean;
}) {
  const [open, setOpen] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [manual, setManual] = useState<MessageTranslation | null>(null);
  const [showOriginal, setShowOriginal] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState<boolean>(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  const auto = useQuery({
    queryKey: ["msg-auto-tr", item.id, displayLanguage],
    enabled: !!autoTranslate && !!displayLanguage && !!item.body,
    staleTime: Infinity,
    queryFn: async (): Promise<{
      translation: string;
      detected: string | null;
    }> => {
      const { data } = await supabase
        .from("message_translations")
        .select("translation, detected_source")
        .eq("message_id", item.id)
        .eq("target_language", displayLanguage as string)
        .maybeSingle();
      if (data) {
        return {
          translation: data.translation as string,
          detected: (data.detected_source ?? null) as string | null,
        };
      }
      const r = await translateMessage(item.id, displayLanguage as string);
      return { translation: r.translation, detected: r.detected_source };
    },
  });

  const onPick = useCallback(
    async (code: string) => {
      setOpen(false);
      setBusy(true);
      setErr(null);
      try {
        const r = await translateMessage(item.id, code);
        setManual(r);
      } catch {
        setErr("Could not translate this message");
      } finally {
        setBusy(false);
      }
    },
    [item.id],
  );

  const onSpeak = useCallback(async () => {
    setOpen(false);
    setErr(null);
    try {
      if (soundRef.current) {
        await soundRef.current.unloadAsync().catch(() => {});
        soundRef.current = null;
        setSpeaking(false);
        return;
      }
      setSpeaking(true);
      const uri = await speakMessage(item.id, displayLanguage ?? undefined);
      const { sound } = await Audio.Sound.createAsync(
        { uri },
        { shouldPlay: true },
      );
      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          setSpeaking(false);
        }
      });
    } catch (e: unknown) {
      setSpeaking(false);
      const msg = e instanceof Error ? e.message : "";
      setErr(
        msg.includes("not configured")
          ? "Read-aloud isn't set up yet"
          : "Could not read this aloud",
      );
    }
  }, [item.id, displayLanguage]);

  useEffect(() => {
    return () => {
      soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  if (!item.body) {
    return null;
  }

  const autoTranslation =
    auto.data &&
    (!auto.data.detected || auto.data.detected !== displayLanguage)
      ? auto.data.translation
      : null;

  const primaryText =
    autoTranslation && !showOriginal ? autoTranslation : item.body;

  return (
    <View>
      <Pressable onLongPress={() => setOpen(true)} delayLongPress={300}>
        <Text style={styles.body}>{primaryText}</Text>
      </Pressable>

      {/* Only inline affordance: flip an auto-translated message to its original. */}
      {autoTranslation ? (
        <Pressable
          style={styles.metaItem}
          onPress={() => setShowOriginal((v) => !v)}
          hitSlop={6}
        >
          <Languages size={12} color={Theme.primary} />
          <Text style={styles.metaText}>
            {showOriginal ? "Show translation" : "Show original"}
          </Text>
        </Pressable>
      ) : null}

      {speaking ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={Theme.primary} />
          <Text style={styles.busyText}>Reading aloud… (long-press to stop)</Text>
        </View>
      ) : null}

      {busy ? (
        <View style={styles.busyRow}>
          <ActivityIndicator size="small" color={Theme.primary} />
          <Text style={styles.busyText}>Translating…</Text>
        </View>
      ) : null}

      {manual ? (
        <View style={styles.translationBox}>
          <View style={styles.translationHead}>
            <Languages size={13} color={Theme.primary} />
            <Text style={styles.translationTag}>
              Machine translation · {manual.target_language}
            </Text>
            <Pressable onPress={() => setManual(null)} hitSlop={8}>
              <X size={14} color={Theme.textMuted} />
            </Pressable>
          </View>
          <Text style={styles.translationText}>{manual.translation}</Text>
          <Text style={styles.disclaimer}>{manual.disclaimer}</Text>
        </View>
      ) : null}

      {err ? <Text style={styles.err}>{err}</Text> : null}

      {open ? (
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <View style={styles.sheetWrap}>
            <View style={styles.sheet}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>Message</Text>
                <Pressable onPress={() => setOpen(false)} hitSlop={12}>
                  <X color={Theme.textMuted} size={22} />
                </Pressable>
              </View>

              <Pressable style={styles.option} onPress={onSpeak}>
                <Volume2 size={18} color={Theme.primary} />
                <Text style={styles.optionText}>
                  {speaking ? "Stop reading" : "Read aloud"}
                </Text>
              </Pressable>

              <View style={styles.divider} />
              <Text style={styles.sectionLabel}>Translate to</Text>

              {TARGETS.map((t) => (
                <Pressable
                  key={t.code}
                  style={styles.option}
                  onPress={() => onPick(t.code)}
                >
                  <Languages size={18} color={Theme.primary} />
                  <Text style={styles.optionText}>{t.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: 15, color: Theme.text, lineHeight: 21 },
  metaItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    marginTop: 4,
  },
  metaText: { fontSize: 11, color: Theme.primary, fontWeight: "600" },
  busyRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 6 },
  busyText: { fontSize: 12, color: Theme.textMuted },
  translationBox: {
    marginTop: 8,
    borderLeftWidth: 3,
    borderLeftColor: Theme.primary,
    paddingLeft: 10,
    gap: 4,
  },
  translationHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  translationTag: {
    flex: 1,
    fontSize: 11,
    color: Theme.primary,
    fontWeight: "600",
  },
  translationText: { fontSize: 15, color: Theme.text, lineHeight: 21 },
  disclaimer: { fontSize: 11, color: Theme.textMuted, fontStyle: "italic" },
  err: { fontSize: 12, color: Theme.coral, marginTop: 4 },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: Theme.background,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    padding: 20,
    paddingBottom: 36,
    gap: 8,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 17, fontWeight: "700", color: Theme.text },
  sectionLabel: {
    fontSize: 12,
    color: Theme.textMuted,
    fontWeight: "600",
    marginTop: 4,
    marginBottom: 2,
  },
  divider: { height: 1, backgroundColor: Theme.border, marginVertical: 4 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 14,
    borderRadius: 12,
    backgroundColor: Theme.surface,
  },
  optionText: { fontSize: 16, color: Theme.text, fontWeight: "600" },
});
