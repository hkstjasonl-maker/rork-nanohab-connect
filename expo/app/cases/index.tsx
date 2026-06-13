import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { Plus, Settings, X } from "lucide-react-native";
import React, { useState } from "react";
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
import { supabase } from "@/lib/supabase";

type CaseStatus = "active" | "archived" | "closed";

type CaseRow = {
  id: string;
  patient_display_name: string | null;
  status: CaseStatus | null;
  created_at: string;
};

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const day = 24 * 60 * 60 * 1000;
  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) {
    const m = Math.round(diff / (60 * 1000));
    return `${m} min ago`;
  }
  if (diff < day) {
    const h = Math.round(diff / (60 * 60 * 1000));
    return `${h} hr ago`;
  }
  if (diff < 7 * day) {
    const d = Math.round(diff / day);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(iso).toLocaleDateString();
}

const statusColors: Record<CaseStatus, string> = {
  active: Theme.primary,
  archived: Theme.grey,
  closed: Theme.textMuted,
};

async function fetchCases(): Promise<CaseRow[]> {
  const { data, error } = await supabase
    .from("cases")
    .select("id, patient_display_name, status, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    throw error;
  }
  return (data ?? []) as CaseRow[];
}

function StatusChip({ status }: { status: CaseStatus | null }) {
  if (!status) {
    return null;
  }
  const color = statusColors[status] ?? Theme.grey;
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={[styles.chipText, { color }]}>{status}</Text>
    </View>
  );
}

export default function CasesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isFormOpen, setIsFormOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>("");
  const [formError, setFormError] = useState<string | null>(null);

  const { data: cases, isLoading, isError, refetch, isRefetching } = useQuery({
    queryKey: ["cases"],
    queryFn: fetchCases,
  });

  const createCase = useMutation({
    mutationFn: async (patientName: string): Promise<CaseRow> => {
      const { data, error } = await supabase.rpc("create_case", {
        p_patient_display_name: patientName,
      });
      if (error) {
        throw error;
      }
      const row = Array.isArray(data) ? data[0] : data;
      return row as CaseRow;
    },
    onSuccess: (row) => {
      queryClient.invalidateQueries({ queryKey: ["cases"] });
      setIsFormOpen(false);
      setName("");
      if (row?.id) {
        router.push(`/cases/${row.id}`);
      }
    },
    onError: (e) => {
      setFormError(
        e instanceof Error ? e.message : "Could not create the case.",
      );
    },
  });

  const onSubmit = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || createCase.isPending) {
      return;
    }
    setFormError(null);
    createCase.mutate(trimmed);
  };

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Text style={styles.heading}>Cases</Text>
        <Pressable
          onPress={() => router.push("/settings")}
          hitSlop={12}
          style={({ pressed }) => [styles.iconButton, pressed && styles.iconPressed]}
          testID="settings-button"
        >
          <Settings color={Theme.text} size={22} />
        </Pressable>
      </View>

      {isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : isError ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Could not load cases.</Text>
          <Pressable style={styles.retry} onPress={() => refetch()}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={cases ?? []}
          keyExtractor={(item) => item.id}
          refreshing={isRefetching}
          onRefresh={refetch}
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/cases/${item.id}`)}
              testID={`case-${item.id}`}
            >
              <View style={styles.cardTop}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {item.patient_display_name ?? "Unnamed patient"}
                </Text>
                <StatusChip status={item.status} />
              </View>
              <Text style={styles.cardDate}>{relativeDate(item.created_at)}</Text>
            </Pressable>
          )}
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No cases yet</Text>
              <Text style={styles.emptyText}>Create your first case.</Text>
            </View>
          }
        />
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
        <Pressable
          style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
          onPress={() => {
            setFormError(null);
            setName("");
            setIsFormOpen(true);
          }}
          testID="new-case-button"
        >
          <Plus color="#FFFFFF" size={20} />
          <Text style={styles.primaryText}>New case</Text>
        </Pressable>
      </View>

      <Modal
        visible={isFormOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setIsFormOpen(false)}
      >
        <KeyboardAvoidingView
          style={styles.sheet}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>New case</Text>
            <Pressable onPress={() => setIsFormOpen(false)} hitSlop={12}>
              <X color={Theme.textMuted} size={24} />
            </Pressable>
          </View>
          <Text style={styles.label}>Patient display name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. J. Doe"
            placeholderTextColor={Theme.textMuted}
            autoFocus
            testID="patient-name-input"
          />
          {formError ? <Text style={styles.error}>{formError}</Text> : null}
          <Pressable
            style={({ pressed }) => [
              styles.primary,
              styles.sheetSubmit,
              (name.trim().length === 0 || createCase.isPending) &&
                styles.primaryDisabled,
              pressed && styles.primaryPressed,
            ]}
            onPress={onSubmit}
            disabled={name.trim().length === 0 || createCase.isPending}
            testID="create-case-submit"
          >
            {createCase.isPending ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryText}>Create case</Text>
            )}
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingBottom: 12,
  },
  heading: { fontSize: 32, fontWeight: "700", color: Theme.text },
  iconButton: { padding: 6, borderRadius: 10 },
  iconPressed: { backgroundColor: Theme.surface },
  loader: { marginTop: 60 },
  listContent: { flexGrow: 1, paddingHorizontal: 24, paddingBottom: 24, gap: 12 },
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
  cardTitle: { fontSize: 17, fontWeight: "600", color: Theme.text, flex: 1 },
  cardDate: { fontSize: 13, color: Theme.textMuted, marginTop: 6 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  chipText: { fontSize: 12, fontWeight: "600", textTransform: "capitalize" },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 120,
    gap: 6,
  },
  emptyTitle: { fontSize: 18, fontWeight: "600", color: Theme.text },
  emptyText: { fontSize: 15, color: Theme.textMuted },
  retry: { marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 },
  retryText: { color: Theme.primary, fontSize: 15, fontWeight: "600" },
  footer: {
    paddingHorizontal: 24,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: Theme.border,
    backgroundColor: Theme.background,
  },
  primary: {
    backgroundColor: Theme.primary,
    borderRadius: 12,
    paddingVertical: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  primaryPressed: { backgroundColor: Theme.primaryPressed },
  primaryDisabled: { opacity: 0.5 },
  primaryText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  sheet: { flex: 1, backgroundColor: Theme.background, padding: 24, gap: 12 },
  sheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  sheetTitle: { fontSize: 22, fontWeight: "700", color: Theme.text },
  sheetSubmit: { marginTop: 8 },
  label: { fontSize: 14, fontWeight: "600", color: Theme.text },
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
  error: { color: "#8A1C1C", fontSize: 14 },
});
