import { File } from 'expo-file-system';
import { decode } from 'base64-arraybuffer';
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Audio } from "expo-av";
import { randomUUID } from "expo-crypto";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Mic, Square, FileText, SlidersHorizontal, Check, Star, UserCheck, Eye, Inbox } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";
import { listTemplates } from "@/lib/typedNotes";
import { fetchMyStarredIds, starNote, unstarNote } from "@/lib/stars";
import { fetchNotesLastSeen, markNotesSeen } from "@/lib/notesSeen";
import { fetchRoomTeammates, requestReview, fetchRoomReviewRequests, type RoomTeammate, type ReviewRequest } from "@/lib/reviews";
import { getCurrentMemberId } from "@/lib/member";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

type ArtifactRow = {
  id: string;
  state: string;
  transcript: string | null;
  created_at: string;
  artifact_type: string | null;
  template_key: string | null;
  created_by: string | null;
  author: { discipline: string | null } | null;
};

const TERMINAL_STATES = new Set(["posted", "approved", "discarded"]);
const WAITING_ON_CLINICIAN = new Set(["transcribed", "drafted", "under_review"]);
const NEEDS_REVIEW = new Set(["transcribed", "drafted", "under_review"]);
const DONE = new Set(["posted", "approved"]);
const PROCESSING = new Set(["recorded"]);

const DISCIPLINE_LABEL: Record<string, string> = {
  doctor: "Doctor",
  pt: "Physiotherapist",
  ot: "Occupational therapist",
  st: "Speech therapist",
  nurse: "Nurse",
  psych: "Psychologist",
  sw: "Social worker",
  dietitian: "Dietitian",
  coordinator: "Coordinator",
  admin_staff: "Admin",



};

const CODE_PREFIX_TO_ROLE: Record<string, string> = {
  ST: "st", PT: "pt", OT: "ot", NUR: "nurse", MED: "doctor",
  RX: "doctor", TCM: "doctor", DENT: "doctor",
  DIET: "dietitian", PSY: "psych", SW: "sw", CM: "coordinator",
  RESP: "pt", AUD: "st", ORTH: "st", PO: "pt", POD: "pt",
  EOL: "doctor", CLEFT: "st", GEN: "coordinator",
};

type TypeFilter = "all" | "voice" | "typed";
type Sort = "newest" | "oldest";

type Pill = { label: string; color: string; spinner?: boolean };

