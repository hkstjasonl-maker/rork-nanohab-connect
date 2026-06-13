import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { Copy, Plus, UserPlus, X } from "lucide-react-native";
import React, { useMemo, useState } from "react";
import {
  ActivityIndicator,
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

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

type AudienceDefault =
  | "care_team"
  | "patient"
  | "caregiver"
  | "teacher"
  | "mixed";

type RoomType =
  | "coordination"
  | "referral"
  | "mdt"
  | "family"
  | "school"
  | "home_program"
  | "discharge"
  | "supervision";

const roomTypes: RoomType[] = [
  "coordination",
  "referral",
  "mdt",
  "family",
  "school",
  "home_program",
  "discharge",
  "supervision",
];

const audiences: AudienceDefault[] = [
  "care_team",
  "patient",
  "caregiver",
  "teacher",
  "mixed",
];

type ParticipantRole =
  | "guardian"
  | "primary_caregiver"
  | "helper"
  | "teacher"
  | "school_staff"
  | "patient";

const participantRoles: ParticipantRole[] = [
  "guardian",
  "primary_caregiver",
  "helper",
  "teacher",
  "school_staff",
  "patient",
];

type CaseRow = {
  id: string;
  patient_display_name: string | null;
  status: string | null;
};

type RoomRow = {
  id: string;
  title: string | null;
  room_type: RoomType;
  audience_default: AudienceDefault;
  status: string | null;
};

type CaseMemberRow = {
  id: string;
  case_role: string;
  member: { full_name: string | null } | null;
};

type InviteResult = {
  invite_id: string;
  token: string;
  expires_at: string;
};

function humanize(value: string): string {
  return value
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function audienceColor(audience: AudienceDefault): string {
  switch (audience) {
    case "care_team":
      return Theme.primary;
    case "caregiver":
    case "patient":
      return Theme.coral;
    case "teacher":
      return Theme.blue;
    case "mixed":
    default:
      return Theme.grey;
  }
}

async function fetchCase(caseId: string): Promise<CaseRow | null> {
  const { data, error } = await supabase
    .from("cases")
    .select("id, patient_display_name, status")
    .eq("id", caseId)
    .maybeSingle();
  if (error) {
    throw error;
  }
  return (data as CaseRow) ?? null;
}

async function fetchRooms(caseId: string): Promise<RoomRow[]> {
  const { data, error } = await supabase
    .from("rooms")
    .select("id, title, room_type, audience_default, status")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });
  if (error) {
    throw error;
  }
  return (data ?? []) as RoomRow[];
}

async function fetchCaseMembers(caseId: string): Promise<CaseMemberRow[]> {
  const { data, error } = await supabase
    .from("case_members")
    .select("id, case_role, member:members!member_id(full_name)")
    .eq("case_id", caseId);
  if (error) {
    throw error;
  }
  return (data ?? []) as unknown as CaseMemberRow[];
}

