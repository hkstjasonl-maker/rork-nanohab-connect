import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  isTrackReference,
  useConnectionState,
  useLocalParticipant,
  useParticipants,
  useTracks,
} from "@livekit/react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import {
  ConnectionState,
  Track,
  type Participant,
} from "livekit-client";
import {
  Mic,
  MicOff,
  PhoneOff,
  Video,
  VideoOff,
  Volume2,
  XOctagon,
} from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
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

type LiveSession = {
  id: string;
  room_id: string;
  status: string;
  recording_enabled: boolean;
  ai_minutes_enabled: boolean;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  livekit_room: string;
};

type Stage =
  | { kind: "prejoin" }
  | { kind: "starting" }
  | { kind: "consent"; session: LiveSession }
  | { kind: "tokenLoading"; session: LiveSession }
  | { kind: "forbidden" }
  | { kind: "error"; message: string; retry: "start" | "token"; session?: LiveSession }
  | { kind: "ready"; session: LiveSession; token: TokenResponse };

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

async function startLiveSession(
  roomId: string,
  recording: boolean,
): Promise<LiveSession> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/start?room_id=${encodeURIComponent(roomId)}&recording=${recording}&ai_minutes=${recording}`,
    { method: "POST", headers },
  );
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (!res.ok) {
    throw new Error(`Could not start the session (status ${res.status}).`);
  }
  const body = (await res.json()) as { session: LiveSession };
  return body.session;
}

async function sendConsent(sessionId: string): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/consent?session_id=${encodeURIComponent(sessionId)}&recording=true&ai=true&text_version=v1`,
    { method: "POST", headers },
  );
  if (!res.ok) {
    throw new Error(`Could not record consent (status ${res.status}).`);
  }
}

async function endLiveSession(sessionId: string): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/end?session_id=${encodeURIComponent(sessionId)}`,
    { method: "POST", headers },
  );
  if (!res.ok) {
    throw new Error(`Could not end the session (status ${res.status}).`);
  }
}

async function fetchRtcToken(roomId: string): Promise<TokenResponse> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/token?room_id=${encodeURIComponent(roomId)}`,
    { method: "GET", headers },
  );
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (!res.ok) {
    throw new Error(`Could not start the call (status ${res.status}).`);
  }
  return (await res.json()) as TokenResponse;
}