function stateToPill(state: string): Pill {
  switch (state) {
    case "recorded":
      return { label: "Transcribing...", color: Theme.primary, spinner: true };
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
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString();
}

function dateBucket(iso: string): "Today" | "This week" | "Earlier" {
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (startToday.getDay() + 6) % 7; // Monday = 0
  const startWeek = new Date(startToday);
  startWeek.setDate(startToday.getDate() - dow);
  if (d >= startToday) return "Today";
  if (d >= startWeek) return "This week";
  return "Earlier";
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

async function fetchArtifacts(roomId: string): Promise<ArtifactRow[]> {
  const { data, error } = await supabase
    .from("ai_artifacts")
    .select(
      "id, state, transcript, created_at, artifact_type, template_key, created_by, author:members!created_by(discipline)",
    )
    .eq("room_id", roomId)
    .neq("artifact_type", "meeting_minutes")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as ArtifactRow[];
}

export default function NotesAndDocumentsScreen() {
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

  // filters
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [disciplineFilter, setDisciplineFilter] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("newest");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const artifactsQuery = useQuery({
    queryKey: ["voice-notes", roomId],
    queryFn: () => fetchArtifacts(roomId),
    enabled: !!roomId,
  });

  const templatesQuery = useQuery({
    queryKey: ["doc-templates"],
    queryFn: listTemplates,
    staleTime: 1000 * 60 * 30,
  });
  const templateMap = useMemo(() => {
    const m: Record<string, { code: string | null; name: string; discipline: string }> = {};
    for (const t of templatesQuery.data ?? []) {
      m[t.template_key] = { code: t.code, name: t.display_name, discipline: t.discipline };
    }
    return m;
  }, [templatesQuery.data]);

  const artifacts = useMemo(() => artifactsQuery.data ?? [], [artifactsQuery.data]);
  // "new since I last looked": freeze the last-seen watermark on entry, render
  // markers against it for this whole visit, then stamp now() for next time.
  const [notesSeenBaseline, setNotesSeenBaseline] = useState<string | null>(null);
  const baselineCapturedRef = useRef(false);
  const starredQuery = useQuery({ queryKey: ["note-stars", roomId], queryFn: fetchMyStarredIds });
  const starred = starredQuery.data ?? new Set<string>();
  const [starredOnly, setStarredOnly] = useState(false);
  const [rowMenu, setRowMenu] = useState<ArtifactRow | null>(null);
  const myIdQuery = useQuery({ queryKey: ["my-member-id"], queryFn: getCurrentMemberId });
  const myMemberId = myIdQuery.data ?? null;
  const [reviewTarget, setReviewTarget] = useState<ArtifactRow | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [requesting, setRequesting] = useState(false);
  const teammatesQuery = useQuery({
    queryKey: ["room-teammates", roomId, myMemberId],
    queryFn: () => fetchRoomTeammates(roomId, myMemberId ?? undefined),
    enabled: !!roomId && !!reviewTarget,
  });
  const reviewsQuery = useQuery({
    queryKey: ["review-requests", roomId],
    queryFn: () => fetchRoomReviewRequests(roomId),
    enabled: !!roomId,
  });
  const reviews = reviewsQuery.data ?? [];
  // artifacts others asked ME to review and I have not reviewed yet
  const forMeIds = useMemo(() => {
    const s = new Set<string>();
    for (const rq of reviews) {
      if (rq.requested_for === myMemberId && !rq.reviewed_at) s.add(rq.artifact_id);
    }
    return s;
  }, [reviews, myMemberId]);
  // requests I SENT, grouped by artifact (for sender status)
  const sentByArtifact = useMemo(() => {
    const m: Record<string, ReviewRequest[]> = {};
    for (const rq of reviews) {
      if (rq.requested_by === myMemberId) (m[rq.artifact_id] ||= []).push(rq);
    }
    return m;
  }, [reviews, myMemberId]);
  const teammateName = useCallback((id: string) => {
    const tm = (teammatesQuery.data ?? []).find((x) => x.member_id === id);
    return tm?.full_name ?? "teammate";
  }, [teammatesQuery.data]);

  const submitReview = async () => {
    if (!reviewTarget || picked.size === 0) return;
    try {
      setRequesting(true);
      await requestReview(reviewTarget.id, Array.from(picked));
      await queryClient.invalidateQueries({ queryKey: ["review-requests", roomId] });
      setReviewTarget(null); setPicked(new Set());
    } catch (e) { console.error("requestReview failed", e); }
    finally { setRequesting(false); }
  };
  const toggleStar = async (id: string) => {
    const isStarred = starred.has(id);
    try {
      if (isStarred) { await unstarNote(id); } else { await starNote(id); }
      await queryClient.invalidateQueries({ queryKey: ["note-stars", roomId] });
    } catch (e) { console.error("toggleStar failed", e); }
  };
  const isTyped = useCallback((a: ArtifactRow) => a.artifact_type === "typed_note", []);

  // each note's discipline: author discipline -> template discipline -> null
  const disciplineOf = useCallback(
    (a: ArtifactRow): string | null => {
      if (a.author?.discipline) return a.author.discipline;
      const code = a.template_key ? templateMap[a.template_key]?.code : null;
      if (code) { const prefix = code.split("-")[0]; return CODE_PREFIX_TO_ROLE[prefix] ?? null; }
      return null;
    },
    [templateMap],
  );

  // disciplines actually present in this room (for the filter options)
  const presentDisciplines = useMemo(() => {
    const set = new Set<string>();
    for (const a of artifacts) {
      const d = disciplineOf(a);
      if (d) set.add(d);
    }
    return Array.from(set).sort();
  }, [artifacts, disciplineOf]);

  const activeFilterCount =
    (typeFilter !== "all" ? 1 : 0) +
    (disciplineFilter ? 1 : 0) +
    (sort !== "newest" ? 1 : 0) +
    (starredOnly ? 1 : 0);

  const summaryLine = useMemo(() => {
    const bits: string[] = [];
    if (typeFilter === "voice") bits.push("Voice");
    if (typeFilter === "typed") bits.push("Typed");
    if (disciplineFilter) bits.push(DISCIPLINE_LABEL[disciplineFilter] ?? disciplineFilter);
    bits.push(sort === "newest" ? "Newest" : "Oldest");
    return bits.join("  \u00B7  ");
  }, [typeFilter, disciplineFilter, sort]);

  const sections = useMemo(() => {
    let visible = artifacts.filter((a) => {
      if (a.state === "discarded") return false;
      if (typeFilter === "voice" && isTyped(a)) return false;
      if (typeFilter === "typed" && !isTyped(a)) return false;
      if (disciplineFilter && disciplineOf(a) !== disciplineFilter) return false;
      if (starredOnly && !starred.has(a.id)) return false;
      return true;
    });

    visible = visible.slice().sort((a, b) => {
      const ta = new Date(a.created_at).getTime();
      const tb = new Date(b.created_at).getTime();
      return sort === "newest" ? tb - ta : ta - tb;
    });

    const needsReview = visible.filter((a) => NEEDS_REVIEW.has(a.state));
    const processing = visible.filter((a) => PROCESSING.has(a.state));
    const done = visible.filter((a) => DONE.has(a.state));

    const out: { title: string; count?: number; data: ArtifactRow[] }[] = [];
    const forYou = visible.filter((a) => forMeIds.has(a.id));
    if (forYou.length) out.push({ title: "For you", count: forYou.length, data: forYou });
    if (needsReview.length)
      out.push({ title: "Needs review", count: needsReview.length, data: needsReview });
    if (processing.length) out.push({ title: "Processing", data: processing });

    // date-group the Done pile (respecting sort order of the buckets)
    const buckets: Record<string, ArtifactRow[]> = { Today: [], "This week": [], Earlier: [] };
    for (const a of done) buckets[dateBucket(a.created_at)].push(a);
    const order = ["Today", "This week", "Earlier"];
    for (const b of order) {
      if (buckets[b].length) out.push({ title: b, data: buckets[b] });
    }
    return out;
  }, [artifacts, typeFilter, disciplineFilter, sort, isTyped, disciplineOf, starredOnly, starred, forMeIds]);

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
      queryClient.invalidateQueries({ queryKey: ["review-requests", roomId] });
      if (!baselineCapturedRef.current) {
        baselineCapturedRef.current = true;
        fetchNotesLastSeen(roomId).then((ts) => {
          setNotesSeenBaseline(ts);
          markNotesSeen(roomId);
        });
      }
      return () => {
        isFocusedRef.current = false;
      };
    }, [queryClient, roomId]),
  );

  useEffect(() => {
    if (!hasNonTerminal) return;
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
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(
        Audio.RecordingOptionsPresets.HIGH_QUALITY,
      );
      recordingRef.current = recording;
      setElapsed(0);
      setIsRecording(true);
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    } catch (e) {
      console.error("Start recording failed:", e);
      setErrorText("Could not start recording. Please try again.");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
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
      const path = `${roomId}/${file}`;
      const base64 = await new File(localUri).base64();
      const { error: uploadError } = await supabase.storage
        .from("voice-notes")
        .upload(path, decode(base64), { contentType: "audio/m4a", upsert: false });
      if (uploadError) throw uploadError;
      const { error: rpcError } = await supabase.rpc("create_voice_artifact", {
        p_room_id: roomId,
        p_audio_path: path,
      });
      if (rpcError) throw rpcError;
      queryClient.invalidateQueries({ queryKey: ["voice-notes", roomId] });
    } catch (e) {
      console.error("Upload / register voice note failed:", e);
      setErrorText("Saved your recording but couldn't register it. Please try again.");
    } finally {
      setIsUploading(false);
    }
  }, [queryClient, roomId]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
    };
  }, []);

  // For notes I SENT for review: a compact "Read by / Awaiting" status line.
  const senderStatus = useCallback((artId: string) => {
    const reqs = sentByArtifact[artId];
    if (!reqs || reqs.length === 0) return null;
    const read = reqs.filter((q) => q.reviewed_at);
    const awaiting = reqs.filter((q) => !q.reviewed_at);
    const names = (list: typeof reqs) => {
      const ns = list.map((q) => teammateName(q.requested_for));
      if (ns.length <= 2) return ns.join(", ");
      return `${ns.slice(0, 2).join(", ")} +${ns.length - 2}`;
    };
    const parts: string[] = [];
    if (read.length) parts.push(`Read by ${names(read)}`);
    if (awaiting.length) parts.push(`Awaiting ${names(awaiting)}`);
    return { text: parts.join("  \u00B7  "), allRead: awaiting.length === 0 };
  }, [sentByArtifact, teammateName]);

  const isNew = useCallback((item: ArtifactRow) => {
    if (!notesSeenBaseline) return false;
    return new Date(item.created_at).getTime() > new Date(notesSeenBaseline).getTime();
  }, [notesSeenBaseline]);

  const renderRow = (item: ArtifactRow) => {
    const pill = stateToPill(item.state);
    const typed = isTyped(item);
    const tmpl = item.template_key ? templateMap[item.template_key] : undefined;
    const title = typed ? tmpl?.name ?? "Typed note" : "Voice note";
    const disc = disciplineOf(item);
    const fresh = isNew(item);
    return (
      <Pressable
        style={({ pressed }) => [styles.noteRow, fresh && styles.noteRowNew, starred.has(item.id) && styles.noteRowStarred, pressed && styles.noteRowPressed]}
        onPress={() => router.push(`/note/${item.id}`)}
        onLongPress={() => setRowMenu(item)}
        delayLongPress={250}
        testID={`note-${item.id}`}
      >
        <View style={styles.noteIcon}>
          {typed ? (
            <FileText color={Theme.primary} size={20} />
          ) : (
            <Mic color={Theme.primary} size={20} />
          )}
        </View>
        <View style={styles.noteRowText}>
          <View style={styles.noteTitleRow}>
            {typed && tmpl?.code ? (
              <View style={styles.codeBadge}>
                <Text style={styles.codeBadgeText}>{tmpl.code}</Text>
              </View>
            ) : null}
            {fresh ? (
              <View style={styles.newTag}><Text style={styles.newTagText}>New</Text></View>
            ) : null}
            <Text style={styles.noteTitle} numberOfLines={1}>
              {title}
            </Text>
          </View>
          {item.transcript ? (
            <Text style={styles.notePreview} numberOfLines={1}>
              {item.transcript}
            </Text>
          ) : null}
          <Text style={styles.noteTime}>
            {relativeTime(item.created_at)}
            {disc ? `  \u00B7  ${DISCIPLINE_LABEL[disc] ?? disc}` : ""}
          </Text>
          {(() => { const s = senderStatus(item.id); return s ? (
            <View style={styles.senderStatusRow} testID="sender-status">
              {s.allRead ? <Check color={Theme.primary} size={13} /> : <Eye color={Theme.textMuted} size={13} />}
              <Text style={[styles.senderStatusText, s.allRead && styles.senderStatusDone]} numberOfLines={1}>{s.text}</Text>
            </View>
          ) : null; })()}
        </View>
        <View style={[styles.pill, { borderColor: pill.color }]}>
          {pill.spinner ? <ActivityIndicator color={pill.color} size="small" /> : null}
          <Text style={[styles.pillText, { color: pill.color }]}>{pill.label}</Text>
        </View>
      </Pressable>
    );
  };

  const TYPE_OPTS: { key: TypeFilter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "voice", label: "Voice" },
    { key: "typed", label: "Typed" },
  ];

  return (
    <View style={[styles.container, { paddingBottom: insets.bottom }]}>
      <Stack.Screen options={{ title: "Notes & documents", headerBackTitle: "Room" }} />

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
            ? "Saving..."
            : isRecording
              ? `Recording ${formatDuration(elapsed)}`
              : "Tap to record a voice note"}
        </Text>
        {isRecording ? <View style={styles.recDot} /> : null}
        {errorText ? <Text style={styles.errorText}>{errorText}</Text> : null}
      </View>

      {/* filter bar: a single Filters button + active summary */}
      <View style={styles.filterBar}>
        <Pressable
          style={[styles.filterBtn, activeFilterCount > 0 && styles.filterBtnActive]}
          onPress={() => setFiltersOpen(true)}
          testID="filters-button"
        >
          <SlidersHorizontal
            color={activeFilterCount > 0 ? "#FFFFFF" : Theme.primary}
            size={16}
          />
          <Text style={[styles.filterBtnText, activeFilterCount > 0 && styles.filterBtnTextActive]}>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </Text>
        </Pressable>
        <Text style={styles.summaryLine} numberOfLines={1}>
          {summaryLine}
        </Text>
      </View>

      {artifactsQuery.isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeaderRow}>
              <Text style={styles.sectionHeader}>{section.title}</Text>
              {typeof section.count === "number" ? (
                <View style={styles.countBadge}>
                  <Text style={styles.countBadgeText}>{section.count}</Text>
                </View>
              ) : null}
            </View>
          )}
          renderItem={({ item }) => renderRow(item)}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {activeFilterCount > 0
                  ? "No notes match these filters."
                  : "No notes or documents yet - record above, or type a message and tap Make note."}
              </Text>
            </View>
          }
        />
      )}

      {/* review request: pick teammates */}
      <Modal visible={!!reviewTarget} animationType="slide" transparent onRequestClose={() => setReviewTarget(null)} testID="review-picker">
        <View style={styles.scrim}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Ask to review</Text>
              <Pressable onPress={() => setReviewTarget(null)} hitSlop={10}><Text style={styles.sheetClose}>Cancel</Text></Pressable>
            </View>
            <Text style={styles.groupLabel}>Choose teammates</Text>
            {teammatesQuery.isLoading ? (
              <ActivityIndicator color={Theme.primary} style={{ marginVertical: 16 }} />
            ) : (teammatesQuery.data ?? []).length === 0 ? (
              <Text style={styles.emptyText}>No other teammates in this room yet.</Text>
            ) : (
              (teammatesQuery.data ?? []).map((tm: RoomTeammate) => {
                const on = picked.has(tm.member_id);
                return (
                  <Pressable key={tm.member_id} style={styles.menuItem} onPress={() => {
                    setPicked((prev) => { const n = new Set(prev); if (n.has(tm.member_id)) n.delete(tm.member_id); else n.add(tm.member_id); return n; });
                  }}>
                    <View style={[styles.checkbox, on && styles.checkboxOn]}>{on ? <Check color="#FFFFFF" size={14} /> : null}</View>
                    <Text style={styles.menuItemText}>{tm.full_name ?? "Unnamed"}{tm.discipline ? `  \u00B7  ${DISCIPLINE_LABEL[tm.discipline] ?? tm.discipline}` : ""}</Text>
                  </Pressable>
                );
              })
            )}
            <Pressable style={[styles.primaryBtn, (picked.size === 0 || requesting) && styles.primaryBtnDisabled]} disabled={picked.size === 0 || requesting} onPress={submitReview} testID="submit-review">
              {requesting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryBtnText}>{picked.size > 0 ? `Request review (${picked.size})` : "Request review"}</Text>}
            </Pressable>
          </View>
        </View>
      </Modal>

      {/* row action sheet (long-press) */}
      <Modal visible={!!rowMenu} animationType="slide" transparent onRequestClose={() => setRowMenu(null)} testID="row-action-sheet">
        <Pressable style={styles.scrim} onPress={() => setRowMenu(null)}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {rowMenu ? (isTyped(rowMenu) ? (rowMenu.template_key && templateMap[rowMenu.template_key] ? templateMap[rowMenu.template_key].name : "Typed note") : "Voice note") : ""}
              </Text>
              <Pressable onPress={() => setRowMenu(null)} hitSlop={10}><Text style={styles.sheetClose}>Done</Text></Pressable>
            </View>
            <Pressable
              style={styles.menuItem}
              onPress={() => { const id = rowMenu!.id; setRowMenu(null); toggleStar(id); }}
              testID="menu-toggle-star"
            >
              <Star color={Theme.coral} fill={rowMenu && starred.has(rowMenu.id) ? Theme.coral : "none"} size={20} />
              <Text style={styles.menuItemText}>{rowMenu && starred.has(rowMenu.id) ? "Unstar" : "Star"}</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => { const it = rowMenu!; setRowMenu(null); setPicked(new Set()); setReviewTarget(it); }}
              testID="menu-request-review"
            >
              <UserCheck color={Theme.primary} size={20} />
              <Text style={styles.menuItemText}>Request review</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>

      {/* Filters sheet */}
      <Modal
        visible={filtersOpen}
        animationType="slide"
        transparent
        onRequestClose={() => setFiltersOpen(false)}
      >
        <View style={styles.scrim}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Filters</Text>
              <Pressable onPress={() => setFiltersOpen(false)} hitSlop={10}>
                <Text style={styles.sheetClose}>Done</Text>
              </Pressable>
            </View>

            <Text style={styles.groupLabel}>Type</Text>
            <View style={styles.chipRow}>
              {TYPE_OPTS.map((o) => {
                const on = typeFilter === o.key;
                return (
                  <Pressable
                    key={o.key}
                    onPress={() => setTypeFilter(o.key)}
                    style={[styles.chip, on && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </View>

            {presentDisciplines.length > 0 ? (
              <>
                <Text style={styles.groupLabel}>Discipline</Text>
                <View style={styles.chipRow}>
                  <Pressable
                    onPress={() => setDisciplineFilter(null)}
                    style={[styles.chip, !disciplineFilter && styles.chipOn]}
                  >
                    <Text style={[styles.chipText, !disciplineFilter && styles.chipTextOn]}>All</Text>
                  </Pressable>
                  {presentDisciplines.map((d) => {
                    const on = disciplineFilter === d;
                    return (
                      <Pressable
                        key={d}
                        onPress={() => setDisciplineFilter(on ? null : d)}
                        style={[styles.chip, on && styles.chipOn]}
                      >
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>
                          {DISCIPLINE_LABEL[d] ?? d}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            <Text style={styles.groupLabel}>Show</Text>
            <View style={styles.chipRow}>
              <Pressable onPress={() => setStarredOnly((v) => !v)} style={[styles.chip, starredOnly && styles.chipOn]}>
                <Star color={starredOnly ? "#FFFFFF" : Theme.textMuted} fill={starredOnly ? "#FFFFFF" : "none"} size={14} />
                <Text style={[styles.chipText, starredOnly && styles.chipTextOn]}>Starred only</Text>
              </Pressable>
            </View>

            <Text style={styles.groupLabel}>Sort</Text>
            <View style={styles.chipRow}>
              {(["newest", "oldest"] as Sort[]).map((s) => {
                const on = sort === s;
                return (
                  <Pressable
                    key={s}
                    onPress={() => setSort(s)}
                    style={[styles.chip, on && styles.chipOn]}
                  >
                    {on ? <Check color="#FFFFFF" size={14} /> : null}
                    <Text style={[styles.chipText, on && styles.chipTextOn]}>
                      {s === "newest" ? "Newest first" : "Oldest first"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {activeFilterCount > 0 ? (
              <Pressable
                style={styles.clearBtn}
                onPress={() => {
                  setTypeFilter("all");
                  setDisciplineFilter(null);
                  setSort("newest");
                  setStarredOnly(false);
                }}
              >
                <Text style={styles.clearBtnText}>Clear all filters</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  recorderCard: {
    alignItems: "center",
    paddingVertical: 24,
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
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: Theme.coral },
  errorText: { fontSize: 14, color: Theme.coral, textAlign: "center" },
  loader: { marginTop: 40 },

  filterBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 4,
  },
  filterBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.primary,
  },
  filterBtnActive: { backgroundColor: Theme.primary, borderColor: Theme.primary },
  filterBtnText: { color: Theme.primary, fontWeight: "700", fontSize: 13 },
  filterBtnTextActive: { color: "#FFFFFF" },
  summaryLine: { flex: 1, color: Theme.textMuted, fontSize: 13 },

  listContent: { padding: 20, gap: 12, flexGrow: 1 },
  sectionHeaderRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8, marginBottom: 2 },
  sectionHeader: {
    fontSize: 12,
    fontWeight: "700",
    color: Theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  countBadge: {
    minWidth: 20,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: Theme.coral,
    alignItems: "center",
    justifyContent: "center",
  },
  countBadgeText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },

  noteRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  noteRowPressed: { backgroundColor: Theme.border },
  noteIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Theme.background,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Theme.border,
  },
  noteRowText: { flex: 1, gap: 3 },
  noteTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  codeBadge: {
    backgroundColor: Theme.background,
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 56,
    alignItems: "center",
  },
  codeBadgeText: { fontSize: 11, fontWeight: "700", color: Theme.textMuted, fontFamily: MONO },
  noteTitle: { fontSize: 15, fontWeight: "600", color: Theme.text, flexShrink: 1 },
  notePreview: { fontSize: 13, color: Theme.textMuted },
  noteTime: { fontSize: 12, color: Theme.textMuted },
  senderStatusRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  senderStatusText: { fontSize: 12, color: Theme.textMuted, flexShrink: 1 },
  senderStatusDone: { color: Theme.primary, fontWeight: "600" },
  noteRowStarred: { borderLeftWidth: 4, borderLeftColor: Theme.coral },
  noteRowNew: { borderLeftWidth: 4, borderLeftColor: Theme.primary },
  newTag: { backgroundColor: Theme.primary, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  newTagText: { color: "#FFFFFF", fontSize: 10, fontWeight: "800", letterSpacing: 0.4 },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 16 },
  menuItemText: { fontSize: 16, color: Theme.text, fontWeight: "600" },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: Theme.border, alignItems: "center", justifyContent: "center" },
  checkboxOn: { backgroundColor: Theme.primary, borderColor: Theme.primary },
  primaryBtn: { marginTop: 16, backgroundColor: Theme.primary, borderRadius: 12, paddingVertical: 15, alignItems: "center" },
  primaryBtnDisabled: { opacity: 0.4 },
  primaryBtnText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },
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
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 60, paddingHorizontal: 32 },
  emptyText: { fontSize: 15, color: Theme.textMuted, textAlign: "center" },

  // filters sheet
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "flex-end" },
  sheet: {
    backgroundColor: Theme.background,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 14,
    gap: 6,
  },
  sheetHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6 },
  sheetTitle: { fontSize: 18, fontWeight: "700", color: Theme.text },
  sheetClose: { fontSize: 15, color: Theme.primary, fontWeight: "700" },
  groupLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: Theme.textMuted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 12,
    marginBottom: 6,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  chipOn: { backgroundColor: Theme.primary, borderColor: Theme.primary },
  chipText: { color: Theme.textMuted, fontWeight: "600", fontSize: 13 },
  chipTextOn: { color: "#FFFFFF" },
  clearBtn: { marginTop: 18, alignItems: "center", paddingVertical: 12 },
  clearBtnText: { color: Theme.coral, fontWeight: "700", fontSize: 14 },
});
