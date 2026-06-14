import { File } from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { randomUUID } from "expo-crypto";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Mic, Square } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

type ArtifactRow = {
  id: string;
  state: string;
  transcript: string | null;
  created_at: string;
};

const TERMINAL_STATES = new Set(["posted", "approved", "discarded"]);
const WAITING_ON_CLINICIAN = new Set(["transcribed", "drafted", "under_review"]);

type Pill = { label: string; color: string; spinner?: boolean };

function stateToPill(state: string): Pill {
  switch (state) {
    case "recorded":
      return { label: "Transcribing…", color: Theme.primary, spinner: true };
    case "transcribed":
      return { label: "Ready to review", color: Theme.primary };
    case "drafted":
    case "under_review":
      return { label: "Draft ready", color: Theme.coral };
    case "posted":
      return { label: "Posted", color: Theme.primary };
    case "approved":
      return { label: "Saved as note", color: Theme.primary };
    case "discarded":
      return { label: "Discarded", color: Theme.grey };
    default:
      return { label: state, color: Theme.grey };
  }
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60000);
  if (mins < 1) {
    return "just now";
  }
  if (mins < 60) {
    return `${mins} min ago`;
  }
  const hours = Math.round(mins / 60);
  if (hours < 24) {
    return `${hours} hr ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${days} d ago`;
  }
  return new Date(iso).toLocaleDateString();
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function fetchArtifacts(roomId: string): Promise<ArtifactRow[]> {
  const { data, error } = await supabase
    .from("ai_artifacts")
    .select("id, state, transcript, created_at")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []) as ArtifactRow[];
}

