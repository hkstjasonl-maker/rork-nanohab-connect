import { useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Theme } from "@/constants/colors";
import { signOut } from "@/lib/auth";
import { getCurrentMemberId } from "@/lib/member";
import { supabase } from "@/lib/supabase";
import { ChevronRight } from "lucide-react-native";

type MemberProfile = {
  fullName: string;
  organizationName: string;
};

async function fetchMemberProfile(): Promise<MemberProfile | null> {
  const memberId = await getCurrentMemberId();
  if (!memberId) {
    return null;
  }

  const { data, error } = await supabase
    .from("members")
    .select("full_name, organizations(name)")
    .eq("id", memberId)
    .maybeSingle();

  if (error) {
    throw error;
  }
  if (!data) {
    return null;
  }

  const org = data.organizations as { name: string } | { name: string }[] | null;
  const organizationName = Array.isArray(org)
    ? org[0]?.name ?? ""
    : org?.name ?? "";

  return {
    fullName: data.full_name ?? "",
    organizationName,
  };
}

export default function SettingsScreen() {
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState<boolean>(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["member-profile"],
    queryFn: fetchMemberProfile,
  });

  const onSignOut = async () => {
    if (isSigningOut) {
      return;
    }
    setIsSigningOut(true);
    try {
      await signOut();
      router.replace("/(auth)/sign-in");
    } catch (e) {
      console.error("Sign out failed:", e);
      setIsSigningOut(false);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
    >
      <Stack.Screen options={{ title: "Settings" }} />

      {isLoading ? (
        <ActivityIndicator color={Theme.primary} style={styles.loader} />
      ) : isError ? (
        <Text style={styles.muted}>Could not load your profile.</Text>
      ) : (
        <View style={styles.card}>
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Full name</Text>
            <Text style={styles.value}>{data?.fullName ?? "—"}</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.fieldGroup}>
            <Text style={styles.label}>Organisation</Text>
            <Text style={styles.value}>{data?.organizationName ?? "—"}</Text>
          </View>
        </View>
      )}

      <Pressable
        style={({ pressed }) => [styles.navRow, pressed && styles.navRowPressed]}
        onPress={() => router.push("/branding")}
      >
        <Text style={styles.navRowText}>Practice profiles</Text>
        <ChevronRight size={20} color={Theme.textMuted} />
      </Pressable>
      <Pressable
        style={({ pressed }) => [
          styles.signOut,
          pressed && styles.signOutPressed,
        ]}
        onPress={onSignOut}
        disabled={isSigningOut}
        testID="sign-out-button"
      >
        {isSigningOut ? (
          <ActivityIndicator color={Theme.primary} />
        ) : (
          <Text style={styles.signOutText}>Sign out</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.background },
  content: { padding: 24, gap: 24 },
  loader: { marginTop: 40 },
  muted: { color: Theme.textMuted, fontSize: 15, marginTop: 24 },
  card: {
    backgroundColor: Theme.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: Theme.border,
    paddingHorizontal: 20,
  },
  fieldGroup: { paddingVertical: 18 },
  label: {
    fontSize: 13,
    fontWeight: "600",
    color: Theme.textMuted,
    marginBottom: 6,
  },
  value: { fontSize: 17, color: Theme.text },
  divider: { height: 1, backgroundColor: Theme.border },
  navRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: Theme.border, borderRadius: 12, paddingVertical: 16, paddingHorizontal: 18 },
  navRowPressed: { backgroundColor: Theme.surface },
  navRowText: { color: Theme.text, fontSize: 16, fontWeight: "600" },
  signOut: {
    borderWidth: 1,
    borderColor: Theme.border,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
  },
  signOutPressed: { backgroundColor: Theme.surface },
  signOutText: { color: Theme.primary, fontSize: 16, fontWeight: "600" },
});
