import { Stack, useRouter } from "expo-router";
import { Settings } from "lucide-react-native";
import React from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";

type CaseItem = { id: string; title: string };

export default function CasesScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const cases: CaseItem[] = [];

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

      <FlatList
        data={cases}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.rowTitle}>{item.title}</Text>
          </View>
        )}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No cases yet.</Text>
          </View>
        }
      />
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
  listContent: { flexGrow: 1, paddingHorizontal: 24 },
  row: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: Theme.border,
  },
  rowTitle: { fontSize: 16, color: Theme.text },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 120,
  },
  emptyText: { fontSize: 16, color: Theme.textMuted },
});
