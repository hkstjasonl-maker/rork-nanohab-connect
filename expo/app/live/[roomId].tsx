import {
  AudioSession,
  LiveKitRoom,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
} from "@livekit/react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ConnectionState, type Participant } from "livekit-client";
import { Mic, MicOff, PhoneOff, Volume2 } from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { supabase } from "@/lib/supabase";

type TokenResponse = {
  token: string;
  url: string;
  room: string;
  identity: string;
};

type FetchState =
  | { status: "loading" }
  | { status: "forbidden" }
  | { status: "error"; message: string }
  | { status: "ready"; data: TokenResponse };

async function fetchRtcToken(roomId: string): Promise<TokenResponse> {
  const baseUrl = process.env.EXPO_PUBLIC_BACKEND_URL;
  if (!baseUrl) {
    throw new Error("Backend URL is not configured.");
  }
  const { data } = await supabase.auth.getSession();
  const accessToken = data.session?.access_token;
  if (!accessToken) {
    throw new Error("You are not signed in.");
  }
  const res = await fetch(
    `${baseUrl.replace(/\/$/, "")}/rtc/token?room_id=${encodeURIComponent(roomId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  );
  if (res.status === 403) {
    const forbidden = new Error("forbidden");
    forbidden.name = "ForbiddenError";
    throw forbidden;
  }
  if (!res.ok) {
    throw new Error(`Could not start the call (status ${res.status}).`);
  }
  return (await res.json()) as TokenResponse;
}

export default function LiveCallScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const router = useRouter();
  const [state, setState] = useState<FetchState>({ status: "loading" });
  const [audioReady, setAudioReady] = useState<boolean>(false);

  const loadToken = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await fetchRtcToken(roomId);
      setState({ status: "ready", data });
    } catch (e) {
      if (e instanceof Error && e.name === "ForbiddenError") {
        setState({ status: "forbidden" });
        return;
      }
      const message =
        e instanceof Error ? e.message : "Could not start the call.";
      console.error("RTC token fetch failed:", message);
      setState({ status: "error", message });
    }
  }, [roomId]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await AudioSession.startAudioSession();
        if (active) {
          setAudioReady(true);
        }
      } catch (e) {
        console.error("Audio session start failed:", e);
      }
    })();
    return () => {
      active = false;
      AudioSession.stopAudioSession().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (roomId) {
      loadToken();
    }
  }, [roomId, loadToken]);

  const handleLeave = useCallback(() => {
    AudioSession.stopAudioSession().catch(() => {});
    router.back();
  }, [router]);

  if (state.status === "loading" || !audioReady) {
    return (
      <Centered>
        <ActivityIndicator color={Theme.primary} size="large" />
        <Text style={styles.statusText}>Connecting…</Text>
      </Centered>
    );
  }

  if (state.status === "forbidden") {
    return (
      <Centered>
        <Text style={styles.title}>No access</Text>
        <Text style={styles.subtitle}>
          You don&apos;t have access to this room&apos;s call.
        </Text>
        <Pressable style={styles.backButton} onPress={handleLeave}>
          <Text style={styles.backButtonText}>Go back</Text>
        </Pressable>
      </Centered>
    );
  }

  if (state.status === "error") {
    return (
      <Centered>
        <Text style={styles.title}>Couldn&apos;t connect</Text>
        <Text style={styles.subtitle}>{state.message}</Text>
        <Pressable style={styles.backButton} onPress={loadToken}>
          <Text style={styles.backButtonText}>Try again</Text>
        </Pressable>
        <Pressable style={styles.linkButton} onPress={handleLeave}>
          <Text style={styles.linkButtonText}>Go back</Text>
        </Pressable>
      </Centered>
    );
  }

  return (
    <LiveKitRoom
      serverUrl={state.data.url}
      token={state.data.token}
      connect={true}
      audio={true}
      video={false}
      onDisconnected={handleLeave}
    >
      <CallContents onLeave={handleLeave} />
    </LiveKitRoom>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <View style={styles.fill}>
      <StatusBar barStyle="light-content" />
      <View style={styles.centered}>{children}</View>
    </View>
  );
}

function connectionLabel(state: ConnectionState): string {
  switch (state) {
    case ConnectionState.Connecting:
      return "Connecting…";
    case ConnectionState.Connected:
      return "Connected";
    case ConnectionState.Reconnecting:
      return "Reconnecting…";
    case ConnectionState.Disconnected:
      return "Disconnected";
    default:
      return "Connecting…";
  }
}

function CallContents({ onLeave }: { onLeave: () => void }) {
  const insets = useSafeAreaInsets();
  const participants = useParticipants();
  const connectionState = useConnectionState();
  const { localParticipant, isMicrophoneEnabled } = useLocalParticipant();

  const toggleMic = useCallback(() => {
    const next = !isMicrophoneEnabled;
    localParticipant.setMicrophoneEnabled(next).catch((e: unknown) => {
      console.error("Toggle mic failed:", e);
    });
  }, [isMicrophoneEnabled, localParticipant]);

  const status = useMemo(
    () => connectionLabel(connectionState),
    [connectionState],
  );

  return (
    <View style={styles.fill}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.callTop, { paddingTop: insets.top + 24 }]}>
        <View style={styles.statusPill}>
          <Volume2 color={Theme.surface} size={14} />
          <Text style={styles.statusPillText}>{status}</Text>
        </View>
        <Text style={styles.callHeading}>Live voice</Text>
      </View>

      <View style={styles.participantList}>
        {participants.map((p: Participant) => (
          <View key={p.sid} style={styles.participantRow}>
            <View
              style={[
                styles.speakingDot,
                p.isSpeaking && styles.speakingDotActive,
              ]}
            />
            <Text style={styles.participantName}>
              {p.name && p.name.length > 0 ? p.name : p.identity}
            </Text>
            {p.isSpeaking ? (
              <Text style={styles.speakingLabel}>Speaking</Text>
            ) : null}
          </View>
        ))}
        {participants.length === 0 ? (
          <Text style={styles.subtitle}>Waiting for others to join…</Text>
        ) : null}
      </View>

      <View style={[styles.controls, { paddingBottom: insets.bottom + 32 }]}>
        <Pressable
          style={[styles.micButton, !isMicrophoneEnabled && styles.micButtonOff]}
          onPress={toggleMic}
          testID="mute-toggle"
        >
          {isMicrophoneEnabled ? (
            <Mic color={Theme.surface} size={30} />
          ) : (
            <MicOff color={Theme.surface} size={30} />
          )}
          <Text style={styles.micLabel}>
            {isMicrophoneEnabled ? "Mute" : "Unmute"}
          </Text>
        </Pressable>

        <Pressable
          style={styles.leaveButton}
          onPress={onLeave}
          testID="leave-button"
        >
          <PhoneOff color="#FFFFFF" size={30} />
          <Text style={styles.leaveLabel}>Leave</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#0C1512" },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 16,
  },
  statusText: { fontSize: 16, color: Theme.surface },
  title: { fontSize: 22, fontWeight: "700", color: "#FFFFFF" },
  subtitle: {
    fontSize: 15,
    color: "#AEB8B3",
    textAlign: "center",
    lineHeight: 22,
  },
  backButton: {
    marginTop: 8,
    backgroundColor: Theme.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  backButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  linkButton: { paddingVertical: 8 },
  linkButtonText: { color: "#AEB8B3", fontSize: 15 },
  callTop: { alignItems: "center", gap: 14, paddingHorizontal: 24 },
  statusPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 16,
  },
  statusPillText: { color: Theme.surface, fontSize: 13, fontWeight: "600" },
  callHeading: { color: "#FFFFFF", fontSize: 24, fontWeight: "700" },
  participantList: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    paddingHorizontal: 24,
  },
  participantRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "rgba(255,255,255,0.06)",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 16,
    minWidth: 220,
  },
  speakingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#3A453F",
  },
  speakingDotActive: { backgroundColor: Theme.primary },
  participantName: { color: "#FFFFFF", fontSize: 17, fontWeight: "500", flex: 1 },
  speakingLabel: { color: Theme.coral, fontSize: 13, fontWeight: "600" },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 28,
    paddingTop: 24,
  },
  micButton: {
    width: 96,
    alignItems: "center",
    gap: 8,
    backgroundColor: Theme.primary,
    paddingVertical: 18,
    borderRadius: 24,
  },
  micButtonOff: { backgroundColor: "#3A453F" },
  micLabel: { color: Theme.surface, fontSize: 14, fontWeight: "600" },
  leaveButton: {
    width: 96,
    alignItems: "center",
    gap: 8,
    backgroundColor: "#C2553D",
    paddingVertical: 18,
    borderRadius: 24,
  },
  leaveLabel: { color: "#FFFFFF", fontSize: 14, fontWeight: "600" },
});
