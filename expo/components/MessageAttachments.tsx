import { useQuery } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { Image } from "expo-image";
import { FileText, Languages, Pause, Play } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
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
  getAttachmentUrl,
  transcribeAttachment,
  translateTranscript,
} from "@/lib/api";

type AttachmentRow = {
  id: string;
  mime_type: string | null;
  scan_status: string;
  original_name: string | null;
  created_at: string;
};

const READY_STATES = ["transcribed", "drafted", "under_review", "posted", "approved"];

// Per-message attachment strip. Reads rows via RLS (membership enforced in
// Postgres); the bytes are only ever fetched via the gated signed-URL endpoint.
export function MessageAttachments({
  roomId,
  messageId,
}: {
  roomId: string;
  messageId: string;
}) {
  const q = useQuery({
    queryKey: ["attachments", messageId],
    queryFn: async (): Promise<AttachmentRow[]> => {
      const { data, error } = await supabase
        .from("attachments")
        .select("id, mime_type, scan_status, original_name, created_at")
        .eq("message_id", messageId)
        .order("created_at");
      if (error) {
        throw error;
      }
      return (data ?? []) as AttachmentRow[];
    },
    // Keep polling while a freshly uploaded file is still scanning.
    refetchInterval: (query) => {
      const rows = (query.state.data as AttachmentRow[] | undefined) ?? [];
      return rows.some((r) => r.scan_status === "pending") ? 3000 : false;
    },
  });

  const rows = q.data ?? [];
  if (rows.length === 0) {
    return null;
  }
  return (
    <View style={styles.wrap}>
      {rows.map((a) => (
        <AttachmentItem key={a.id} roomId={roomId} att={a} />
      ))}
    </View>
  );
}

function AttachmentItem({
  roomId,
  att,
}: {
  roomId: string;
  att: AttachmentRow;
}) {
  const mime = att.mime_type ?? "";

  if (att.scan_status === "pending") {
    return (
      <View style={styles.chip}>
        <ActivityIndicator size="small" color={Theme.primary} />
        <Text style={styles.chipText}>Scanning…</Text>
      </View>
    );
  }
  if (att.scan_status === "infected") {
    return (
      <View style={styles.chip}>
        <FileText size={16} color={Theme.coral} />
        <Text style={[styles.chipText, styles.danger]}>
          File blocked by safety scan
        </Text>
      </View>
    );
  }
  if (att.scan_status !== "clean") {
    return (
      <View style={styles.chip}>
        <Text style={styles.chipText}>Attachment unavailable</Text>
      </View>
    );
  }

  if (mime.startsWith("image/")) {
    return <ImageAttachment att={att} />;
  }
  if (mime.startsWith("audio/")) {
    return <AudioAttachment att={att} />;
  }
  return (
    <View style={styles.chip}>
      <FileText size={16} color={Theme.primary} />
      <Text style={styles.chipText}>{att.original_name ?? "Attachment"}</Text>
    </View>
  );
}

function ImageAttachment({ att }: { att: AttachmentRow }) {
  const u = useQuery({
    queryKey: ["att-url", att.id],
    queryFn: () => getAttachmentUrl(att.id),
    staleTime: 4 * 60 * 1000, // signed URL lives 5 min; refresh before expiry
  });
  if (u.isLoading) {
    return (
      <View style={styles.imagePlaceholder}>
        <ActivityIndicator color={Theme.primary} />
      </View>
    );
  }
  if (u.isError || !u.data) {
    return (
      <View style={styles.chip}>
        <Text style={styles.chipText}>Could not load image</Text>
      </View>
    );
  }
  return (
    <Image source={{ uri: u.data.url }} style={styles.image} contentFit="cover" />
  );
}

