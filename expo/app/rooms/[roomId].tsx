import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as ScreenCapture from "expo-screen-capture";
import { FileText, Headphones, Mic, Send, UserPlus, X } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { getCurrentMemberId } from "@/lib/member";
import { supabase } from "@/lib/supabase";

type MessageRow = {
  id: string;
  body: string | null;
  kind: string;
  created_at: string;
  author_member_id: string | null;
  author: { full_name: string | null } | null;
};

type RoomRow = {
  id: string;
  case_id: string;
  title: string | null;
  room_type: string;
};

type RoomMemberRow = { member_id: string | null };

type RecordingRow = {
  id: string;
  status: string;
  created_at: string;
  recording_mode: string | null;
};

type CaseMemberRow = {
  member_id: string;
  case_role: string;
  member: { full_name: string | null } | null;
};

function humanize(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function fetchRoom(roomId: string): Promise<RoomRow | null> {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, case_id, title, room_type")
    .eq("id", roomId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return (data as RoomRow) ?? null;
}

async function fetchMessages(roomId: string): Promise<MessageRow[]> {
  const { data, error } = await supabase
    .from("messages")
    .select(
      "id, body, kind, created_at, author_member_id, author:members!author_member_id(full_name)",
    )
    .eq("room_id", roomId)
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return (data ?? []) as unknown as MessageRow[];
}

async function fetchRecordings(roomId: string): Promise<RecordingRow[]> {
  const sessions = await supabase
    .from("live_sessions")
    .select("id")
    .eq("room_id", roomId);
  if (sessions.error) {
    throw sessions.error;
  }
  const sessionIds = ((sessions.data ?? []) as { id: string }[]).map(
    (s) => s.id,
  );
  if (sessionIds.length === 0) {
    return [];
  }
  const { data, error } = await supabase
    .from("meeting_recordings")
    .select("id, status, created_at, recording_mode")
    .in("live_session_id", sessionIds)
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []) as RecordingRow[];
}

async function fetchAddableMembers(
  roomId: string,
  caseId: string,
): Promise<CaseMemberRow[]> {
  const [caseMembers, roomMembers] = await Promise.all([
    supabase
      .from("case_members")
      .select("member_id, case_role, member:members!member_id(full_name)")
      .eq("case_id", caseId),
    supabase.from("room_members").select("member_id").eq("room_id", roomId),
  ]);
  if (caseMembers.error) {
    throw caseMembers.error;
  }
  if (roomMembers.error) {
    throw roomMembers.error;
  }
  const inRoom = new Set(
    ((roomMembers.data ?? []) as RoomMemberRow[])
      .map((r) => r.member_id)
      .filter((id): id is string => !!id),
  );
  return ((caseMembers.data ?? []) as unknown as CaseMemberRow[]).filter(
    (cm) => cm.member_id && !inRoom.has(cm.member_id),
  );
}

export default function RoomThreadScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();
  const listRef = useRef<FlatList<MessageRow>>(null);

  const [body, setBody] = useState<string>("");
  const [isAddOpen, setIsAddOpen] = useState<boolean>(false);
  const [isRecordingsOpen, setIsRecordingsOpen] = useState<boolean>(false);

  // Lightweight clinical-surface protection while this screen is focused.
  useEffect(() => {
    ScreenCapture.preventScreenCaptureAsync().catch(() => {
      // No-op: best-effort only.
    });
    return () => {
      ScreenCapture.allowScreenCaptureAsync().catch(() => {});
    };
  }, []);

  const roomQuery = useQuery({
    queryKey: ["room", roomId],
    queryFn: () => fetchRoom(roomId),
    enabled: !!roomId,
  });
  const messagesQuery = useQuery({
    queryKey: ["messages", roomId],
    queryFn: () => fetchMessages(roomId),
    enabled: !!roomId,
  });

  const caseId = roomQuery.data?.case_id;

  const recordingsQuery = useQuery({
    queryKey: ["recordings", roomId],
    queryFn: () => fetchRecordings(roomId),
    enabled: !!roomId && isRecordingsOpen,
  });

  const addableQuery = useQuery({
    queryKey: ["addable-members", roomId, caseId],
    queryFn: () => fetchAddableMembers(roomId, caseId as string),
    enabled: !!roomId && !!caseId && isAddOpen,
  });

  const sendMessage = useMutation({
    mutationFn: async (text: string): Promise<void> => {
      const memberId = await getCurrentMemberId();
      if (!memberId) {
        throw new Error("Could not resolve your member id.");
      }
      const { error } = await supabase.from("messages").insert({
        room_id: roomId,
        author_member_id: memberId,
        body: text,
        kind: "text",
      });
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      setBody("");
      queryClient.invalidateQueries({ queryKey: ["messages", roomId] });
    },
    onError: (e) => {
      console.error("Send message failed:", e);
    },
  });

  const addMember = useMutation({
    mutationFn: async (memberId: string): Promise<void> => {
      const { error } = await supabase.rpc("add_room_member", {
        p_room_id: roomId,
        p_member_id: memberId,
        p_member_role: "participant",
      });
      if (error) {
        throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addable-members", roomId, caseId] });
      setIsAddOpen(false);
    },
    onError: (e) => {
      console.error("Add room member failed:", e);
    },
  });

  const messages = useMemo(() => messagesQuery.data ?? [], [messagesQuery.data]);

  const onSend = useCallback(() => {
    const trimmed = body.trim();
    if (trimmed.length === 0 || sendMessage.isPending) {
      return;
    }
    sendMessage.mutate(trimmed);
  }, [body, sendMessage]);

  const headerTitle =
    roomQuery.data?.title && roomQuery.data.title.length > 0
      ? roomQuery.data.title
      : roomQuery.data
        ? humanize(roomQuery.data.room_type)
        : "Room";

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <Stack.Screen
        options={{
          title: headerTitle,
          headerBackTitle: "Case",
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => router.push(`/live/${roomId}`)}
                hitSlop={12}
                testID="go-live-button"
              >
                <Headphones color={Theme.primary} size={22} />
              </Pressable>
              <Pressable
                onPress={() => router.push(`/notes/${roomId}`)}
                hitSlop={12}
                testID="voice-notes-button"
              >
                <Mic color={Theme.primary} size={22} />
              </Pressable>
              <Pressable
                onPress={() => setIsRecordingsOpen(true)}
                hitSlop={12}
                testID="recordings-button"
              >
                <FileText color={Theme.primary} size={22} />
              </Pressable>
              <Pressable
                onPress={() => setIsAddOpen(true)}
                hitSlop={12}
                testID="add-member-button"
              >
                <UserPlus color={Theme.primary} size={22} />
              </Pressable>
            </View>
          ),
        }}
      />

      {messagesQuery.isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.listContent}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: false })
          }
          renderItem={({ item }) => (
            <View style={styles.message}>
              <View style={styles.messageHead}>
                <Text style={styles.author}>
                  {item.author?.full_name ?? "Unknown"}
                </Text>
                <Text style={styles.time}>{formatTime(item.created_at)}</Text>
              </View>
              <Text style={styles.body}>{item.body}</Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>No messages yet.</Text>
            </View>
          }
        />
      )}

      <View style={[styles.composer, { paddingBottom: insets.bottom + 10 }]}>
        <TextInput
          style={styles.composerInput}
          value={body}
          onChangeText={setBody}
          placeholder="Write a message"
          placeholderTextColor={Theme.textMuted}
          multiline
          testID="message-input"
        />
        <Pressable
          style={({ pressed }) => [
            styles.send,
            (body.trim().length === 0 || sendMessage.isPending) &&
              styles.sendDisabled,
            pressed && styles.sendPressed,
          ]}
          onPress={onSend}
          disabled={body.trim().length === 0 || sendMessage.isPending}
          testID="send-button"
        >
          {sendMessage.isPending ? (
            <ActivityIndicator color="#FFFFFF" size="small" />
          ) : (
            <Send color="#FFFFFF" size={20} />
          )}
        </Pressable>
      </View>

      <Modal
        visible={isRecordingsOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsRecordingsOpen(false)}
      >
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Recent recordings</Text>
            <Pressable onPress={() => setIsRecordingsOpen(false)} hitSlop={12}>
              <X color={Theme.textMuted} size={24} />
            </Pressable>
          </View>

          {recordingsQuery.isLoading ? (
            <ActivityIndicator color={Theme.primary} style={styles.loader} />
          ) : (recordingsQuery.data ?? []).length === 0 ? (
            <Text style={styles.emptyText}>
              No recordings yet for this room.
            </Text>
          ) : (
            <FlatList
              data={recordingsQuery.data ?? []}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.addList}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [
                    styles.addRow,
                    pressed && styles.addRowPressed,
                  ]}
                  onPress={() => {
                    setIsRecordingsOpen(false);
                    router.push(
                      `/review/${item.id}?roomId=${roomId}`,
                    );
                  }}
                  testID={`recording-${item.id}`}
                >
                  <View style={styles.addRowText}>
                    <Text style={styles.memberName}>
                      {formatTime(item.created_at)} ·{" "}
                      {new Date(item.created_at).toLocaleDateString()}
                    </Text>
                    <Text style={styles.memberRole}>
                      Review minutes
                    </Text>
                  </View>
                  <FileText color={Theme.primary} size={20} />
                </Pressable>
              )}
            />
          )}
        </View>
      </Modal>

      <Modal
        visible={isAddOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsAddOpen(false)}
      >
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Add member</Text>
            <Pressable onPress={() => setIsAddOpen(false)} hitSlop={12}>
              <X color={Theme.textMuted} size={24} />
            </Pressable>
          </View>

          {addableQuery.isLoading ? (
            <ActivityIndicator color={Theme.primary} style={styles.loader} />
          ) : (addableQuery.data ?? []).length === 0 ? (
            <Text style={styles.emptyText}>
              Everyone on the case is already in this room.
            </Text>
          ) : (
            <FlatList
              data={addableQuery.data ?? []}
              keyExtractor={(item) => item.member_id}
              contentContainerStyle={styles.addList}
              renderItem={({ item }) => (
                <Pressable
                  style={({ pressed }) => [
                    styles.addRow,
                    pressed && styles.addRowPressed,
                  ]}
                  onPress={() => {
                    if (!addMember.isPending) {
                      addMember.mutate(item.member_id);
                    }
                  }}
                  testID={`add-${item.member_id}`}
                >
                  <View style={styles.addRowText}>
                    <Text style={styles.memberName}>
                      {item.member?.full_name ?? "Unknown member"}
                    </Text>
                    <Text style={styles.memberRole}>
                      {humanize(item.case_role)}
                    </Text>
                  </View>
                  <UserPlus color={Theme.primary} size={20} />
                </Pressable>
              )}
            />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  headerActions: { flexDirection: "row", alignItems: "center", gap: 20 },
  loader: { marginTop: 40 },
  listContent: { padding: 20, gap: 16, flexGrow: 1 },
  message: {
    backgroundColor: Theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 14,
  },
  messageHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 6,
  },
  author: { fontSize: 14, fontWeight: "600", color: Theme.text },
  time: { fontSize: 12, color: Theme.textMuted },
  body: { fontSize: 16, color: Theme.text, lineHeight: 22 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingTop: 80 },
  emptyText: { fontSize: 15, color: Theme.textMuted },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Theme.border,
    backgroundColor: Theme.background,
  },
  composerInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
    color: Theme.text,
    backgroundColor: Theme.surface,
  },
  send: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendPressed: { backgroundColor: Theme.primaryPressed },
  sendDisabled: { opacity: 0.4 },
  sheet: { flex: 1, backgroundColor: Theme.background, padding: 24 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  sheetTitle: { fontSize: 22, fontWeight: "700", color: Theme.text },
  addList: { gap: 10 },
  addRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  addRowPressed: { backgroundColor: Theme.border },
  addRowText: { gap: 4 },
  memberName: { fontSize: 16, color: Theme.text },
  memberRole: { fontSize: 13, color: Theme.textMuted, textTransform: "capitalize" },
});