function PickerRow<T extends string>({
  options,
  selected,
  onSelect,
}: {
  options: T[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <View style={styles.pickerWrap}>
      {options.map((opt) => {
        const isSelected = opt === selected;
        return (
          <Pressable
            key={opt}
            onPress={() => onSelect(opt)}
            style={[styles.pickerChip, isSelected && styles.pickerChipActive]}
          >
            <Text
              style={[
                styles.pickerChipText,
                isSelected && styles.pickerChipTextActive,
              ]}
            >
              {humanize(opt)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function CaseDetailScreen() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [isRoomFormOpen, setIsRoomFormOpen] = useState<boolean>(false);
  const [roomType, setRoomType] = useState<RoomType>("coordination");
  const [roomTitle, setRoomTitle] = useState<string>("");
  const [audience, setAudience] = useState<AudienceDefault>("care_team");
  const [roomError, setRoomError] = useState<string | null>(null);

  const [isInviteOpen, setIsInviteOpen] = useState<boolean>(false);
  const [inviteRole, setInviteRole] = useState<ParticipantRole>("guardian");
  const [inviteLabel, setInviteLabel] = useState<string>("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [invite, setInvite] = useState<InviteResult | null>(null);

  const caseQuery = useQuery({
    queryKey: ["case", caseId],
    queryFn: () => fetchCase(caseId),
    enabled: !!caseId,
  });
  const roomsQuery = useQuery({
    queryKey: ["rooms", caseId],
    queryFn: () => fetchRooms(caseId),
    enabled: !!caseId,
  });
  const membersQuery = useQuery({
    queryKey: ["case-members", caseId],
    queryFn: () => fetchCaseMembers(caseId),
    enabled: !!caseId,
  });

  const createRoom = useMutation({
    mutationFn: async (): Promise<RoomRow> => {
      const { data, error } = await supabase.rpc("create_room", {
        p_case_id: caseId,
        p_room_type: roomType,
        p_title: roomTitle.trim().length > 0 ? roomTitle.trim() : null,
        p_audience_default: audience,
      });
      if (error) {
        throw error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      return row as RoomRow;
    },
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ["rooms", caseId] });
      setIsRoomFormOpen(false);
      setRoomTitle("");
      setRoomType("coordination");
      setAudience("care_team");
      if (row?.id) {
        router.push(`/rooms/${row.id}`);
      }
    },
    onError: (e) => {
      setRoomError(e instanceof Error ? e.message : "Could not create the room.");
    },
  });

  const createInvite = useMutation({
    mutationFn: async (): Promise<InviteResult> => {
      const { data, error } = await supabase.rpc("create_invite", {
        p_case_id: caseId,
        p_participant_role: inviteRole,
        p_room_id: null,
        p_display_label: inviteLabel.trim(),
      });
      if (error) {
        throw error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      return row as InviteResult;
    },
    onSuccess: (result) => {
      setInvite(result);
    },
    onError: (e) => {
      setInviteError(
        e instanceof Error ? e.message : "Could not create the invite.",
      );
    },
  });

  const caseData = caseQuery.data;
  const rooms = roomsQuery.data ?? [];
  const members = membersQuery.data ?? [];

  const isLoading = caseQuery.isLoading || roomsQuery.isLoading;

  const headerTitle = useMemo(
    () => caseData?.patient_display_name ?? "Case",
    [caseData],
  );

  const closeInvite = () => {
    setIsInviteOpen(false);
    setInvite(null);
    setInviteLabel("");
    setInviteRole("guardian");
    setInviteError(null);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: headerTitle, headerBackTitle: "Cases" }} />

      {isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.caseHeader}>
            <Text style={styles.patientName}>
              {caseData?.patient_display_name ?? "Unnamed patient"}
            </Text>
            {caseData?.status ? (
              <Text style={styles.caseStatus}>{caseData.status}</Text>
            ) : null}
          </View>

          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Rooms</Text>
            <Pressable
              style={({ pressed }) => [styles.smallButton, pressed && styles.smallButtonPressed]}
              onPress={() => {
                setRoomError(null);
                setIsRoomFormOpen(true);
              }}
              testID="new-room-button"
            >
              <Plus color={Theme.primary} size={16} />
              <Text style={styles.smallButtonText}>New room</Text>
            </Pressable>
          </View>

          {rooms.length === 0 ? (
            <Text style={styles.emptyText}>No rooms yet.</Text>
          ) : (
            <View style={styles.cardList}>
              {rooms.map((room) => {
                const color = audienceColor(room.audience_default);
                return (
                  <Pressable
                    key={room.id}
                    style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                    onPress={() => router.push(`/rooms/${room.id}`)}
                    testID={`room-${room.id}`}
                  >
                    <View style={styles.cardTop}>
                      <Text style={styles.cardTitle} numberOfLines={1}>
                        {room.title && room.title.length > 0
                          ? room.title
                          : humanize(room.room_type)}
                      </Text>
                      <View style={[styles.pill, { backgroundColor: color }]}>
                        <Text style={styles.pillText}>
                          {humanize(room.audience_default)}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.cardMeta}>{humanize(room.room_type)}</Text>
                  </Pressable>
                );
              })}
            </View>
          )}

          <View style={[styles.sectionHeader, styles.sectionSpacer]}>
            <Text style={styles.sectionTitle}>Case team</Text>
          </View>

          {membersQuery.isLoading ? (
            <ActivityIndicator color={Theme.primary} style={styles.inlineLoader} />
          ) : members.length === 0 ? (
            <Text style={styles.emptyText}>No team members yet.</Text>
          ) : (
            <View style={styles.cardList}>
              {members.map((cm) => (
                <View key={cm.id} style={styles.memberRow}>
                  <Text style={styles.memberName}>
                    {cm.member?.full_name ?? "Unknown member"}
                  </Text>
                  <Text style={styles.memberRole}>{humanize(cm.case_role)}</Text>
                </View>
              ))}
            </View>
          )}

          <Pressable
            style={({ pressed }) => [styles.secondary, pressed && styles.secondaryPressed]}
            onPress={() => {
              setInviteError(null);
              setInvite(null);
              setIsInviteOpen(true);
            }}
            testID="invite-guest-button"
          >
            <UserPlus color={Theme.primary} size={18} />
            <Text style={styles.secondaryText}>Invite guest</Text>
          </Pressable>
        </ScrollView>
      )}

      {/* New room form */}
      <Modal
        visible={isRoomFormOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsRoomFormOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.sheet}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>New room</Text>
              <Pressable onPress={() => setIsRoomFormOpen(false)} hitSlop={12}>
                <X color={Theme.textMuted} size={24} />
              </Pressable>
            </View>

            <Text style={styles.label}>Room type</Text>
            <PickerRow options={roomTypes} selected={roomType} onSelect={setRoomType} />

            <Text style={styles.label}>Title (optional)</Text>
            <TextInput
              style={styles.input}
              value={roomTitle}
              onChangeText={setRoomTitle}
              placeholder="e.g. Discharge planning"
              placeholderTextColor={Theme.textMuted}
              testID="room-title-input"
            />

            <Text style={styles.label}>Audience default</Text>
            <PickerRow options={audiences} selected={audience} onSelect={setAudience} />

            {roomError ? <Text style={styles.error}>{roomError}</Text> : null}

            <Pressable
              style={({ pressed }) => [
                styles.primary,
                createRoom.isPending && styles.primaryDisabled,
                pressed && styles.primaryPressed,
              ]}
              onPress={() => {
                if (createRoom.isPending) return;
                setRoomError(null);
                createRoom.mutate();
              }}
              disabled={createRoom.isPending}
              testID="create-room-submit"
            >
              {createRoom.isPending ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.primaryText}>Create room</Text>
              )}
            </Pressable>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* Invite guest form */}
      <Modal
        visible={isInviteOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={closeInvite}
      >
        <KeyboardAvoidingView
          style={styles.sheet}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView contentContainerStyle={styles.sheetContent}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Invite guest</Text>
              <Pressable onPress={closeInvite} hitSlop={12}>
                <X color={Theme.textMuted} size={24} />
              </Pressable>
            </View>

            {invite ? (
              <View style={styles.tokenPanel}>
                <Text style={styles.tokenNote}>
                  This is a one-time link. It can&apos;t be shown again — copy it
                  now. (Guest sign-in surface is coming soon.)
                </Text>
                <View style={styles.tokenBox}>
                  <Text style={styles.tokenText} selectable>
                    {invite.token}
                  </Text>
                </View>
                <Pressable
                  style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
                  onPress={async () => {
                    await Clipboard.setStringAsync(invite.token);
                  }}
                  testID="copy-token-button"
                >
                  <Copy color="#FFFFFF" size={18} />
                  <Text style={styles.primaryText}>Copy link</Text>
                </Pressable>
                <Pressable style={styles.doneButton} onPress={closeInvite}>
                  <Text style={styles.doneText}>Done</Text>
                </Pressable>
              </View>
            ) : (
              <>
                <Text style={styles.label}>Participant role</Text>
                <PickerRow
                  options={participantRoles}
                  selected={inviteRole}
                  onSelect={setInviteRole}
                />

                <Text style={styles.label}>Display label</Text>
                <TextInput
                  style={styles.input}
                  value={inviteLabel}
                  onChangeText={setInviteLabel}
                  placeholder="e.g. Mum, Class teacher"
                  placeholderTextColor={Theme.textMuted}
                  testID="invite-label-input"
                />
                <Text style={styles.hint}>
                  Use a non-identifying label. Never enter a phone number or email.
                </Text>

                {inviteError ? <Text style={styles.error}>{inviteError}</Text> : null}

                <Pressable
                  style={({ pressed }) => [
                    styles.primary,
                    (inviteLabel.trim().length === 0 || createInvite.isPending) &&
                      styles.primaryDisabled,
                    pressed && styles.primaryPressed,
                  ]}
                  onPress={() => {
                    if (inviteLabel.trim().length === 0 || createInvite.isPending) {
                      return;
                    }
                    setInviteError(null);
                    createInvite.mutate();
                  }}
                  disabled={inviteLabel.trim().length === 0 || createInvite.isPending}
                  testID="create-invite-submit"
                >
                  {createInvite.isPending ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <Text style={styles.primaryText}>Create invite</Text>
                  )}
                </Pressable>
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  loader: { marginTop: 60 },
  inlineLoader: { alignSelf: "flex-start", marginVertical: 8 },
  content: { padding: 24, paddingBottom: 48, gap: 12 },
  caseHeader: { marginBottom: 8 },
  patientName: { fontSize: 26, fontWeight: "700", color: Theme.text },
  caseStatus: {
    fontSize: 14,
    color: Theme.textMuted,
    marginTop: 4,
    textTransform: "capitalize",
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionSpacer: { marginTop: 20 },
  sectionTitle: { fontSize: 18, fontWeight: "700", color: Theme.text },
  smallButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  smallButtonPressed: { backgroundColor: Theme.surface },
  smallButtonText: { color: Theme.primary, fontSize: 15, fontWeight: "600" },
  cardList: { gap: 10 },
  card: {
    backgroundColor: Theme.surface,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: Theme.border,
    padding: 16,
  },
  cardPressed: { backgroundColor: Theme.border },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: "600", color: Theme.text, flex: 1 },
  cardMeta: { fontSize: 13, color: Theme.textMuted, marginTop: 6 },
  pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 14,
    paddingHorizontal: 16,
    backgroundColor: Theme.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: Theme.border,
  },
  memberName: { fontSize: 16, color: Theme.text, flex: 1 },
  memberRole: { fontSize: 13, color: Theme.textMuted, textTransform: "capitalize" },
  emptyText: { fontSize: 15, color: Theme.textMuted, paddingVertical: 4 },
  secondary: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 12,
    paddingVertical: 15,
    marginTop: 24,
  },
  secondaryPressed: { backgroundColor: Theme.surface },
  secondaryText: { color: Theme.primary, fontSize: 16, fontWeight: "600" },
  sheet: { flex: 1, backgroundColor: Theme.background },
  sheetContent: { padding: 24, gap: 12, paddingBottom: 48 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 22, fontWeight: "700", color: Theme.text },
  label: { fontSize: 14, fontWeight: "600", color: Theme.text, marginTop: 8 },
  hint: { fontSize: 13, color: Theme.textMuted },
  input: {
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    color: Theme.text,
    backgroundColor: Theme.surface,
  },
  pickerWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  pickerChip: {
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: Theme.surface,
  },
  pickerChipActive: {
    backgroundColor: Theme.primary,
    borderColor: Theme.primary,
  },
  pickerChipText: { fontSize: 14, color: Theme.text },
  pickerChipTextActive: { color: "#FFFFFF", fontWeight: "600" },
  primary: {
    backgroundColor: Theme.primary,
    borderRadius: 12,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 12,
  },
  primaryPressed: { backgroundColor: Theme.primaryPressed },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  error: { color: "#8A1C1C", fontSize: 14, marginTop: 8 },
  tokenPanel: { gap: 12 },
  tokenNote: { fontSize: 14, color: Theme.text, lineHeight: 20 },
  tokenBox: {
    backgroundColor: Theme.surface,
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 12,
    padding: 16,
  },
  tokenText: { fontSize: 14, color: Theme.text, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  doneButton: { alignItems: "center", paddingVertical: 12 },
  doneText: { color: Theme.textMuted, fontSize: 15, fontWeight: "600" },
});
