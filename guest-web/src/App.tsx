import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import { pickLocale, t, type Locale } from "./i18n";

const API_BASE = import.meta.env.VITE_API_BASE as string;

type ResolveResp = {
  room_id: string;
  room_title: string | null;
  room_type: string | null;
  display_name: string | null;
  role: string | null;
  guest_kind: string | null;
  language: string | null;
  status: string;
  expired: boolean;
  usable: boolean;
  consent_given: boolean;
};

type TokenResp = {
  token: string;
  url: string;
  room: string;
  identity: string;
  display_name: string;
};

function readToken(): string | null {
  const h = window.location.hash || "";
  const raw = h.startsWith("#") ? h.slice(1) : h;
  if (!raw) return null;
  if (raw.includes("token=")) {
    const params = new URLSearchParams(raw);
    const tk = params.get("token");
    if (tk) return tk;
  }
  return raw;
}

function initial(s?: string | null): string {
  const v = (s || "").trim();
  if (!v) return "?";
  return Array.from(v)[0].toUpperCase();
}

type Phase =
  | "loading"
  | "invalid"
  | "unusable"
  | "ready"
  | "waiting"
  | "in_call"
  | "ended"
  | "error";

// Shared card shell with the brand lockup + state-coloured top edge.
function Shell(props: { accent: "teal" | "live" | "coral"; locale: Locale; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className={`card accent-${props.accent}`}>
        <div className="brand">
          <div className="brand-mark">N</div>
          <div>
            <div className="brand-name">NanoHab Connect</div>
            <div className="brand-trust">{t(props.locale, "brand_trust")}</div>
          </div>
        </div>
        {props.children}
      </div>
    </div>
  );
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [info, setInfo] = useState<ResolveResp | null>(null);
  const [recording, setRecording] = useState(true);
  const [ai, setAi] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");
  const [participants, setParticipants] = useState<string[]>([]);
  const [muted, setMuted] = useState(false);
  const [micDenied, setMicDenied] = useState(false);
  const [micHardBlocked, setMicHardBlocked] = useState(false);
  const [micRetrying, setMicRetrying] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const token = readToken();
  const roomRef = useRef<Room | null>(null);
  const pollRef = useRef<number | null>(null);
  const audioElsRef = useRef<HTMLDivElement | null>(null);

  const locale = pickLocale(info?.language);
  const roomTitle = info?.room_title || t(locale, "care_conversation");

  useEffect(() => {
    if (!token) {
      setPhase("invalid");
      return;
    }
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/guest/resolve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (r.status === 404) return setPhase("invalid");
        if (!r.ok) {
          setErrMsg(`resolve failed (${r.status})`);
          return setPhase("error");
        }
        const data: ResolveResp = await r.json();
        setInfo(data);
        if (!data.usable) setPhase("unusable");
        else if (data.consent_given) setPhase("waiting");
        else setPhase("ready");
      } catch (e) {
        setErrMsg(String(e));
        setPhase("error");
      }
    })();
  }, [token]);

  useEffect(() => {
    if (phase !== "waiting" || !token) return;
    let cancelled = false;

    async function tryJoin() {
      try {
        const r = await fetch(`${API_BASE}/guest/livekit-token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (r.status === 409) return;
        if (!r.ok) {
          setErrMsg(`join token failed (${r.status})`);
          setPhase("error");
          return;
        }
        const data: TokenResp = await r.json();
        if (cancelled) return;
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
        await connectToRoom(data);
      } catch (e) {
        setErrMsg(String(e));
        setPhase("error");
      }
    }

    tryJoin();
    pollRef.current = window.setInterval(tryJoin, 4000);

    return () => {
      cancelled = true;
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, token]);

  function refreshParticipants(room: Room) {
    const names: string[] = [];
    room.remoteParticipants.forEach((p: RemoteParticipant) => {
      names.push(p.name || p.identity);
    });
    setParticipants(names);
  }

  async function connectToRoom(data: TokenResp) {
    const room = new Room();
    roomRef.current = room;

    room.on(RoomEvent.ParticipantConnected, () => refreshParticipants(room));
    room.on(RoomEvent.ParticipantDisconnected, () => refreshParticipants(room));
    room.on(RoomEvent.Disconnected, () => setPhase("ended"));
    room.on(RoomEvent.Reconnecting, () => setReconnecting(true));
    room.on(RoomEvent.Reconnected, () => setReconnecting(false));
    room.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === "audio" && audioElsRef.current) {
        const el = track.attach();
        audioElsRef.current.appendChild(el);
      }
    });

    try {
      await room.connect(data.url, data.token);
      setPhase("in_call");
      refreshParticipants(room);
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
        // iOS Safari can resolve without actually granting (no prompt, no throw),
        // so trust the published state, not the absence of an error.
        if (!room.localParticipant.isMicrophoneEnabled) setMicDenied(true);
      } catch {
        setMicDenied(true);
      }
    } catch (e) {
      setErrMsg(`could not connect: ${String(e)}`);
      setPhase("error");
    }
  }

  // User-gesture mic retry. The tap itself is what lets iOS Safari show the
  // permission prompt when the automatic attempt at join time could not.
  async function enableMic() {
    const room = roomRef.current;
    if (!room) return;
    setMicRetrying(true);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      if (room.localParticipant.isMicrophoneEnabled) {
        setMicDenied(false);
        setMicHardBlocked(false);
        setMuted(false);
      } else {
        setMicHardBlocked(true);
      }
    } catch {
      setMicHardBlocked(true);
    } finally {
      setMicRetrying(false);
    }
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  async function leave() {
    const room = roomRef.current;
    if (room) await room.disconnect();
    setPhase("ended");
  }

  useEffect(() => {
    return () => {
      if (roomRef.current) roomRef.current.disconnect();
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function submitConsent() {
    if (!token) return;
    setSubmitting(true);
    setErrMsg("");
    try {
      const r = await fetch(`${API_BASE}/guest/consent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, recording, ai }),
      });
      if (!r.ok) {
        setErrMsg(`consent failed (${r.status})`);
        setPhase("error");
        return;
      }
      setPhase("waiting");
    } catch (e) {
      setErrMsg(String(e));
      setPhase("error");
    } finally {
      setSubmitting(false);
    }
  }

  const audioSink = <div ref={audioElsRef} style={{ display: "none" }} />;

  if (phase === "loading")
    return (
      <Shell accent="teal" locale={locale}>
        <div className="spin-wrap"><div className="spinner" /></div>
        <p className="lead center">{t(locale, "loading")}</p>
        {audioSink}
      </Shell>
    );

  if (phase === "invalid")
    return (
      <Shell accent="coral" locale={locale}>
        <h1 className="title">{t(locale, "invalid_title")}</h1>
        <p className="lead">{t(locale, "invalid_body")}</p>
        {audioSink}
      </Shell>
    );

  if (phase === "unusable")
    return (
      <Shell accent="coral" locale={locale}>
        <h1 className="title">{t(locale, "unusable_title")}</h1>
        <p className="lead">{info?.expired ? t(locale, "unusable_expired") : t(locale, "unusable_status")}</p>
        {audioSink}
      </Shell>
    );

  if (phase === "error")
    return (
      <Shell accent="coral" locale={locale}>
        <h1 className="title">{t(locale, "error_title")}</h1>
        <p className="lead">{t(locale, "error_body")}</p>
        {errMsg && <p className="hint">{errMsg}</p>}
        {audioSink}
      </Shell>
    );

  if (phase === "ended")
    return (
      <Shell accent="teal" locale={locale}>
        <h1 className="title">{t(locale, "ended_title")}</h1>
        <p className="lead">{t(locale, "ended_body")}</p>
        {audioSink}
      </Shell>
    );

  if (phase === "waiting")
    return (
      <Shell accent="teal" locale={locale}>
        <h1 className="title">{roomTitle}</h1>
        <div className="spin-wrap"><div className="spinner" /></div>
        <p className="lead center">{t(locale, "waiting_line1")}</p>
        <p className="hint center">{t(locale, "waiting_line2")}</p>
        {audioSink}
      </Shell>
    );

  if (phase === "in_call")
    return (
      <Shell accent={reconnecting ? "coral" : "live"} locale={locale}>
        <h1 className="title">{roomTitle}</h1>
        {reconnecting ? (
          <p className="warn">{t(locale, "reconnecting")}</p>
        ) : (
          <div className="status"><span className="dot" />{t(locale, "connected")}</div>
        )}
        {micDenied && (
          <p className="warn">
            {micHardBlocked ? t(locale, "mic_blocked_msg") : t(locale, "mic_off_msg")}
          </p>
        )}
        <div className="room">
          <div className="room-head">{t(locale, "in_the_room")}</div>
          <div className="person you">
            <span className="avatar">{initial(info?.display_name)}</span>
            {t(locale, "you")} ({info?.display_name || t(locale, "you")})
          </div>
          {participants.map((n, i) => (
            <div className="person" key={i}>
              <span className="avatar">{initial(n)}</span>
              {n}
            </div>
          ))}
          {participants.length === 0 && (
            <div className="person-empty">{t(locale, "no_one_else")}</div>
          )}
        </div>
        {micDenied ? (
          <button className="btn btn-primary" onClick={enableMic} disabled={micRetrying}>
            {micRetrying
              ? t(locale, "loading")
              : micHardBlocked
              ? t(locale, "mic_retry")
              : t(locale, "mic_enable")}
          </button>
        ) : (
          <button className="btn btn-ghost" onClick={toggleMute}>
            {muted ? t(locale, "unmute") : t(locale, "mute")}
          </button>
        )}
        <button className="btn btn-leave" onClick={leave}>
          {t(locale, "leave")}
        </button>
        {audioSink}
      </Shell>
    );

  // phase === "ready" (consent)
  return (
    <Shell accent="teal" locale={locale}>
      <h1 className="title">{roomTitle}</h1>
      <p className="subtitle">
        {t(locale, "joining_as")} {info?.display_name || t(locale, "you")}
        {info?.role ? ` \u00b7 ${info.role}` : ""}
      </p>
      <div className="consent">
        <label className="consent-row">
          <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} />
          <span>{t(locale, "consent_recording")}</span>
        </label>
        <label className="consent-row">
          <input type="checkbox" checked={ai} onChange={(e) => setAi(e.target.checked)} />
          <span>{t(locale, "consent_ai")}</span>
        </label>
      </div>
      <button className="btn btn-primary" onClick={submitConsent} disabled={submitting}>
        {submitting ? t(locale, "joining") : t(locale, "agree_join")}
      </button>
      {audioSink}
    </Shell>
  );
}
