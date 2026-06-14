import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { ChevronDown, ChevronUp } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

type ArtifactRow = {
  id: string;
  room_id: string;
  state: string;
  transcript: string | null;
  ai_draft: string | null;
  edited_text: string | null;
  approved_text: string | null;
};

const POLLING_STATES = new Set(["recorded"]);

async function fetchArtifact(artifactId: string): Promise<ArtifactRow> {
  const { data, error } = await supabase
    .from("ai_artifacts")
    .select(
      "id, room_id, state, transcript, ai_draft, edited_text, approved_text",
    )
    .eq("id", artifactId)
    .single();
  if (error) {
    throw error;
  }
  return data as ArtifactRow;
}

export default function NoteReviewScreen() {
  const { artifactId } = useLocalSearchParams<{ artifactId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [editedText, setEditedText] = useState<string>("");
  const [didInitDraft, setDidInitDraft] = useState<boolean>(false);
  const [showOriginal, setShowOriginal] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const artifactQuery = useQuery({
    queryKey: ["artifact", artifactId],
    queryFn: () => fetchArtifact(artifactId),
    enabled: !!artifactId,
  });

  const artifact = artifactQuery.data;
  const state = artifact?.state;

  // Poll while transcribing.
  useEffect(() => {
    if (!state || !POLLING_STATES.has(state)) {
      return;
    }
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ["artifact", artifactId] });
    }, 4000);
    return () => clearInterval(interval);
  }, [state, queryClient, artifactId]);

  // Pre-fill the editable field once a draft (or prior edit) is available.
  useEffect(() => {
    if (didInitDraft || !artifact) {
      return;
    }
    if (state === "drafted" || state === "under_review") {
      setEditedText(artifact.edited_text ?? artifact.ai_draft ?? "");
      setDidInitDraft(true);
    }
  }, [artifact, state, didInitDraft]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["artifact", artifactId] });
  }, [queryClient, artifactId]);

  const generateDraft = useMutation({
    mutationFn: async (): Promise<void> => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        throw new Error("No active session.");
      }
      const res = await fetch(
        `${process.env.EXPO_PUBLIC_BACKEND_URL}/structure?artifact_id=${artifactId}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      if (!res.ok) {
        if (res.status === 409) {
          throw new Error("Not ready yet — still transcribing.");
        }
        if (res.status === 403) {
          throw new Error("You don't have access to this note.");
        }
        throw new Error("Could not generate the draft. Please try again.");
      }
    },
    onMutate: () => setErrorText(null),
    onSuccess: invalidate,
    onError: (e: Error) => setErrorText(e.message),
  });

  // Ensure the artifact is in `under_review` before posting/approving.
  const ensureUnderReview = useCallback(async (): Promise<void> => {
    if (state === "under_review") {
      return;
    }
    const { error } = await supabase.rpc("begin_review", {
      p_artifact_id: artifactId,
    });
    if (error) {
      throw error;
    }
  }, [state, artifactId]);

  const postToThread = useMutation({
    mutationFn: async (): Promise<string> => {
      await ensureUnderReview();
      const { error } = await supabase.rpc("post_artifact", {
        p_artifact_id: artifactId,
        p_text: editedText,
      });
      if (error) {
        throw error;
      }
      return artifact?.room_id ?? "";
    },
    onMutate: () => setErrorText(null),
    onSuccess: (roomId) => {
      invalidate();
      if (roomId) {
        router.replace(`/rooms/${roomId}`);
      } else {
        router.back();
      }
    },
    onError: (e: Error) =>
      setErrorText(e.message ?? "Could not post to the thread."),
  });

  const saveAsNote = useMutation({
    mutationFn: async (): Promise<void> => {
      await ensureUnderReview();
      const { error } = await supabase.rpc("approve_artifact", {
        p_artifact_id: artifactId,
        p_text: editedText,
      });
      if (error) {
        throw error;
      }
    },
    onMutate: () => setErrorText(null),
    onSuccess: () => {
      invalidate();
      router.back();
    },
    onError: (e: Error) =>
      setErrorText(e.message ?? "Could not save the note."),
  });

  const discard = useMutation({
    mutationFn: async (): Promise<void> => {
      const { error } = await supabase.rpc("discard_artifact", {
        p_artifact_id: artifactId,
      });
      if (error) {
        throw error;
      }
    },
    onMutate: () => setErrorText(null),
    onSuccess: () => {
      invalidate();
      router.back();
    },
    onError: (e: Error) => setErrorText(e.message ?? "Could not discard."),
  });

  const isBusy =
    postToThread.isPending || saveAsNote.isPending || discard.isPending;

  const finalText = useMemo(() => {
    if (!artifact) {
      return "";
    }
    return (
      artifact.approved_text ??
      artifact.edited_text ??
      artifact.ai_draft ??
      artifact.transcript ??
      ""
    );
  }, [artifact]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen
        options={{ title: "Review note", headerBackTitle: "Notes" }}
      />

      {artifactQuery.isLoading || !artifact ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : (
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 24 },
          ]}
          keyboardShouldPersistTaps="handled"
        >
          {/* recorded → transcribing */}
          {state === "recorded" ? (
            <View style={styles.centered}>
              <ActivityIndicator color={Theme.primary} />
              <Text style={styles.waitingText}>Transcribing…</Text>
              <Text style={styles.waitingHint}>
                This usually takes under a minute.
              </Text>
            </View>
          ) : null}

          {/* transcribed → raw transcript + generate draft */}
          {state === "transcribed" ? (
            <View style={styles.section}>
              <Text style={styles.label}>Transcript</Text>
              <View style={styles.readBlock}>
                <Text style={styles.readText}>
                  {artifact.transcript ?? "No transcript available."}
                </Text>
              </View>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (generateDraft.isPending || pressed) && styles.btnPressed,
                ]}
                onPress={() => generateDraft.mutate()}
                disabled={generateDraft.isPending}
                testID="generate-draft-button"
              >
                {generateDraft.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryBtnText}>Generate draft</Text>
                )}
              </Pressable>
            </View>
          ) : null}

          {/* drafted / under_review → editable draft + actions */}
          {state === "drafted" || state === "under_review" ? (
            <View style={styles.section}>
              <Text style={styles.label}>Draft note</Text>
              <TextInput
                style={styles.editor}
                value={editedText}
                onChangeText={setEditedText}
                multiline
                placeholder="Edit the draft before sending…"
                placeholderTextColor={Theme.textMuted}
                testID="draft-input"
              />

              <Pressable
                style={styles.disclosure}
                onPress={() => setShowOriginal((s) => !s)}
                testID="toggle-original"
              >
                <Text style={styles.disclosureText}>
                  {showOriginal ? "Hide original" : "Show original"}
                </Text>
                {showOriginal ? (
                  <ChevronUp color={Theme.textMuted} size={18} />
                ) : (
                  <ChevronDown color={Theme.textMuted} size={18} />
                )}
              </Pressable>
              {showOriginal ? (
                <View style={styles.readBlock}>
                  <Text style={styles.readText}>
                    {artifact.transcript ?? "No transcript available."}
                  </Text>
                </View>
              ) : null}

              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (isBusy || pressed) && styles.btnPressed,
                ]}
                onPress={() => saveAsNote.mutate()}
                disabled={isBusy}
                testID="save-note-button"
              >
                {saveAsNote.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryBtnText}>Save as note</Text>
                )}
              </Pressable>

              <Pressable
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  (isBusy || pressed) && styles.btnPressed,
                ]}
                onPress={() => postToThread.mutate()}
                disabled={isBusy}
                testID="post-thread-button"
              >
                {postToThread.isPending ? (
                  <ActivityIndicator color={Theme.primary} />
                ) : (
                  <Text style={styles.secondaryBtnText}>Post to thread</Text>
                )}
              </Pressable>

              <Pressable
                style={styles.discardBtn}
                onPress={() => discard.mutate()}
                disabled={isBusy}
                testID="discard-button"
              >
                <Text style={styles.discardText}>Discard</Text>
              </Pressable>
            </View>
          ) : null}

          {/* posted / approved → read-only final */}
          {state === "posted" || state === "approved" ? (
            <View style={styles.section}>
              <Text style={styles.label}>Note</Text>
              <View style={styles.readBlock}>
                <Text style={styles.readText}>{finalText}</Text>
              </View>
              <Text style={styles.caption}>This note is final.</Text>
            </View>
          ) : null}

          {/* discarded */}
          {state === "discarded" ? (
            <View style={styles.centered}>
              <Text style={styles.waitingText}>This note was discarded.</Text>
            </View>
          ) : null}

          {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  loader: { marginTop: 60 },
  content: { padding: 20, gap: 16 },
  section: { gap: 12 },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 80,
    gap: 10,
  },
  waitingText: { fontSize: 16, color: Theme.text, fontWeight: "600" },
  waitingHint: { fontSize: 14, color: Theme.textMuted },
  label: { fontSize: 14, fontWeight: "600", color: Theme.textMuted },
  readBlock: {
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 16,
  },
  readText: { fontSize: 16, color: Theme.text, lineHeight: 23 },
  editor: {
    minHeight: 160,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 16,
    fontSize: 16,
    color: Theme.text,
    lineHeight: 23,
    textAlignVertical: "top",
  },
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  disclosureText: { fontSize: 14, color: Theme.textMuted, fontWeight: "500" },
  primaryBtn: {
    backgroundColor: Theme.primary,
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { fontSize: 16, fontWeight: "600", color: "#FFFFFF" },
  secondaryBtn: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Theme.primary,
    backgroundColor: Theme.background,
  },
  secondaryBtnText: { fontSize: 16, fontWeight: "600", color: Theme.primary },
  discardBtn: { paddingVertical: 12, alignItems: "center" },
  discardText: { fontSize: 15, color: Theme.coral, fontWeight: "500" },
  btnPressed: { opacity: 0.8 },
  caption: { fontSize: 13, color: Theme.textMuted, fontStyle: "italic" },
  errorText: { fontSize: 14, color: Theme.coral, textAlign: "center" },
});