export default function VoiceNotesScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const recordingRef = useRef<Audio.Recording | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [elapsed, setElapsed] = useState<number>(0);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const artifactsQuery = useQuery({
    queryKey: ["voice-notes", roomId],
    queryFn: () => fetchArtifacts(roomId),
    enabled: !!roomId,
  });

  const artifacts = useMemo(
    () => artifactsQuery.data ?? [],
    [artifactsQuery.data],
  );

  // Poll while any row is still being transcribed by the backend.
  const hasNonTerminal = useMemo(
    () =>
      artifacts.some(
        (a) => !TERMINAL_STATES.has(a.state) && !WAITING_ON_CLINICIAN.has(a.state),
      ),
    [artifacts],
  );

  const isFocusedRef = useRef<boolean>(true);
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      queryClient.invalidateQueries({ queryKey: ["voice-notes", roomId] });
      return () => {
        isFocusedRef.current = false;
      };
    }, [queryClient, roomId]),
  );

  useEffect(() => {
    if (!hasNonTerminal) {
      return;
    }
    const interval = setInterval(() => {
      if (isFocusedRef.current) {
        queryClient.invalidateQueries({ queryKey: ["voice-notes", roomId] });
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [hasNonTerminal, queryClient, roomId]);

  const startRecording = useCallback(async () => {
    setErrorText(null);
    try {
      const perm = await Audio.requestPermissionsAsync();
      if (!perm.granted) {
        setErrorText("Microphone permission is needed to record.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      setElapsed(0);
      setIsRecording(true);
      timerRef.current = setInterval(() => {
        setElapsed((e) => e + 1);
      }, 1000);
    } catch (e) {
      console.error("Start recording failed:", e);
      setErrorText("Could not start recording. Please try again.");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) {
      return;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
    let localUri: string | null = null;
    try {
      await recording.stopAndUnloadAsync();
      localUri = recording.getURI();
    } catch (e) {
      console.error("Stop recording failed:", e);
      setErrorText("Could not finish recording. Please try again.");
      recordingRef.current = null;
      return;
    }
    recordingRef.current = null;

    if (!localUri) {
      setErrorText("Recording was empty. Please try again.");
      return;
    }

    setIsUploading(true);
    try {
      const file = `${randomUUID()}.m4a`;
      // First folder MUST be roomId — storage RLS authorizes on it.
      const path = `${roomId}/${file}`;

      const base64 = await new File(localUri).base64();
      const { error: uploadError } = await supabase.storage
        .from("voice-notes")
        .upload(path, decode(base64), { contentType: "audio/m4a", upsert: false });
      if (uploadError) {
        throw uploadError;
      }

      // Only register the artifact after the audio is in the bucket.
      const { error: rpcError } = await supabase.rpc("create_voice_artifact", {
        p_room_id: roomId,
        p_audio_path: path,
      });
      if (rpcError) {
        throw rpcError;
      }

      queryClient.invalidateQueries({ queryKey: ["voice-notes", roomId] });
    } catch (e) {
      console.error("Upload / register voice note failed:", e);
      setErrorText(
        "Saved your recording but couldn't register it. Please try again.",
      );
    } finally {
      setIsUploading(false);
    }
  }, [queryClient, roomId]);

  // Clean up an in-progress recording if the screen unmounts.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
    };
  }, []);

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Stack.Screen
        options={{ title: "Voice notes", headerBackTitle: "Room" }}
      />

      <View style={styles.recorderCard}>
        <Pressable
          style={({ pressed }) => [
            styles.micButton,
            isRecording && styles.micButtonActive,
            (isUploading || pressed) && styles.micButtonPressed,
          ]}
          onPress={isRecording ? stopRecording : startRecording}
          disabled={isUploading}
          testID="record-button"
        >
          {isUploading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : isRecording ? (
            <Square color="#FFFFFF" size={28} fill="#FFFFFF" />
          ) : (
            <Mic color="#FFFFFF" size={32} />
          )}
        </Pressable>
        <Text style={styles.recorderStatus}>
          {isUploading
            ? "Saving…"
            : isRecording
              ? `Recording… ${formatDuration(elapsed)}`
              : "Tap to record a voice note"}
        </Text>
        {isRecording ? <View style={styles.recDot} /> : null}
        {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      </View>

      {artifactsQuery.isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : (
        <FlatList
          data={artifacts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const pill = stateToPill(item.state);
            return (
              <Pressable
                style={({ pressed }) => [
                  styles.noteRow,
                  pressed && styles.noteRowPressed,
                ]}
                onPress={() => router.push(`/note/${item.id}`)}
                testID={`note-${item.id}`}
              >
                <View style={styles.noteRowText}>
                  <Text style={styles.noteTime}>
                    {relativeTime(item.created_at)}
                  </Text>
                  {item.transcript ? (
                    <Text style={styles.notePreview} numberOfLines={1}>
                      {item.transcript}
                    </Text>
                  ) : null}
                </View>
                <View style={[styles.pill, { borderColor: pill.color }]}>
                  {pill.spinner ? (
                    <ActivityIndicator color={pill.color} size="small" />
                  ) : null}
                  <Text style={[styles.pillText, { color: pill.color }]}>
                    {pill.label}
                  </Text>
                </View>
              </Pressable>
            );
          }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                No voice notes yet — record your first one above.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  recorderCard: {
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 24,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
    gap: 12,
  },
  micButton: {
    width: 84,
    height: 84,
    borderRadius: 42,
    backgroundColor: Theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  micButtonActive: { backgroundColor: Theme.coral },
  micButtonPressed: { opacity: 0.85 },
  recorderStatus: { fontSize: 15, color: Theme.textMuted },
  recDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Theme.coral,
  },
  errorText: { fontSize: 14, color: Theme.coral, textAlign: "center" },
  loader: { marginTop: 40 },
  listContent: { padding: 20, gap: 12, flexGrow: 1 },
  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: 16,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  noteRowPressed: { backgroundColor: Theme.border },
  noteRowText: { flex: 1, gap: 4 },
  noteTime: { fontSize: 14, fontWeight: "600", color: Theme.text },
  notePreview: { fontSize: 13, color: Theme.textMuted },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  pillText: { fontSize: 12, fontWeight: "600" },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 60,
    paddingHorizontal: 32,
  },
  emptyText: { fontSize: 15, color: Theme.textMuted, textAlign: "center" },
});
