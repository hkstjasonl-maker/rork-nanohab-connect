import { useQuery } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { Volume2, X } from "lucide-react-native";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { speakMessage } from "@/lib/api";

type MessageRow = {
  id: string;
  body: string | null;
  author_member_id: string | null;
  created_at: string;
};

const MAX_UNREAD = 20;

// Pinned bar shown only when there are unread messages from others. Shows the
// count, reads them aloud in sequence in the reader's language (long-press to
// stop), and advances the read marker when done. Dismissable with the X.
export function UnreadBanner({
  roomId,
  messages,
  myMemberId,
  displayLanguage,
}: {
  roomId: string;
  messages: MessageRow[];
  myMemberId: string | null;
  displayLanguage: string | null;
}) {
  const [playing, setPlaying] = useState<boolean>(false);
  const [progress, setProgress] = useState<{ i: number; n: number } | null>(null);
  const [dismissed, setDismissed] = useState<boolean>(false);
  const cancelRef = useRef<boolean>(false);
  const soundRef = useRef<Audio.Sound | null>(null);

  // My last-read marker for this room (null row -> read everything).
  const markerQuery = useQuery({
    queryKey: ["room-read-state", roomId, myMemberId],
    enabled: !!myMemberId,
    queryFn: async (): Promise<number> => {
      const { data } = await supabase
        .from("room_read_state")
        .select("last_read_at")
        .eq("room_id", roomId)
        .maybeSingle();
      return data?.last_read_at ? new Date(data.last_read_at).getTime() : 0;
    },
  });

  const lastRead = markerQuery.data ?? 0;

  const unread = useMemo(
    () =>
      messages
        .filter(
          (m) =>
            (m.body ?? "").trim().length > 0 &&
            m.author_member_id !== myMemberId &&
            new Date(m.created_at).getTime() > lastRead,
        )
        .slice(-MAX_UNREAD),
    [messages, myMemberId, lastRead],
  );

  const playOne = useCallback((uri: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      Audio.Sound.createAsync({ uri }, { shouldPlay: true })
        .then(({ sound }) => {
          soundRef.current = sound;
          sound.setOnPlaybackStatusUpdate((st) => {
            if (st.isLoaded && st.didJustFinish) {
              sound.unloadAsync().catch(() => {});
              soundRef.current = null;
              resolve();
            }
          });
        })
        .catch(() => resolve());
    });
  }, []);

  const stop = useCallback(async () => {
    cancelRef.current = true;
    await soundRef.current?.unloadAsync().catch(() => {});
    soundRef.current = null;
    setPlaying(false);
    setProgress(null);
  }, []);

  const start = useCallback(async () => {
    if (playing) {
      return;
    }
    cancelRef.current = false;
    setPlaying(true);
    try {
      for (let i = 0; i < unread.length; i++) {
        if (cancelRef.current) {
          break;
        }
        setProgress({ i: i + 1, n: unread.length });
        try {
          const uri = await speakMessage(unread[i].id, displayLanguage ?? undefined);
          if (cancelRef.current) {
            break;
          }
          await playOne(uri);
        } catch {
          // skip a message that failed to synthesize; keep going
        }
      }
    } finally {
      soundRef.current = null;
      setPlaying(false);
      setProgress(null);
      try { await supabase.rpc("mark_room_read", { p_room_id: roomId }); } catch {}
      markerQuery.refetch();
    }
  }, [playing, unread, displayLanguage, playOne, roomId, markerQuery]);

  if (dismissed || unread.length === 0) {
    return null;
  }

  const label = playing
    ? progress
      ? `Reading ${progress.i} of ${progress.n}… (long-press to stop)`
      : "Reading…"
    : `${unread.length} new message${unread.length === 1 ? "" : "s"} — tap to read aloud`;

  return (
    <View style={styles.bar}>
      <Pressable
        style={styles.main}
        onPress={start}
        onLongPress={stop}
        delayLongPress={300}
        hitSlop={6}
      >
        {playing ? (
          <ActivityIndicator size="small" color={Theme.primary} />
        ) : (
          <Volume2 size={16} color={Theme.primary} />
        )}
        <Text style={styles.text}>{label}</Text>
      </Pressable>
      <Pressable
        onPress={() => {
          if (playing) {
            stop();
          }
          setDismissed(true);
        }}
        hitSlop={10}
      >
        <X size={16} color={Theme.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: Theme.surface,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
  },
  main: { flex: 1, flexDirection: "row", alignItems: "center", gap: 8 },
  text: { flex: 1, fontSize: 13, color: Theme.text, fontWeight: "600" },
});
