import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
  UserCircle2,
  X,
} from "lucide-react-native";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
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

type MinutesArtifact = {
  id: string;
  state: string;
  ai_draft: string | null;
  edited_text: string | null;
  approved_text: string | null;
  ai_engine_version: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
};

type Decision = { seq: number; text: string };

type ActionItem = {
  id: string;
  seq: number;
  text: string;
  owner_hint: string | null;
  due_hint: string | null;
  status: string;
  kind: string;
  owner_member_id: string | null;
  promoted_at: string | null;
};

type MinutesResponse = {
  minutes: MinutesArtifact | null;
  decisions: Decision[];
  action_items: ActionItem[];
  suggested_action_items: ActionItem[];
};

type Segment = {
  id: string;
  seq: number;
  speaker_label: string | null;
  speaker_member_id: string | null;
  start_ms: number | null;
  end_ms: number | null;
  text: string | null;
  confidence: number | null;
};

type TranscriptResponse = {
  transcript_id: string;
  segments: Segment[];
};

type Member = { id: string; full_name: string | null };

type ItemStatus = "open" | "done" | "cancelled";

function backendBase(): string {
  const baseUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (!baseUrl) {
    throw new Error("Backend URL is not configured.");
  }
  return baseUrl.replace(/\/$/, "");
}

async function authHeader(): Promise<{ Authorization: string }> {
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    throw new Error("You are not signed in.");
  }
  return { Authorization: `Bearer ${accessToken}` };
}

class ForbiddenError extends Error {
  constructor() {
    super("forbidden");
    this.name = "ForbiddenError";
  }
}

async function apiPost(
  path: string,
  body?: Record<string, unknown>,
): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(`${backendBase()}${path}`, {
    method: "POST",
    headers: body
      ? { ...headers, "Content-Type": "application/json" }
      : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (!res.ok) {
    throw new Error(`Request failed (status ${res.status}).`);
  }
}

async function fetchMinutes(recordingId: string): Promise<MinutesResponse> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/minutes?recording_id=${encodeURIComponent(recordingId)}`,
    { method: "GET", headers },
  );
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (res.status === 404) {
    return { minutes: null, decisions: [], action_items: [], suggested_action_items: [] };
  }
  if (!res.ok) {
    throw new Error(`Could not load minutes (status ${res.status}).`);
  }
  return (await res.json()) as MinutesResponse;
}

async function fetchTranscript(
  recordingId: string,
): Promise<TranscriptResponse> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/transcript?recording_id=${encodeURIComponent(recordingId)}`,
    { method: "GET", headers },
  );
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (res.status === 404) {
    return { transcript_id: "", segments: [] };
  }
  if (!res.ok) {
    throw new Error(`Could not load transcript (status ${res.status}).`);
  }
  return (await res.json()) as TranscriptResponse;
}

async function fetchRoomMembers(roomId: string): Promise<Member[]> {
  const { data, error } = await supabase
    .from("room_members")
    .select("member_id, member:members!member_id(full_name)")
    .eq("room_id", roomId);
  if (error) {
    throw error;
  }
  return ((data ?? []) as unknown as {
    member_id: string | null;
    member: { full_name: string | null } | null;
  }[])
    .filter((r) => !!r.member_id)
    .map((r) => ({ id: r.member_id as string, full_name: r.member?.full_name ?? null }));
}

