import {
  AudioSession,
  LiveKitRoom,
  VideoTrack,
  isTrackReference,
  useConnectionState,
  useDataChannel,
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
  BarChart3,
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Plus,
  Send,
  Video,
  VideoOff,
  Volume2,
  X,
  XOctagon,
} from "lucide-react-native";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Theme } from "@/constants/colors";
import { getCurrentMemberId } from "@/lib/member";
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
  waiting_room_enabled: boolean;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  livekit_room: string;
};

type PendingPerson = {
  member_id: string;
  full_name: string;
  requested_at: string;
};

type JoinStatus = "admitted" | "pending" | "denied";

type HandPayload = {
  t: string;
  raised: boolean;
  identity: string;
  name?: string;
};

type ChatRow = {
  id: string;
  body: string | null;
  kind: string;
  created_at: string;
  author_member_id: string | null;
  author: { full_name: string | null } | null;
};

type PollRow = {
  id: string;
  question: string;
  options: string[];
  status: string;
  created_by: string;
};

type PollVote = {
  option_index: number;
  member_id: string;
};

const CHAT_SELECT =
  "id, body, kind, created_at, author_member_id, author:members!author_member_id(full_name)";

type Stage =
  | { kind: "prejoin" }
  | { kind: "starting" }
  | { kind: "admitting"; session: LiveSession }
  | { kind: "consent"; session: LiveSession }
  | { kind: "waiting"; session: LiveSession }
  | { kind: "declined" }
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
  waitingRoom: boolean,
): Promise<LiveSession> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/start?room_id=${encodeURIComponent(roomId)}&recording=${recording}&ai_minutes=${recording}&waiting_room=${waitingRoom}`,
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

async function fetchRtcToken(
  roomId: string,
): Promise<TokenResponse | "pending"> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/token?room_id=${encodeURIComponent(roomId)}`,
    { method: "GET", headers },
  );
  if (res.status === 202) {
    return "pending";
  }
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (!res.ok) {
    throw new Error(`Could not start the call (status ${res.status}).`);
  }
  return (await res.json()) as TokenResponse;
}

async function requestJoin(sessionId: string): Promise<JoinStatus> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/join-request?session_id=${encodeURIComponent(sessionId)}`,
    { method: "POST", headers },
  );
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (!res.ok) {
    throw new Error(`Could not request admission (status ${res.status}).`);
  }
  const body = (await res.json()) as { status: JoinStatus };
  return body.status;
}

async function fetchAdmissions(sessionId: string): Promise<PendingPerson[]> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/admissions?session_id=${encodeURIComponent(sessionId)}`,
    { method: "GET", headers },
  );
  if (!res.ok) {
    throw new Error(`Could not load admissions (status ${res.status}).`);
  }
  const body = (await res.json()) as { pending: PendingPerson[] };
  return body.pending ?? [];
}

