import { Link } from "expo-router";
import React, { useState } from "react";
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
import { signUp } from "@/lib/auth";

export default function SignUpScreen() {
  const insets = useSafeAreaInsets();
  const [fullName, setFullName] = useState<string>("");
  const [email, setEmail] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  const canSubmit =
    fullName.trim().length > 0 &&
    email.trim().length > 0 &&
    password.length >= 6;

  const onSubmit = async () => {
    if (!canSubmit || isSubmitting) {
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      await signUp(email.trim(), password, fullName.trim());
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : "Could not create your account. Please try again.";
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.brand}>NanoHab Connect</Text>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.subtitle}>
          Set up your organisation and start coordinating cases.
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Full name</Text>
          <TextInput
            style={styles.input}
            value={fullName}
            onChangeText={setFullName}
            autoCapitalize="words"
            autoComplete="name"
            placeholder="Jordan Avery"
            placeholderTextColor={Theme.textMuted}
            testID="full-name-input"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            placeholder="you@clinic.org"
            placeholderTextColor={Theme.textMuted}
            testID="email-input"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="new-password"
            placeholder="At least 6 characters"
            placeholderTextColor={Theme.textMuted}
            testID="password-input"
          />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable
          style={({ pressed }) => [
            styles.button,
            (!canSubmit || isSubmitting) && styles.buttonDisabled,
            pressed && canSubmit && styles.buttonPressed,
          ]}
          onPress={onSubmit}
          disabled={!canSubmit || isSubmitting}
          testID="sign-up-button"
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.buttonText}>Create account</Text>
          )}
        </Pressable>

        <View style={styles.footer}>
          <Text style={styles.footerText}>Already have an account?</Text>
          <Link href="/(auth)/sign-in" style={styles.link}>
            Sign in
          </Link>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: Theme.background },
  content: { paddingHorizontal: 24, gap: 4 },
  brand: {
    fontSize: 15,
    fontWeight: "600",
    color: Theme.primary,
    letterSpacing: 0.2,
  },
  title: {
    fontSize: 30,
    fontWeight: "700",
    color: Theme.text,
    marginTop: 8,
  },
  subtitle: {
    fontSize: 16,
    color: Theme.textMuted,
    marginBottom: 28,
  },
  field: { marginBottom: 18 },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: Theme.text,
    marginBottom: 8,
  },
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
  error: {
    color: "#8A1C1C",
    fontSize: 14,
    marginBottom: 12,
  },
  button: {
    backgroundColor: Theme.primary,
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: "center",
    marginTop: 8,
  },
  buttonPressed: { backgroundColor: Theme.primaryPressed },
  buttonDisabled: { opacity: 0.5 },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  footer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 6,
    marginTop: 28,
  },
  footerText: { color: Theme.textMuted, fontSize: 15 },
  link: { color: Theme.primary, fontSize: 15, fontWeight: "600" },
});