export default function LiveCallScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "prejoin" });
  const [recordForAi, setRecordForAi] = useState<boolean>(false);
  const [audioReady, setAudioReady] = useState<boolean>(false);

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

  const handleLeave = useCallback(() => {
    AudioSession.stopAudioSession().catch(() => {});
    router.back();
  }, [router]);

  const loadToken = useCallback(
    async (session: LiveSession) => {
      setStage({ kind: "tokenLoading", session });
      try {
        const token = await fetchRtcToken(roomId);
        setStage({ kind: "ready", session, token });
      } catch (e) {
        if (e instanceof ForbiddenError) {
          setStage({ kind: "forbidden" });
          return;
        }
        const message =
          e instanceof Error ? e.message : "Could not start the call.";
        console.error("RTC token fetch failed:", message);
        setStage({ kind: "error", message, retry: "token", session });
      }
    },
    [roomId],
  );

  const handleJoin = useCallback(async () => {
    setStage({ kind: "starting" });
    try {
      const session = await startLiveSession(roomId, recordForAi);
      if (session.recording_enabled) {
        setStage({ kind: "consent", session });
        return;
      }
      await loadToken(session);
    } catch (e) {
      if (e instanceof ForbiddenError) {
        setStage({ kind: "forbidden" });
        return;
      }
      const message =
        e instanceof Error ? e.message : "Could not start the session.";
      console.error("Start session failed:", message);
      setStage({ kind: "error", message, retry: "start" });
    }
  }, [roomId, recordForAi, loadToken]);

  const handleConsent = useCallback(
    async (session: LiveSession) => {
      setStage({ kind: "tokenLoading", session });
      try {
        await sendConsent(session.id);
        await loadToken(session);
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Could not record consent.";
        console.error("Consent failed:", message);
        setStage({ kind: "error", message, retry: "token", session });
      }
    },
    [loadToken],
  );

  const handleEndSession = useCallback(
    (session: LiveSession) => {
      Alert.alert(
        "End session for everyone?",
        "This ends the live session for all participants.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "End session",
            style: "destructive",
            onPress: () => {
              endLiveSession(session.id)
                .catch((e) => console.error("End session failed:", e))
                .finally(handleLeave);
            },
          },
        ],
      );
    },
    [handleLeave],
  );

  if (!audioReady || stage.kind === "starting" || stage.kind === "tokenLoading") {
    return (
      <Centered>
        <ActivityIndicator color={Theme.primary} size="large" />
        <Text style={styles.statusText}>
          {stage.kind === "starting" ? "Starting session…" : "Connecting…"}
        </Text>
      </Centered>
    );
  }

  if (stage.kind === "prejoin") {
    return (
      <Centered>
        <View style={styles.card}>
          <Text style={styles.cardHeading}>Join live session</Text>
          <View style={styles.switchRow}>
            <View style={styles.switchTextWrap}>
              <Text style={styles.switchLabel}>Record for AI minutes</Text>
              <Text style={styles.switchCaption}>
                All participants will be asked to consent.
              </Text>
            </View>
            <Switch
              value={recordForAi}
              onValueChange={setRecordForAi}
              trackColor={{ false: "#3A453F", true: Theme.primary }}
              thumbColor="#FFFFFF"
            />
          </View>
          <Pressable
            style={styles.primaryButton}
            onPress={handleJoin}
            testID="prejoin-join"
          >
            <Text style={styles.primaryButtonText}>Join session</Text>
          </Pressable>
          <Pressable
            style={styles.linkButton}
            onPress={handleLeave}
            testID="prejoin-cancel"
          >
            <Text style={styles.linkButtonText}>Cancel</Text>
          </Pressable>
        </View>
      </Centered>
    );
  }

  if (stage.kind === "consent") {
    const session = stage.session;
    return (
      <Centered>
        <View style={styles.card}>
          <Text style={styles.cardHeading}>Recording consent</Text>
          <Text style={styles.cardBody}>
            This session is being recorded to produce AI meeting minutes. Your
            participation is recorded only after you consent.
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => handleConsent(session)}
            testID="consent-accept"
          >
            <Text style={styles.primaryButtonText}>I consent and join</Text>
          </Pressable>
          <Pressable
            style={styles.linkButton}
            onPress={handleLeave}
            testID="consent-leave"
          >
            <Text style={styles.linkButtonText}>Leave</Text>
          </Pressable>
        </View>
      </Centered>
    );
  }

  if (stage.kind === "forbidden") {
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

  if (stage.kind === "error") {
    const retry =
      stage.retry === "token" && stage.session
        ? () => loadToken(stage.session as LiveSession)
        : handleJoin;
    return (
      <Centered>
        <Text style={styles.title}>Couldn&apos;t connect</Text>
        <Text style={styles.subtitle}>{stage.message}</Text>
        <Pressable style={styles.backButton} onPress={retry}>
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
      serverUrl={stage.token.url}
      token={stage.token.token}
      connect={true}
      audio={true}
      video={false}
      onDisconnected={handleLeave}
    >
      <CallContents
        tokenIdentity={stage.token.identity}
        session={stage.session}
        onLeave={handleLeave}
        onEndSession={() => handleEndSession(stage.session)}
      />
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

function initialsFor(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function CallContents({
  tokenIdentity,
  session,
  onLeave,
  onEndSession,
}: {
  tokenIdentity: string;
  session: LiveSession;
  onLeave: () => void;
  onEndSession: () => void;
}) {
  const insets = useSafeAreaInsets();
  const participants = useParticipants();
  const connectionState = useConnectionState();
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled } =
    useLocalParticipant();
  const cameraTracks = useTracks([Track.Source.Camera]);

  const toggleMic = useCallback(() => {
    const next = !isMicrophoneEnabled;
    localParticipant.setMicrophoneEnabled(next).catch((e: unknown) => {
      console.error("Toggle mic failed:", e);
    });
  }, [isMicrophoneEnabled, localParticipant]);

  const toggleCamera = useCallback(() => {
    const next = !isCameraEnabled;
    localParticipant.setCameraEnabled(next).catch((e: unknown) => {
      console.error("Toggle camera failed:", e);
    });
  }, [isCameraEnabled, localParticipant]);

  const status = useMemo(
    () => connectionLabel(connectionState),
    [connectionState],
  );

  const canEnd = tokenIdentity === session.started_by;
  const count = participants.length;
  const oneColumn = count <= 2;
  const isScroll = count > 4;

  const tiles = participants.map((p: Participant) => {
    const found = cameraTracks.find((t) => t.participant.sid === p.sid);
    const trackRef =
      found && isTrackReference(found) && !found.publication.isMuted
        ? found
        : undefined;
    return (
      <ParticipantTile
        key={p.sid}
        participant={p}
        trackRef={trackRef}
        fullWidth={oneColumn}
      />
    );
  });

  const grid =
    count === 0 ? (
      <View style={styles.waitingWrap}>
        <Text style={styles.subtitle}>Waiting for others to join…</Text>
      </View>
    ) : isScroll ? (
      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={styles.gridContent}
        showsVerticalScrollIndicator={false}
      >
        {tiles}
      </ScrollView>
    ) : (
      <View style={styles.gridFill}>{tiles}</View>
    );

  return (
    <View style={styles.fill}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.callTop, { paddingTop: insets.top + 16 }]}>
        <View style={styles.statusPill}>
          <Volume2 color={Theme.surface} size={14} />
          <Text style={styles.statusPillText}>{status}</Text>
        </View>
      </View>

      {grid}

      <View style={[styles.controls, { paddingBottom: insets.bottom + 24 }]}>
        <Pressable
          style={[styles.ctrlButton, !isMicrophoneEnabled && styles.ctrlOff]}
          onPress={toggleMic}
          testID="mute-toggle"
        >
          {isMicrophoneEnabled ? (
            <Mic color={Theme.surface} size={26} />
          ) : (
            <MicOff color={Theme.surface} size={26} />
          )}
          <Text style={styles.ctrlLabel}>
            {isMicrophoneEnabled ? "Mute" : "Unmute"}
          </Text>
        </Pressable>

        <Pressable
          style={[styles.ctrlButton, !isCameraEnabled && styles.ctrlOff]}
          onPress={toggleCamera}
          testID="camera-toggle"
        >
          {isCameraEnabled ? (
            <Video color={Theme.surface} size={26} />
          ) : (
            <VideoOff color={Theme.surface} size={26} />
          )}
          <Text style={styles.ctrlLabel}>Camera</Text>
        </Pressable>

        {canEnd ? (
          <Pressable
            style={styles.endButton}
            onPress={onEndSession}
            testID="end-session"
          >
            <XOctagon color="#FFFFFF" size={26} />
            <Text style={styles.endLabel}>End</Text>
          </Pressable>
        ) : null}

        <Pressable
          style={styles.leaveButton}
          onPress={onLeave}
          testID="leave-button"
        >
          <PhoneOff color="#FFFFFF" size={26} />
          <Text style={styles.leaveLabel}>Leave</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ParticipantTile({
  participant,
  trackRef,
  fullWidth,
}: {
  participant: Participant;
  trackRef: React.ComponentProps<typeof VideoTrack>["trackRef"];
  fullWidth: boolean;
}) {
  const label =
    participant.name && participant.name.length > 0
      ? participant.name
      : participant.identity;
  const hasVideo = trackRef != null;
  const micOff = !participant.isMicrophoneEnabled;

  return (
    <View
      style={[
        styles.tile,
        fullWidth ? styles.tileFull : styles.tileHalf,
        participant.isSpeaking && styles.tileSpeaking,
      ]}
    >
      {hasVideo ? (
        <VideoTrack
          trackRef={trackRef}
          style={styles.tileVideo}
          objectFit="cover"
        />
      ) : (
        <View style={styles.tileNameWrap}>
          <View style={styles.avatarCircle}>
            <Text style={styles.avatarText}>{initialsFor(label)}</Text>
          </View>
          <Text style={styles.tileName} numberOfLines={1}>
            {label}
          </Text>
        </View>
      )}

      <View style={styles.tileFooter}>
        {micOff ? <MicOff color="#FFFFFF" size={14} /> : null}
        {participant.isSpeaking ? (
          <Text style={styles.speakingLabel}>Speaking</Text>
        ) : null}
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
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 20,
    padding: 24,
    gap: 18,
  },
  cardHeading: { color: "#FFFFFF", fontSize: 22, fontWeight: "700" },
  cardBody: { color: "#C7D0CB", fontSize: 15, lineHeight: 22 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
  },
  switchTextWrap: { flex: 1, gap: 4 },
  switchLabel: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  switchCaption: { color: "#AEB8B3", fontSize: 13, lineHeight: 18 },
  primaryButton: {
    backgroundColor: Theme.primary,
    paddingVertical: 14,
    borderRadius: 24,
    alignItems: "center",
  },
  primaryButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  backButton: {
    marginTop: 8,
    backgroundColor: Theme.primary,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
  },
  backButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "600" },
  linkButton: { paddingVertical: 8, alignItems: "center" },
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
  waitingWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  gridFill: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    alignContent: "center",
    justifyContent: "center",
    gap: 12,
    padding: 16,
  },
  gridScroll: { flex: 1 },
  gridContent: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 12,
    padding: 16,
  },
  tile: {
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 2,
    borderColor: "transparent",
    overflow: "hidden",
    minHeight: 160,
    flexGrow: 1,
  },
  tileFull: { width: "100%" },
  tileHalf: { width: "47%" },
  tileSpeaking: { borderColor: Theme.primary },
  tileVideo: { flex: 1, backgroundColor: "#000000" },
  tileNameWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 12,
  },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "rgba(15,110,86,0.35)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  avatarText: { color: "#FFFFFF", fontSize: 24, fontWeight: "700" },
  tileName: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
  },
  tileFooter: {
    position: "absolute",
    left: 10,
    bottom: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  speakingLabel: { color: Theme.coral, fontSize: 13, fontWeight: "600" },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    paddingTop: 20,
    paddingHorizontal: 16,
  },
  ctrlButton: {
    minWidth: 76,
    alignItems: "center",
    gap: 6,
    backgroundColor: Theme.primary,
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderRadius: 22,
  },
  ctrlOff: { backgroundColor: "#3A453F" },
  ctrlLabel: { color: Theme.surface, fontSize: 13, fontWeight: "600" },
  endButton: {
    minWidth: 76,
    alignItems: "center",
    gap: 6,
    backgroundColor: "#B23A2E",
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderRadius: 22,
  },
  endLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  leaveButton: {
    minWidth: 76,
    alignItems: "center",
    gap: 6,
    backgroundColor: "#C2553D",
    paddingVertical: 16,
    paddingHorizontal: 8,
    borderRadius: 22,
  },
  leaveLabel: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
});