async function admitMember(
  sessionId: string,
  memberId: string,
): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/admit?session_id=${encodeURIComponent(sessionId)}&member_id=${encodeURIComponent(memberId)}`,
    { method: "POST", headers },
  );
  if (!res.ok) {
    throw new Error(`Could not admit (status ${res.status}).`);
  }
}

async function denyMember(
  sessionId: string,
  memberId: string,
): Promise<void> {
  const headers = await authHeader();
  const res = await fetch(
    `${backendBase()}/rtc/deny?session_id=${encodeURIComponent(sessionId)}&member_id=${encodeURIComponent(memberId)}`,
    { method: "POST", headers },
  );
  if (!res.ok) {
    throw new Error(`Could not deny (status ${res.status}).`);
  }
}

export default function LiveCallScreen() {
  const { roomId } = useLocalSearchParams<{ roomId: string }>();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>({ kind: "prejoin" });
  const [recordForAi, setRecordForAi] = useState<boolean>(false);
  const [waitingRoom, setWaitingRoom] = useState<boolean>(false);
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
        if (token === "pending") {
          setStage({ kind: "waiting", session });
          return;
        }
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

  const enterSession = useCallback(
    async (session: LiveSession) => {
      if (!session.waiting_room_enabled) {
        await loadToken(session);
        return;
      }
      setStage({ kind: "admitting", session });
      try {
        const status = await requestJoin(session.id);
        if (status === "admitted") {
          await loadToken(session);
          return;
        }
        if (status === "denied") {
          setStage({ kind: "declined" });
          return;
        }
        setStage({ kind: "waiting", session });
      } catch (e) {
        if (e instanceof ForbiddenError) {
          setStage({ kind: "forbidden" });
          return;
        }
        const message =
          e instanceof Error ? e.message : "Could not request admission.";
        console.error("Join request failed:", message);
        setStage({ kind: "error", message, retry: "token", session });
      }
    },
    [loadToken],
  );

  const handleJoin = useCallback(async () => {
    setStage({ kind: "starting" });
    try {
      const session = await startLiveSession(roomId, recordForAi, waitingRoom);
      if (session.recording_enabled) {
        setStage({ kind: "consent", session });
        return;
      }
      await enterSession(session);
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
  }, [roomId, recordForAi, waitingRoom, enterSession]);

  const handleConsent = useCallback(
    async (session: LiveSession) => {
      setStage({ kind: "tokenLoading", session });
      try {
        await sendConsent(session.id);
        await enterSession(session);
      } catch (e) {
        const message =
          e instanceof Error ? e.message : "Could not record consent.";
        console.error("Consent failed:", message);
        setStage({ kind: "error", message, retry: "token", session });
      }
    },
    [enterSession],
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

  if (
    !audioReady ||
    stage.kind === "starting" ||
    stage.kind === "admitting" ||
    stage.kind === "tokenLoading"
  ) {
    return (
      <Centered>
        <ActivityIndicator color={Theme.primary} size="large" />
        <Text style={styles.statusText}>
          {stage.kind === "starting"
            ? "Starting session…"
            : stage.kind === "admitting"
              ? "Requesting to join…"
              : "Connecting…"}
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
          <View style={styles.switchRow}>
            <View style={styles.switchTextWrap}>
              <Text style={styles.switchLabel}>
                Waiting room (admit each person)
              </Text>
              <Text style={styles.switchCaption}>
                You&apos;ll approve each person before they can join.
              </Text>
            </View>
            <Switch
              value={waitingRoom}
              onValueChange={setWaitingRoom}
              trackColor={{ false: "#3A453F", true: Theme.primary }}
              thumbColor="#FFFFFF"
              testID="prejoin-waiting-toggle"
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

  if (stage.kind === "waiting") {
    return (
      <WaitingScreen
        session={stage.session}
        onAdmitted={loadToken}
        onDenied={() => setStage({ kind: "declined" })}
        onForbidden={() => setStage({ kind: "forbidden" })}
        onLeave={handleLeave}
      />
    );
  }

  if (stage.kind === "declined") {
    return (
      <Centered>
        <Text style={styles.title}>Request declined</Text>
        <Text style={styles.subtitle}>
          The host declined your request to join.
        </Text>
        <Pressable style={styles.backButton} onPress={handleLeave}>
          <Text style={styles.backButtonText}>Back</Text>
        </Pressable>
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

function WaitingScreen({
  session,
  onAdmitted,
  onDenied,
  onForbidden,
  onLeave,
}: {
  session: LiveSession;
  onAdmitted: (session: LiveSession) => void;
  onDenied: () => void;
  onForbidden: () => void;
  onLeave: () => void;
}) {
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await requestJoin(session.id);
        if (!active) {
          return;
        }
        if (status === "admitted") {
          onAdmitted(session);
          return;
        }
        if (status === "denied") {
          onDenied();
          return;
        }
        timer = setTimeout(poll, 2000);
      } catch (e) {
        if (!active) {
          return;
        }
        if (e instanceof ForbiddenError) {
          onForbidden();
          return;
        }
        console.error("Admission poll failed:", e);
        timer = setTimeout(poll, 2000);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [session, onAdmitted, onDenied, onForbidden]);

  return (
    <Centered>
      <View testID="waiting-screen" style={styles.centered}>
        <ActivityIndicator color={Theme.primary} size="large" />
        <Text style={styles.title}>Waiting to be admitted</Text>
        <Text style={styles.subtitle}>
          The host has been notified. You&apos;ll join automatically once they
          let you in.
        </Text>
        <Pressable
          style={styles.backButton}
          onPress={onLeave}
          testID="waiting-leave"
        >
          <Text style={styles.backButtonText}>Leave</Text>
        </Pressable>
      </View>
    </Centered>
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

  const canEnd = tokenIdentity === session.started_by;
  const [pending, setPending] = useState<PendingPerson[]>([]);

  const localIdentity = localParticipant.identity;
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [chatOpen, setChatOpen] = useState<boolean>(false);
  const [pollOpen, setPollOpen] = useState<boolean>(false);

  const onHandMessage = useCallback(
    (msg: { payload: Uint8Array }) => {
      try {
        const text = new TextDecoder().decode(msg.payload);
        const payload = JSON.parse(text) as HandPayload;
        if (payload.t !== "hand" || !payload.identity) {
          return;
        }
        setRaisedHands((prev) => {
          const next = new Set(prev);
          if (payload.raised) {
            next.add(payload.identity);
          } else {
            next.delete(payload.identity);
          }
          return next;
        });
      } catch (e) {
        console.error("Hand message parse failed:", e);
      }
    },
    [],
  );

  const { send: sendHand } = useDataChannel("hand", onHandMessage);

  const handRaised = raisedHands.has(localIdentity);

  const toggleHand = useCallback(() => {
    const next = !raisedHands.has(localIdentity);
    setRaisedHands((prev) => {
      const s = new Set(prev);
      if (next) {
        s.add(localIdentity);
      } else {
        s.delete(localIdentity);
      }
      return s;
    });
    const payload: HandPayload = {
      t: "hand",
      raised: next,
      identity: localIdentity,
      name: localParticipant.name ?? undefined,
    };
    const data = new TextEncoder().encode(JSON.stringify(payload));
    sendHand(data, { reliable: true, topic: "hand" }).catch((e: unknown) => {
      console.error("Publish hand failed:", e);
    });
  }, [raisedHands, localIdentity, localParticipant.name, sendHand]);

  useEffect(() => {
    if (!canEnd) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const list = await fetchAdmissions(session.id);
        if (active) {
          setPending(list);
        }
      } catch (e) {
        console.error("Admissions poll failed:", e);
      }
      if (active) {
        timer = setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [canEnd, session.id]);

  const handleAdmit = useCallback(
    (memberId: string) => {
      setPending((prev) => prev.filter((p) => p.member_id !== memberId));
      admitMember(session.id, memberId).catch((e: unknown) => {
        console.error("Admit failed:", e);
      });
    },
    [session.id],
  );

  const handleDeny = useCallback(
    (memberId: string) => {
      setPending((prev) => prev.filter((p) => p.member_id !== memberId));
      denyMember(session.id, memberId).catch((e: unknown) => {
        console.error("Deny failed:", e);
      });
    },
    [session.id],
  );

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
        raised={raisedHands.has(p.identity)}
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

      {canEnd && pending.length > 0 ? (
        <View
          testID="knock-banner"
          style={[styles.knockBanner, { marginTop: 12 }]}
        >
          <Text style={styles.knockHeading}>
            Waiting to be admitted
          </Text>
          {pending.map((p) => (
            <View key={p.member_id} style={styles.knockRow}>
              <Text style={styles.knockName} numberOfLines={1}>
                {p.full_name}
              </Text>
              <View style={styles.knockActions}>
                <Pressable
                  style={styles.knockAdmit}
                  onPress={() => handleAdmit(p.member_id)}
                  testID="knock-admit"
                >
                  <Text style={styles.knockAdmitText}>Admit</Text>
                </Pressable>
                <Pressable
                  style={styles.knockDeny}
                  onPress={() => handleDeny(p.member_id)}
                  testID="knock-deny"
                >
                  <Text style={styles.knockDenyText}>Deny</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {grid}

      <View style={{ paddingBottom: insets.bottom + 24 }}>
        <View style={styles.secondaryControls}>
          <Pressable
            style={[styles.secCtrl, handRaised && styles.secCtrlActive]}
            onPress={toggleHand}
            testID="hand-toggle"
          >
            <Hand color={Theme.surface} size={20} />
            <Text style={styles.secCtrlLabel}>
              {raisedHands.size > 0 ? `Hands (${raisedHands.size})` : "Raise hand"}
            </Text>
          </Pressable>
          <Pressable
            style={styles.secCtrl}
            onPress={() => setChatOpen(true)}
            testID="chat-open"
          >
            <MessageSquare color={Theme.surface} size={20} />
            <Text style={styles.secCtrlLabel}>Chat</Text>
          </Pressable>
          <Pressable
            style={styles.secCtrl}
            onPress={() => setPollOpen(true)}
            testID="poll-open"
          >
            <BarChart3 color={Theme.surface} size={20} />
            <Text style={styles.secCtrlLabel}>Poll</Text>
          </Pressable>
        </View>

        <View style={styles.controls}>
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

      <Modal
        visible={chatOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setChatOpen(false)}
      >
        {chatOpen ? (
          <ChatPanel
            roomId={session.room_id}
            onClose={() => setChatOpen(false)}
          />
        ) : null}
      </Modal>

      <Modal
        visible={pollOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setPollOpen(false)}
      >
        {pollOpen ? (
          <PollPanel
            sessionId={session.id}
            isStarter={canEnd}
            onClose={() => setPollOpen(false)}
          />
        ) : null}
      </Modal>
    </View>
  );
}

function ParticipantTile({
  participant,
  trackRef,
  fullWidth,
  raised,
}: {
  participant: Participant;
  trackRef: React.ComponentProps<typeof VideoTrack>["trackRef"];
  fullWidth: boolean;
  raised: boolean;
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

      {raised ? (
        <View style={styles.handBadge}>
          <Hand color="#0C1512" size={16} />
        </View>
      ) : null}

      <View style={styles.tileFooter}>
        {micOff ? <MicOff color="#FFFFFF" size={14} /> : null}
        {participant.isSpeaking ? (
          <Text style={styles.speakingLabel}>Speaking</Text>
        ) : null}
      </View>
    </View>
  );
}

function ChatPanel({
  roomId,
  onClose,
}: {
  roomId: string;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatRow[]>([]);
  const [text, setText] = useState<string>("");
  const [memberId, setMemberId] = useState<string | null>(null);
  const [sending, setSending] = useState<boolean>(false);

  useEffect(() => {
    getCurrentMemberId()
      .then(setMemberId)
      .catch(() => {});
  }, []);

  const loadMessages = useCallback(async (): Promise<ChatRow[]> => {
    const { data, error } = await supabase
      .from("messages")
      .select(CHAT_SELECT)
      .eq("room_id", roomId)
      .order("created_at", { ascending: true });
    if (error) {
      throw error;
    }
    return (data ?? []) as unknown as ChatRow[];
  }, [roomId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const rows = await loadMessages();
        if (active) {
          setMessages(rows);
        }
      } catch (e) {
        console.error("Chat load failed:", e);
      }
      if (active) {
        timer = setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [loadMessages]);

  const onSend = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) {
      return;
    }
    setSending(true);
    try {
      const id = memberId ?? (await getCurrentMemberId());
      if (!id) {
        throw new Error("Could not resolve your member id.");
      }
      const { error } = await supabase.from("messages").insert({
        room_id: roomId,
        author_member_id: id,
        body: trimmed,
        kind: "text",
      });
      if (error) {
        throw error;
      }
      setText("");
      const rows = await loadMessages();
      setMessages(rows);
    } catch (e) {
      console.error("Chat send failed:", e);
    } finally {
      setSending(false);
    }
  }, [text, sending, memberId, roomId, loadMessages]);

  return (
    <View style={styles.sheetOverlay}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
      >
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Chat</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <X color="#C7D0CB" size={22} />
          </Pressable>
        </View>
        <ScrollView
          style={styles.chatScroll}
          contentContainerStyle={styles.chatContent}
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 ? (
            <Text style={styles.sheetMuted}>No messages yet.</Text>
          ) : (
            messages.map((m) => {
              const mine = memberId != null && m.author_member_id === memberId;
              return (
                <View
                  key={m.id}
                  style={[
                    styles.chatBubble,
                    mine ? styles.chatMine : styles.chatTheirs,
                  ]}
                >
                  <Text style={styles.chatAuthor}>
                    {mine ? "You" : m.author?.full_name ?? "Unknown"}
                  </Text>
                  <Text style={styles.chatBody}>{m.body}</Text>
                </View>
              );
            })
          )}
        </ScrollView>
        <View style={styles.chatComposer}>
          <TextInput
            style={styles.chatInput}
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor="#7E8B85"
            multiline
            testID="chat-input"
          />
          <Pressable
            style={[
              styles.chatSend,
              (text.trim().length === 0 || sending) && styles.disabledBtn,
            ]}
            onPress={onSend}
            disabled={text.trim().length === 0 || sending}
            testID="chat-send"
          >
            {sending ? (
              <ActivityIndicator color="#FFFFFF" size="small" />
            ) : (
              <Send color="#FFFFFF" size={20} />
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

function PollPanel({
  sessionId,
  isStarter,
  onClose,
}: {
  sessionId: string;
  isStarter: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [poll, setPoll] = useState<PollRow | null>(null);
  const [votes, setVotes] = useState<PollVote[]>([]);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [question, setQuestion] = useState<string>("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [busy, setBusy] = useState<boolean>(false);
  const [closedView, setClosedView] = useState<{
    poll: PollRow;
    votes: PollVote[];
  } | null>(null);

  useEffect(() => {
    getCurrentMemberId()
      .then(setMemberId)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (closedView) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const { data, error } = await supabase
          .from("polls")
          .select("id, question, options, status, created_by")
          .eq("live_session_id", sessionId)
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(1);
        if (error) {
          throw error;
        }
        const current =
          data && data.length > 0 ? (data[0] as PollRow) : null;
        if (active) {
          setPoll(current);
        }
        if (current) {
          const v = await supabase
            .from("poll_votes")
            .select("option_index, member_id")
            .eq("poll_id", current.id);
          if (active && !v.error) {
            setVotes((v.data ?? []) as PollVote[]);
          }
        } else if (active) {
          setVotes([]);
        }
      } catch (e) {
        console.error("Poll load failed:", e);
      }
      if (active) {
        timer = setTimeout(poll, 2000);
      }
    };
    poll();
    return () => {
      active = false;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [sessionId, closedView]);

  const submitCreate = useCallback(async () => {
    const q = question.trim();
    const opts = options.map((o) => o.trim()).filter(Boolean);
    if (q.length === 0 || opts.length < 2 || busy) {
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("create_poll", {
        p_session_id: sessionId,
        p_question: q,
        p_options: opts,
      });
      if (error) {
        throw error;
      }
      setQuestion("");
      setOptions(["", ""]);
    } catch (e) {
      console.error("Create poll failed:", e);
      Alert.alert("Couldn't create poll", "Please try again.");
    } finally {
      setBusy(false);
    }
  }, [question, options, busy, sessionId]);

  const castVote = useCallback(
    async (index: number) => {
      if (!poll || busy) {
        return;
      }
      setBusy(true);
      try {
        const { error } = await supabase.rpc("vote_poll", {
          p_poll_id: poll.id,
          p_option_index: index,
        });
        if (error) {
          throw error;
        }
        const v = await supabase
          .from("poll_votes")
          .select("option_index, member_id")
          .eq("poll_id", poll.id);
        if (!v.error) {
          setVotes((v.data ?? []) as PollVote[]);
        }
      } catch (e) {
        console.error("Vote failed:", e);
      } finally {
        setBusy(false);
      }
    },
    [poll, busy],
  );

  const closeCurrent = useCallback(async () => {
    if (!poll || busy) {
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase.rpc("close_poll", {
        p_poll_id: poll.id,
      });
      if (error) {
        throw error;
      }
      setClosedView({ poll, votes });
    } catch (e) {
      console.error("Close poll failed:", e);
    } finally {
      setBusy(false);
    }
  }, [poll, votes, busy]);

  const addOption = useCallback(() => {
    setOptions((o) => (o.length < 4 ? [...o, ""] : o));
  }, []);

  const view = closedView ?? (poll ? { poll, votes } : null);
  const readOnly = closedView != null;
  const myVote =
    view && memberId != null
      ? view.votes.find((v) => v.member_id === memberId)?.option_index
      : undefined;
  const total = view ? view.votes.length : 0;
  const canClose =
    view != null &&
    !readOnly &&
    (isStarter || (memberId != null && view.poll.created_by === memberId));

  return (
    <View style={styles.sheetOverlay}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.sheet, { paddingBottom: insets.bottom + 12 }]}
      >
        <View style={styles.sheetHandle} />
        <View style={styles.sheetHead}>
          <Text style={styles.sheetTitle}>Poll</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <X color="#C7D0CB" size={22} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={styles.pollContent}
          showsVerticalScrollIndicator={false}
        >
          {view ? (
            <View style={styles.pollWrap}>
              {readOnly ? (
                <Text style={styles.sheetMuted}>This poll is closed.</Text>
              ) : null}
              <Text style={styles.pollQuestion}>{view.poll.question}</Text>
              {view.poll.options.map((opt, i) => {
                const count = view.votes.filter(
                  (v) => v.option_index === i,
                ).length;
                const ratio = total > 0 ? count / total : 0;
                const selected = myVote === i;
                return (
                  <Pressable
                    key={`${view.poll.id}-${i}`}
                    style={[
                      styles.pollOption,
                      selected && styles.pollOptionSelected,
                    ]}
                    onPress={() => castVote(i)}
                    disabled={readOnly || busy}
                    testID={`poll-option-${i}`}
                  >
                    <View
                      style={[
                        styles.pollBar,
                        { width: `${Math.round(ratio * 100)}%` },
                      ]}
                    />
                    <View style={styles.pollOptionRow}>
                      <Text style={styles.pollOptionLabel} numberOfLines={2}>
                        {opt}
                      </Text>
                      <Text style={styles.pollCount}>{count}</Text>
                    </View>
                  </Pressable>
                );
              })}
              {canClose ? (
                <Pressable
                  style={styles.pollCloseBtn}
                  onPress={closeCurrent}
                  disabled={busy}
                  testID="poll-close"
                >
                  <Text style={styles.pollCloseText}>Close poll</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            <View style={styles.pollWrap}>
              <Text style={styles.sheetMuted}>No active poll.</Text>
              <TextInput
                style={styles.pollInput}
                value={question}
                onChangeText={setQuestion}
                placeholder="Ask a question"
                placeholderTextColor="#7E8B85"
                testID="poll-question"
              />
              {options.map((opt, i) => (
                <TextInput
                  key={`opt-${i}`}
                  style={styles.pollInput}
                  value={opt}
                  onChangeText={(t) =>
                    setOptions((prev) =>
                      prev.map((o, idx) => (idx === i ? t : o)),
                    )
                  }
                  placeholder={`Option ${i + 1}`}
                  placeholderTextColor="#7E8B85"
                  testID={`poll-create-option-${i}`}
                />
              ))}
              {options.length < 4 ? (
                <Pressable
                  style={styles.pollAddOption}
                  onPress={addOption}
                  testID="poll-add-option"
                >
                  <Plus color={Theme.primary} size={18} />
                  <Text style={styles.pollAddText}>Add option</Text>
                </Pressable>
              ) : null}
              <Pressable
                style={[styles.pollSubmit, busy && styles.disabledBtn]}
                onPress={submitCreate}
                disabled={busy}
                testID="poll-create-submit"
              >
                <Text style={styles.pollSubmitText}>Create poll</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
  knockBanner: {
    marginHorizontal: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 16,
    padding: 14,
    gap: 10,
  },
  knockHeading: {
    color: "#C7D0CB",
    fontSize: 13,
    fontWeight: "600",
  },
  knockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  knockName: { flex: 1, color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  knockActions: { flexDirection: "row", alignItems: "center", gap: 8 },
  knockAdmit: {
    backgroundColor: Theme.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  knockAdmitText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  knockDeny: {
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
  },
  knockDenyText: { color: "#C7D0CB", fontSize: 14, fontWeight: "600" },
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
  handBadge: {
    position: "absolute",
    top: 10,
    right: 10,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#F2C94C",
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryControls: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingTop: 8,
    paddingHorizontal: 16,
  },
  secCtrl: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "rgba(255,255,255,0.10)",
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 20,
  },
  secCtrlActive: { backgroundColor: Theme.primary },
  secCtrlLabel: { color: Theme.surface, fontSize: 13, fontWeight: "600" },
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
  disabledBtn: { opacity: 0.4 },
  sheetOverlay: { flex: 1, justifyContent: "flex-end" },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  sheet: {
    maxHeight: "80%",
    backgroundColor: "#15211C",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.25)",
    marginBottom: 12,
  },
  sheetHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  sheetTitle: { color: "#FFFFFF", fontSize: 20, fontWeight: "700" },
  sheetMuted: { color: "#AEB8B3", fontSize: 14 },
  chatScroll: { maxHeight: 360 },
  chatContent: { gap: 10, paddingBottom: 12 },
  chatBubble: {
    maxWidth: "85%",
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 2,
  },
  chatMine: {
    alignSelf: "flex-end",
    backgroundColor: "rgba(15,110,86,0.45)",
  },
  chatTheirs: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chatAuthor: { color: "#AEB8B3", fontSize: 12, fontWeight: "600" },
  chatBody: { color: "#FFFFFF", fontSize: 15, lineHeight: 21 },
  chatComposer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 10,
    paddingTop: 10,
  },
  chatInput: {
    flex: 1,
    minHeight: 44,
    maxHeight: 110,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 15,
    color: "#FFFFFF",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  chatSend: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: Theme.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  pollContent: { paddingBottom: 16 },
  pollWrap: { gap: 12 },
  pollQuestion: { color: "#FFFFFF", fontSize: 17, fontWeight: "700" },
  pollOption: {
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 2,
    borderColor: "transparent",
    overflow: "hidden",
    minHeight: 48,
    justifyContent: "center",
  },
  pollOptionSelected: { borderColor: Theme.primary },
  pollBar: {
    ...StyleSheet.absoluteFillObject,
    right: undefined,
    backgroundColor: "rgba(15,110,86,0.4)",
  },
  pollOptionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 12,
  },
  pollOptionLabel: { flex: 1, color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  pollCount: { color: "#C7D0CB", fontSize: 14, fontWeight: "700" },
  pollCloseBtn: {
    marginTop: 4,
    alignItems: "center",
    paddingVertical: 12,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  pollCloseText: { color: Theme.coral, fontSize: 15, fontWeight: "700" },
  pollInput: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#FFFFFF",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  pollAddOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
  },
  pollAddText: { color: Theme.primary, fontSize: 14, fontWeight: "600" },
  pollSubmit: {
    marginTop: 4,
    alignItems: "center",
    paddingVertical: 14,
    borderRadius: 22,
    backgroundColor: Theme.primary,
  },
  pollSubmitText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
});