function AudioAttachment({ att }: { att: AttachmentRow }) {
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [transcriptId, setTranscriptId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [translation, setTranslation] = useState<{
    text: string;
    original: string;
    disclaimer: string;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const play = useCallback(async () => {
    try {
      setErr(null);
      if (sound) {
        if (playing) {
          await sound.pauseAsync();
          setPlaying(false);
        } else {
          await sound.playAsync();
          setPlaying(true);
        }
        return;
      }
      const { url } = await getAttachmentUrl(att.id);
      const { sound: s } = await Audio.Sound.createAsync(
        { uri: url },
        { shouldPlay: true },
      );
      s.setOnPlaybackStatusUpdate((st) => {
        if (st.isLoaded && st.didJustFinish) {
          setPlaying(false);
        }
      });
      setSound(s);
      setPlaying(true);
    } catch {
      setErr("Could not play audio");
    }
  }, [sound, playing, att.id]);

  useEffect(() => {
    return () => {
      sound?.unloadAsync().catch(() => {});
    };
  }, [sound]);

  // Poll the transcript artifact once transcription is kicked off.
  const tq = useQuery({
    queryKey: ["transcript", transcriptId],
    enabled: !!transcriptId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("ai_artifacts")
        .select("state, transcript")
        .eq("id", transcriptId)
        .maybeSingle();
      if (error) {
        throw error;
      }
      return data as { state: string; transcript: string | null } | null;
    },
    refetchInterval: (query) => {
      const d = query.state.data as { state: string } | null | undefined;
      return d && READY_STATES.includes(d.state) ? false : 3000;
    },
  });

  useEffect(() => {
    if (tq.data?.transcript != null) {
      setTranscript(tq.data.transcript);
    }
  }, [tq.data]);

  const onTranscribe = useCallback(async () => {
    try {
      setBusy(true);
      setErr(null);
      const id = await transcribeAttachment(att.id);
      setTranscriptId(id);
    } catch {
      setErr("Could not start transcription");
    } finally {
      setBusy(false);
    }
  }, [att.id]);

  const onTranslate = useCallback(async () => {
    if (!transcriptId) {
      return;
    }
    try {
      setBusy(true);
      setErr(null);
      const r = await translateTranscript(transcriptId);
      setTranslation({
        text: r.translation,
        original: r.original,
        disclaimer: r.disclaimer,
      });
    } catch {
      setErr("Could not translate");
    } finally {
      setBusy(false);
    }
  }, [transcriptId]);

  return (
    <View style={styles.audioWrap}>
      <View style={styles.audioRow}>
        <Pressable onPress={play} style={styles.playBtn} hitSlop={8}>
          {playing ? (
            <Pause size={18} color="#FFFFFF" />
          ) : (
            <Play size={18} color="#FFFFFF" />
          )}
        </Pressable>
        <Text style={styles.audioLabel}>
          {att.original_name ?? "Voice note"}
        </Text>
      </View>

      <View style={styles.actionRow}>
        {!transcriptId ? (
          <Pressable
            onPress={onTranscribe}
            disabled={busy}
            style={styles.actionBtn}
          >
            {busy ? (
              <ActivityIndicator size="small" color={Theme.primary} />
            ) : (
              <Text style={styles.actionText}>Transcribe</Text>
            )}
          </Pressable>
        ) : transcript == null ? (
          <View style={styles.actionBtn}>
            <ActivityIndicator size="small" color={Theme.primary} />
            <Text style={styles.actionText}> Transcribing…</Text>
          </View>
        ) : null}

        {transcript != null ? (
          <Pressable
            onPress={onTranslate}
            disabled={busy}
            style={styles.actionBtn}
          >
            <Languages size={14} color={Theme.primary} />
            <Text style={styles.actionText}> Translate</Text>
          </Pressable>
        ) : null}
      </View>

      {transcript != null ? (
        <Text style={styles.transcript}>{transcript}</Text>
      ) : null}

      {translation ? (
        <View style={styles.translationBox}>
          <Text style={styles.translationText}>{translation.text}</Text>
          <Text style={styles.original}>Original: {translation.original}</Text>
          <Text style={styles.disclaimer}>{translation.disclaimer}</Text>
        </View>
      ) : null}

      {err ? <Text style={styles.err}>{err}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8, gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    backgroundColor: Theme.surface,
    borderRadius: 10,
    alignSelf: "flex-start",
  },
  chipText: { fontSize: 13, color: Theme.textMuted },
  danger: { color: Theme.coral },
  image: { width: 220, height: 220, borderRadius: 12, backgroundColor: Theme.surface },
  imagePlaceholder: {
    width: 220,
    height: 220,
    borderRadius: 12,
    backgroundColor: Theme.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  audioWrap: {
    backgroundColor: Theme.surface,
    borderRadius: 12,
    padding: 12,
    gap: 8,
    alignSelf: "stretch",
  },
  audioRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  playBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  audioLabel: { fontSize: 14, color: Theme.text, flexShrink: 1 },
  actionRow: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: Theme.border,
    backgroundColor: Theme.background,
  },
  actionText: { fontSize: 13, color: Theme.primary, fontWeight: "600" },
  transcript: { fontSize: 14, color: Theme.text, lineHeight: 20 },
  translationBox: {
    borderLeftWidth: 3,
    borderLeftColor: Theme.primary,
    paddingLeft: 10,
    gap: 4,
  },
  translationText: { fontSize: 14, color: Theme.text, lineHeight: 20 },
  original: { fontSize: 12, color: Theme.textMuted },
  disclaimer: { fontSize: 11, color: Theme.textMuted, fontStyle: "italic" },
  err: { fontSize: 12, color: Theme.coral },
});