function formatSigned(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

type ChipInfo = { label: string; color: string };

function stateChip(state: string | undefined): ChipInfo {
  switch (state) {
    case "approved":
      return { label: "Signed", color: Theme.primary };
    case "under_review":
      return { label: "In review", color: Theme.blue };
    case "drafted":
    default:
      return { label: "Draft", color: Theme.coral };
  }
}

type PickerTarget =
  | { kind: "owner"; actionItemId: string }
  | { kind: "speaker"; segmentId: string };

export default function ReviewMinutesScreen() {
  const { recordingId, roomId } = useLocalSearchParams<{
    recordingId: string;
    roomId?: string;
  }>();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const [draftText, setDraftText] = useState<string>("");
  const [didInitDraft, setDidInitDraft] = useState<boolean>(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [speakersOpen, setSpeakersOpen] = useState<boolean>(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const reviewMarkedRef = useRef<boolean>(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const minutesQuery = useQuery({
    queryKey: ["review-minutes", recordingId],
    queryFn: () => fetchMinutes(recordingId),
    enabled: !!recordingId,
  });
  const transcriptQuery = useQuery({
    queryKey: ["review-transcript", recordingId],
    queryFn: () => fetchTranscript(recordingId),
    enabled: !!recordingId,
  });
  const membersQuery = useQuery({
    queryKey: ["review-members", roomId],
    queryFn: () => fetchRoomMembers(roomId as string),
    enabled: !!roomId,
  });

  const minutes = minutesQuery.data?.minutes ?? null;
  const state = minutes?.state;
  const isApproved = state === "approved";
  const isForbidden =
    minutesQuery.error instanceof ForbiddenError ||
    transcriptQuery.error instanceof ForbiddenError;

  const members = useMemo(() => membersQuery.data ?? [], [membersQuery.data]);
  const memberName = useCallback(
    (id: string | null | undefined): string | null => {
      if (!id) {
        return null;
      }
      return members.find((m) => m.id === id)?.full_name ?? null;
    },
    [members],
  );

  const showFlash = useCallback((msg: string) => {
    setFlash(msg);
    if (flashTimer.current) {
      clearTimeout(flashTimer.current);
    }
    flashTimer.current = setTimeout(() => setFlash(null), 2200);
  }, []);

  useEffect(() => {
    return () => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    };
  }, []);

  // Pre-fill the editable field once minutes are loaded.
  useEffect(() => {
    if (didInitDraft || !minutes) {
      return;
    }
    setDraftText(minutes.edited_text ?? minutes.ai_draft ?? "");
    setDidInitDraft(true);
  }, [minutes, didInitDraft]);

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["review-minutes", recordingId] });
    queryClient.invalidateQueries({
      queryKey: ["review-transcript", recordingId],
    });
  }, [queryClient, recordingId]);

  // Auto-mark in review (best-effort) when opening a drafted artifact.
  useEffect(() => {
    if (!minutes || reviewMarkedRef.current) {
      return;
    }
    if (minutes.state === "drafted") {
      reviewMarkedRef.current = true;
      apiPost(`/rtc/minutes/review?artifact_id=${encodeURIComponent(minutes.id)}`)
        .then(() => invalidate())
        .catch(() => {
          // best-effort only
        });
    }
  }, [minutes, invalidate]);

  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof ForbiddenError) {
        Alert.alert("No access", "You don't have access to this recording.");
        return;
      }
      console.error("Review write failed:", e);
      showFlash("Couldn't save — try again");
    },
    [showFlash],
  );

  const saveDraft = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!minutes) {
        return;
      }
      await apiPost(
        `/rtc/minutes/edit?artifact_id=${encodeURIComponent(minutes.id)}`,
        { text: draftText },
      );
    },
    onSuccess: () => {
      showFlash("Saved");
      invalidate();
    },
    onError: handleError,
  });

  const signMinutes = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!minutes) {
        return;
      }
      await apiPost(
        `/rtc/minutes/approve?artifact_id=${encodeURIComponent(minutes.id)}`,
        { text: draftText },
      );
    },
    onSuccess: () => {
      showFlash("Signed");
      invalidate();
    },
    onError: handleError,
  });

  const setStatus = useMutation({
    mutationFn: async (vars: {
      id: string;
      status: ItemStatus;
    }): Promise<void> => {
      await apiPost(
        `/rtc/action-item/status?action_item_id=${encodeURIComponent(vars.id)}&status=${vars.status}`,
      );
    },
    onSuccess: invalidate,
    onError: handleError,
  });

  const promoteItem = useMutation({
    mutationFn: async (id: string): Promise<void> => {
      await apiPost(
        `/rtc/action-item/promote?action_item_id=${encodeURIComponent(id)}`,
      );
    },
    onSuccess: invalidate,
    onError: handleError,
  });

  const setOwner = useMutation({
    mutationFn: async (vars: {
      id: string;
      memberId: string | null;
    }): Promise<void> => {
      const param = vars.memberId
        ? `&owner_member_id=${encodeURIComponent(vars.memberId)}`
        : "";
      await apiPost(
        `/rtc/action-item/owner?action_item_id=${encodeURIComponent(vars.id)}${param}`,
      );
    },
    onSuccess: invalidate,
    onError: handleError,
  });

  const setSpeaker = useMutation({
    mutationFn: async (vars: {
      segmentId: string;
      memberId: string | null;
      label: string | null;
    }): Promise<void> => {
      const m = vars.memberId
        ? `&speaker_member_id=${encodeURIComponent(vars.memberId)}`
        : "&speaker_member_id=";
      const l = vars.label
        ? `&speaker_label=${encodeURIComponent(vars.label)}`
        : "&speaker_label=";
      await apiPost(
        `/rtc/segment-speaker?segment_id=${encodeURIComponent(vars.segmentId)}${m}${l}`,
      );
    },
    onSuccess: invalidate,
    onError: handleError,
  });

  const onPickMember = useCallback(
    (member: Member | null) => {
      if (!picker) {
        return;
      }
      if (picker.kind === "owner") {
        setOwner.mutate({ id: picker.actionItemId, memberId: member?.id ?? null });
      } else {
        setSpeaker.mutate({
          segmentId: picker.segmentId,
          memberId: member?.id ?? null,
          label: member?.full_name ?? null,
        });
      }
      setPicker(null);
    },
    [picker, setOwner, setSpeaker],
  );

  const confirmSign = useCallback(() => {
    Alert.alert(
      "Sign minutes",
      "Signing finalizes these minutes and records you as the signer. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign",
          style: "default",
          onPress: () => signMinutes.mutate(),
        },
      ],
    );
  }, [signMinutes]);

  const decisions = minutesQuery.data?.decisions ?? [];
  const actionItems = minutesQuery.data?.action_items ?? [];
  const suggested = minutesQuery.data?.suggested_action_items ?? [];
  const segments = transcriptQuery.data?.segments ?? [];
  const chip = stateChip(state);
  const signerName = memberName(minutes?.resolved_by);
  const saving = saveDraft.isPending || signMinutes.isPending;

  if (isForbidden) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Meeting minutes" }} />
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No access</Text>
          <Text style={styles.emptyBody}>
            You don&apos;t have access to this recording.
          </Text>
        </View>
      </View>
    );
  }

  if (minutesQuery.isLoading || transcriptQuery.isLoading) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Meeting minutes" }} />
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      </View>
    );
  }

  if (!minutes) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Meeting minutes" }} />
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No minutes yet</Text>
          <Text style={styles.emptyBody}>
            No minutes yet for this recording.
          </Text>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen
        options={{ title: "Meeting minutes", headerBackTitle: "Back" }}
      />

      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + 32 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.headerRow}>
          <Text style={styles.title}>Meeting minutes</Text>
          <View style={[styles.chip, { borderColor: chip.color }]}>
            <Text style={[styles.chipText, { color: chip.color }]}>
              {chip.label}
            </Text>
          </View>
        </View>
        {isApproved ? (
          <Text style={styles.signedLine}>
            {signerName ? `Signed by ${signerName}` : "Signed"}
            {minutes.resolved_at ? ` · ${formatSigned(minutes.resolved_at)}` : ""}
          </Text>
        ) : null}

        {/* 1. Minutes */}
        <View style={styles.section}>
          {!isApproved ? (
            <View style={styles.aiBadge}>
              <Sparkles color={Theme.coral} size={15} />
              <Text style={styles.aiBadgeText}>
                AI draft — review before signing
              </Text>
            </View>
          ) : null}

          {isApproved ? (
            <View style={styles.readBlock}>
              <Text style={styles.readText}>
                {minutes.approved_text ?? draftText}
              </Text>
            </View>
          ) : (
            <TextInput
              style={styles.editor}
              value={draftText}
              onChangeText={setDraftText}
              multiline
              placeholder="Review the minutes before signing…"
              placeholderTextColor={Theme.textMuted}
              testID="minutes-editor"
            />
          )}

          {!isApproved ? (
            <View style={styles.minutesActions}>
              <Pressable
                style={({ pressed }) => [
                  styles.secondaryBtn,
                  (saving || pressed) && styles.btnPressed,
                ]}
                onPress={() => saveDraft.mutate()}
                disabled={saving}
                testID="save-draft"
              >
                {saveDraft.isPending ? (
                  <ActivityIndicator color={Theme.primary} />
                ) : (
                  <Text style={styles.secondaryBtnText}>Save draft</Text>
                )}
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.primaryBtn,
                  (saving || pressed) && styles.btnPressed,
                ]}
                onPress={confirmSign}
                disabled={saving}
                testID="sign-minutes"
              >
                {signMinutes.isPending ? (
                  <ActivityIndicator color="#FFFFFF" />
                ) : (
                  <Text style={styles.primaryBtnText}>Sign minutes</Text>
                )}
              </Pressable>
            </View>
          ) : null}
        </View>

        {/* 2. Decisions */}
        {decisions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionHeader}>Decisions</Text>
            {decisions.map((d) => (
              <View key={`decision-${d.seq}`} style={styles.decisionCard}>
                <View style={styles.bullet} />
                <Text style={styles.decisionText}>{d.text}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* 3. Action items */}
        <View style={styles.section}>
          <Text style={styles.sectionHeader}>Action items</Text>
          {actionItems.length === 0 ? (
            <Text style={styles.mutedNote}>No action items.</Text>
          ) : (
            actionItems.map((item) => {
              const ownerName = memberName(item.owner_member_id);
              const done = item.status === "done";
              const cancelled = item.status === "cancelled";
              return (
                <View
                  key={item.id}
                  style={[styles.itemCard, cancelled && styles.itemDimmed]}
                >
                  <Text
                    style={[
                      styles.itemText,
                      done && styles.itemTextDone,
                    ]}
                  >
                    {item.text}
                  </Text>

                  <View style={styles.itemMetaRow}>
                    {ownerName ? (
                      <View style={styles.ownerPill}>
                        <UserCircle2 color={Theme.primary} size={14} />
                        <Text style={styles.ownerPillText}>{ownerName}</Text>
                      </View>
                    ) : (
                      <Pressable
                        style={styles.assignBtn}
                        onPress={() =>
                          setPicker({ kind: "owner", actionItemId: item.id })
                        }
                        testID={`assign-owner-${item.id}`}
                      >
                        <Text style={styles.assignHint}>
                          {item.owner_hint ?? "No owner"}
                        </Text>
                        <Text style={styles.assignAction}>Assign</Text>
                      </Pressable>
                    )}
                    {item.due_hint ? (
                      <Text style={styles.dueText}>{item.due_hint}</Text>
                    ) : null}
                  </View>

                  {ownerName ? (
                    <Pressable
                      style={styles.reassign}
                      onPress={() =>
                        setPicker({ kind: "owner", actionItemId: item.id })
                      }
                    >
                      <Text style={styles.reassignText}>Change owner</Text>
                    </Pressable>
                  ) : null}

                  <View style={styles.statusRow}>
                    {(["open", "done", "cancelled"] as ItemStatus[]).map((s) => {
                      const active = item.status === s;
                      return (
                        <Pressable
                          key={s}
                          style={[
                            styles.statusChip,
                            active && styles.statusChipActive,
                          ]}
                          onPress={() =>
                            setStatus.mutate({ id: item.id, status: s })
                          }
                          testID={`status-${s}-${item.id}`}
                        >
                          <Text
                            style={[
                              styles.statusChipText,
                              active && styles.statusChipTextActive,
                            ]}
                          >
                            {s === "open"
                              ? "Open"
                              : s === "done"
                                ? "Done"
                                : "Cancelled"}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })
          )}

          {/* Suggested by AI */}
          {suggested.length > 0 ? (
            <View style={styles.suggestedGroup}>
              <Text style={styles.suggestedHeader}>
                Suggested by AI — confirm to add
              </Text>
              <Text style={styles.suggestedNote}>
                These were inferred from the discussion, not explicitly agreed.
                Confirm only what&apos;s correct.
              </Text>
              {suggested.map((item) => (
                <View key={item.id} style={styles.suggestedCard}>
                  <View style={styles.suggestedTag}>
                    <Sparkles color={Theme.coral} size={12} />
                    <Text style={styles.suggestedTagText}>Suggested</Text>
                  </View>
                  <Text style={styles.itemText}>{item.text}</Text>
                  {item.owner_hint ? (
                    <Text style={styles.assignHint}>{item.owner_hint}</Text>
                  ) : null}
                  <View style={styles.suggestedActions}>
                    <Pressable
                      style={({ pressed }) => [
                        styles.confirmBtn,
                        pressed && styles.btnPressed,
                      ]}
                      onPress={() => promoteItem.mutate(item.id)}
                      testID={`confirm-${item.id}`}
                    >
                      <Check color="#FFFFFF" size={15} />
                      <Text style={styles.confirmBtnText}>Confirm</Text>
                    </Pressable>
                    <Pressable
                      style={({ pressed }) => [
                        styles.dismissBtn,
                        pressed && styles.btnPressed,
                      ]}
                      onPress={() =>
                        setStatus.mutate({ id: item.id, status: "cancelled" })
                      }
                      testID={`dismiss-${item.id}`}
                    >
                      <Text style={styles.dismissBtnText}>Dismiss</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
            </View>
          ) : null}
        </View>

        {/* 4. Speakers */}
        {segments.length > 0 ? (
          <View style={styles.section}>
            <Pressable
              style={styles.disclosure}
              onPress={() => setSpeakersOpen((s) => !s)}
              testID="toggle-speakers"
            >
              <Text style={styles.sectionHeader}>
                Review speakers ({segments.length} segments)
              </Text>
              {speakersOpen ? (
                <ChevronUp color={Theme.textMuted} size={20} />
              ) : (
                <ChevronDown color={Theme.textMuted} size={20} />
              )}
            </Pressable>
            {speakersOpen ? (
              <>
                <Text style={styles.helperText}>
                  Confirmed automatically from each participant&apos;s audio —
                  change only if wrong.
                </Text>
                {segments.map((seg) => {
                  const resolved = memberName(seg.speaker_member_id);
                  return (
                    <View key={seg.id} style={styles.segmentCard}>
                      <View style={styles.segmentHead}>
                        <Text style={styles.speakerLabel}>
                          {resolved ?? seg.speaker_label ?? "Unknown"}
                        </Text>
                        <Pressable
                          onPress={() =>
                            setPicker({ kind: "speaker", segmentId: seg.id })
                          }
                          hitSlop={8}
                          testID={`change-speaker-${seg.id}`}
                        >
                          <Text style={styles.changeText}>Change</Text>
                        </Pressable>
                      </View>
                      <Text style={styles.segmentText}>{seg.text}</Text>
                    </View>
                  );
                })}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>

      {flash ? (
        <View
          style={[styles.flash, { bottom: insets.bottom + 16 }]}
          pointerEvents="none"
        >
          <Text style={styles.flashText}>{flash}</Text>
        </View>
      ) : null}

      {/* Member picker */}
      <Modal
        visible={picker !== null}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setPicker(null)}
      >
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>
              {picker?.kind === "owner" ? "Assign owner" : "Change speaker"}
            </Text>
            <Pressable onPress={() => setPicker(null)} hitSlop={12}>
              <X color={Theme.textMuted} size={24} />
            </Pressable>
          </View>
          {membersQuery.isLoading ? (
            <ActivityIndicator color={Theme.primary} style={styles.loader} />
          ) : (
            <ScrollView contentContainerStyle={styles.pickerList}>
              <Pressable
                style={({ pressed }) => [
                  styles.pickerRow,
                  pressed && styles.pickerRowPressed,
                ]}
                onPress={() => onPickMember(null)}
                testID="picker-unassigned"
              >
                <Text style={styles.pickerMuted}>
                  {picker?.kind === "owner" ? "Clear owner" : "Mark unknown"}
                </Text>
              </Pressable>
              {members.map((m) => (
                <Pressable
                  key={m.id}
                  style={({ pressed }) => [
                    styles.pickerRow,
                    pressed && styles.pickerRowPressed,
                  ]}
                  onPress={() => onPickMember(m)}
                  testID={`picker-${m.id}`}
                >
                  <UserCircle2 color={Theme.primary} size={20} />
                  <Text style={styles.pickerName}>
                    {m.full_name ?? "Unknown member"}
                  </Text>
                </Pressable>
              ))}
              {members.length === 0 ? (
                <Text style={styles.mutedNote}>No members found.</Text>
              ) : null}
            </ScrollView>
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  loader: { marginTop: 60 },
  content: { padding: 20, gap: 20 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: Theme.text },
  emptyBody: { fontSize: 15, color: Theme.textMuted, textAlign: "center" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 26, fontWeight: "700", color: Theme.text },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1.5,
  },
  chipText: { fontSize: 13, fontWeight: "700" },
  signedLine: { fontSize: 14, color: Theme.textMuted, marginTop: -12 },
  section: { gap: 12 },
  sectionHeader: { fontSize: 18, fontWeight: "700", color: Theme.text },
  aiBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  aiBadgeText: { fontSize: 14, fontWeight: "600", color: Theme.coral },
  editor: {
    minHeight: 180,
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
  readBlock: {
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 16,
  },
  readText: { fontSize: 16, color: Theme.text, lineHeight: 23 },
  minutesActions: { flexDirection: "row", gap: 12 },
  primaryBtn: {
    flex: 1,
    backgroundColor: Theme.primary,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { fontSize: 16, fontWeight: "600", color: "#FFFFFF" },
  secondaryBtn: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Theme.primary,
    backgroundColor: Theme.background,
  },
  secondaryBtnText: { fontSize: 16, fontWeight: "600", color: Theme.primary },
  btnPressed: { opacity: 0.8 },
  decisionCard: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 14,
  },
  bullet: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: Theme.primary,
    marginTop: 7,
  },
  decisionText: { flex: 1, fontSize: 15, color: Theme.text, lineHeight: 22 },
  mutedNote: { fontSize: 14, color: Theme.textMuted },
  itemCard: {
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 14,
    gap: 10,
  },
  itemDimmed: { opacity: 0.55 },
  itemText: { fontSize: 15, color: Theme.text, lineHeight: 22 },
  itemTextDone: { textDecorationLine: "line-through", color: Theme.textMuted },
  itemMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  ownerPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#0F6E5615",
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
  },
  ownerPillText: { fontSize: 13, fontWeight: "600", color: Theme.primary },
  assignBtn: { flexDirection: "row", alignItems: "center", gap: 8 },
  assignHint: { fontSize: 13, color: Theme.textMuted, fontStyle: "italic" },
  assignAction: { fontSize: 13, fontWeight: "600", color: Theme.blue },
  dueText: { fontSize: 13, color: Theme.textMuted },
  reassign: { alignSelf: "flex-start" },
  reassignText: { fontSize: 13, color: Theme.blue, fontWeight: "500" },
  statusRow: { flexDirection: "row", gap: 8 },
  statusChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.border,
    backgroundColor: Theme.background,
  },
  statusChipActive: {
    borderColor: Theme.primary,
    backgroundColor: Theme.primary,
  },
  statusChipText: { fontSize: 13, fontWeight: "600", color: Theme.textMuted },
  statusChipTextActive: { color: "#FFFFFF" },
  suggestedGroup: { gap: 10, marginTop: 6 },
  suggestedHeader: { fontSize: 15, fontWeight: "700", color: Theme.coral },
  suggestedNote: { fontSize: 13, color: Theme.textMuted, lineHeight: 19 },
  suggestedCard: {
    backgroundColor: "#F08A6E12",
    borderRadius: 12,
    borderLeftWidth: 3,
    borderLeftColor: Theme.coral,
    padding: 14,
    gap: 10,
  },
  suggestedTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
  },
  suggestedTagText: {
    fontSize: 11,
    fontWeight: "700",
    color: Theme.coral,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  suggestedActions: { flexDirection: "row", gap: 10 },
  confirmBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: Theme.primary,
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  confirmBtnText: { fontSize: 14, fontWeight: "600", color: "#FFFFFF" },
  dismissBtn: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  dismissBtnText: { fontSize: 14, fontWeight: "600", color: Theme.textMuted },
  disclosure: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  helperText: { fontSize: 13, color: Theme.textMuted, lineHeight: 19 },
  segmentCard: {
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 14,
    gap: 6,
  },
  segmentHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  speakerLabel: { fontSize: 14, fontWeight: "700", color: Theme.text },
  changeText: { fontSize: 13, fontWeight: "600", color: Theme.blue },
  segmentText: { fontSize: 15, color: Theme.text, lineHeight: 22 },
  flash: {
    position: "absolute",
    alignSelf: "center",
    backgroundColor: Theme.text,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
  },
  flashText: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
  sheet: { flex: 1, backgroundColor: Theme.background, padding: 24 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  sheetTitle: { fontSize: 22, fontWeight: "700", color: Theme.text },
  pickerList: { gap: 10, paddingBottom: 40 },
  pickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  pickerRowPressed: { backgroundColor: Theme.border },
  pickerName: { fontSize: 16, color: Theme.text },
  pickerMuted: { fontSize: 15, color: Theme.textMuted, fontWeight: "500" },
});
