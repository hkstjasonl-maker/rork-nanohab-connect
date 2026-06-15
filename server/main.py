"""
NanoHab Connect — backend API (Cloud Run).

This is the TRUSTED server. It is the ONLY place the Supabase service_role key
and the LiveKit API secret live. Both bypass/sign powerful operations, so every
endpoint that uses them MUST first verify *who is calling* (from their Supabase
access token) and scope all work to that verified user. Never trust a
caller-supplied id; only trust the id derived from a verified token.

Stage 0 endpoints:
  GET /          -> health check (public)
  GET /whoami    -> verify token -> resolve member
  GET /token     -> verify token -> mint a LiveKit join token for the member
  GET /ops/orgs  -> OPERATOR stub: cross-org summary, gated by an operator key

The /ops/* routes are the company-internal operator surface. They are the one
place that intentionally reads ACROSS the org boundary (RLS is bypassed by the
service_role client), so they are gated by a separate shared secret. This is a
Stage 0 stub; before launch it will be extracted into its own service with
proper operator identity instead of a shared key.

Config comes from environment variables (set in Cloud Run, never in code):
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
  OPERATOR_API_KEY
"""

import asyncio
import hashlib
import hmac
import json
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import Body, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client
from livekit import api as livekit_api

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")

OPERATOR_API_KEY = os.environ.get("OPERATOR_API_KEY", "")
# Base URL of the guest web app (B3 S4). Magic links are built as
# {GUEST_BASE_URL}/j#<raw-token>. Placeholder until the guest surface is hosted.
GUEST_BASE_URL = os.environ.get("GUEST_BASE_URL", "https://connect.nanohab.com")
# LiveKit egress -> object storage (Stage B4a). Composite audio is mixed
# server-side and written to an S3-compatible bucket; we use Supabase Storage's
# S3 endpoint so the file lands in the same project/region as everything else
# and B4b's worker can read it the same way it reads voice notes. Recording only
# engages if ALL of these (plus LiveKit) are set; otherwise calls run normally,
# just without server-side recording.
RECORDINGS_BUCKET = os.environ.get("RECORDINGS_BUCKET", "meeting-recordings")
# 'per_track' (default): each participant's audio -> own file, exact attribution.
# 'composite': legacy single mixed file (kept as fallback).
RECORDING_MODE = os.environ.get("RECORDING_MODE", "per_track")
SUPABASE_S3_ENDPOINT = os.environ.get("SUPABASE_S3_ENDPOINT", "")
SUPABASE_S3_REGION = os.environ.get("SUPABASE_S3_REGION", "")
SUPABASE_S3_ACCESS_KEY = os.environ.get("SUPABASE_S3_ACCESS_KEY", "")
SUPABASE_S3_SECRET_KEY = os.environ.get("SUPABASE_S3_SECRET_KEY", "")

# The client connects over wss://; the server-side egress (Twirp) API is https://.
LIVEKIT_HTTP_URL = LIVEKIT_URL.replace("wss://", "https://").replace("ws://", "http://")


def _recordings_configured() -> bool:
    return bool(
        RECORDINGS_BUCKET and SUPABASE_S3_ENDPOINT and SUPABASE_S3_REGION
        and SUPABASE_S3_ACCESS_KEY and SUPABASE_S3_SECRET_KEY
        and LIVEKIT_HTTP_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET
    )

# Azure AI Speech (transcription). Absent until provisioned -> worker uses fakes.
AZURE_SPEECH_KEY = os.environ.get("AZURE_SPEECH_KEY", "")
AZURE_SPEECH_REGION = os.environ.get("AZURE_SPEECH_REGION", "")
# Fast path: blank locales = latest multilingual model (best for HK code-mixing).
AZURE_SPEECH_LOCALES = os.environ.get("AZURE_SPEECH_LOCALES", "")
AZURE_FAST_API_VERSION = os.environ.get("AZURE_FAST_API_VERSION", "2025-10-15")
# Batch fallback requires a locale; default to Cantonese (HK).
AZURE_BATCH_LOCALE = os.environ.get("AZURE_BATCH_LOCALE", "zh-HK")

# Azure OpenAI (note structuring LLM). Absent until provisioned -> uses fake.
AZURE_OPENAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT", "")
AZURE_OPENAI_KEY = os.environ.get("AZURE_OPENAI_KEY", "")
AZURE_OPENAI_DEPLOYMENT = os.environ.get("AZURE_OPENAI_DEPLOYMENT", "")
AZURE_OPENAI_API_VERSION = os.environ.get("AZURE_OPENAI_API_VERSION", "2024-10-21")

app = FastAPI(title="NanoHab Connect API", version="0.19.0")

# CORS: permissive for now so the app/guest web can call during early build.
# We will tighten allow_origins to the real app/web origins before launch.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_service_client() -> Client:
    """Create a Supabase client with the service_role key. Server-only."""
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise HTTPException(status_code=500, detail="Server is not configured")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


def resolve_member(authorization: str) -> dict:
    """
    The shared 'who is calling?' gate. Read the caller's Supabase access token,
    verify it with Supabase to get the real user, then look up their member row.
    The service_role client bypasses RLS, so scoping is enforced HERE by only
    querying for the verified user's auth_user_id. Every member-facing endpoint
    funnels through this so the trust rule lives in exactly one place.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty bearer token")

    client = get_service_client()
    try:
        user_resp = client.auth.get_user(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = getattr(user_resp, "user", None)
    if user is None or getattr(user, "id", None) is None:
        raise HTTPException(status_code=401, detail="Invalid token")

    res = (
        client.table("members")
        .select("id, org_id, full_name, org_role")
        .eq("auth_user_id", user.id)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    if not rows:
        raise HTTPException(status_code=404, detail="No member for this user")
    return rows[0]


def require_operator(x_operator_key: str) -> None:
    """
    Gate for the company-internal operator surface. Unlike member endpoints
    (which verify a per-user token), the operator surface is authenticated by a
    single shared secret held only by company staff. Compared in constant time
    so a wrong key can't be guessed by timing. Stub-grade by design.
    """
    if not OPERATOR_API_KEY:
        raise HTTPException(status_code=503, detail="Operator API not configured")
    if not x_operator_key or not hmac.compare_digest(x_operator_key, OPERATOR_API_KEY):
        raise HTTPException(status_code=401, detail="Invalid operator key")


@app.get("/")
def health():
    """Public health check. Reports only whether config is present, no secrets."""
    return {
        "status": "ok",
        "service": "nanohab-connect-api",
        "version": app.version,
        "configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
        "livekit_configured": bool(
            LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET
        ),
        "operator_configured": bool(OPERATOR_API_KEY),
        "recordings_configured": _recordings_configured(),
    }


@app.get("/whoami")
def whoami(authorization: str = Header(default="")):
    """Server-side equivalent of the app's getCurrentMemberId()."""
    m = resolve_member(authorization)
    return {
        "member_id": m["id"],
        "org_id": m["org_id"],
        "full_name": m["full_name"],
        "org_role": m["org_role"],
    }


@app.get("/token")
def token(room: str = "test-room", authorization: str = Header(default="")):
    """
    Mint a LiveKit join token for the verified member.

    Stage 0: 'room' is an arbitrary test room name (the real case/room model
    arrives in Stage A). The token's identity is the member id and the display
    name is the member's full name, so a call participant is always a verified
    member of an org — never an anonymous caller-supplied identity.
    """
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(status_code=500, detail="LiveKit is not configured")

    m = resolve_member(authorization)

    grants = livekit_api.VideoGrants(
        room_join=True,
        room=room,
        can_publish=True,
        can_subscribe=True,
    )
    access = (
        livekit_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(m["id"])
        .with_name(m["full_name"])
        .with_grants(grants)
        .with_ttl(timedelta(hours=1))
    )
    return {
        "token": access.to_jwt(),
        "url": LIVEKIT_URL,
        "room": room,
        "identity": m["id"],
    }


@app.get("/rtc/token")
def rtc_token(room_id: str, authorization: str = Header(default="")):
    """
    Room-scoped LiveKit join token (Stage A7).

    Unlike the legacy /token (which accepted an arbitrary room name), this mints
    a token ONLY if the verified caller is a member of the given room. The
    LiveKit room name is the room's UUID, so the realtime room maps 1:1 to a
    NanoHab Connect room — a caller can never obtain audio into a room they do
    not belong to, even if they know its id.
    """
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(status_code=500, detail="LiveKit is not configured")

    m = resolve_member(authorization)

    # Membership gate. service_role bypasses RLS, so we scope explicitly to the
    # verified member id: no room_members row -> not a member -> no token.
    client = get_service_client()
    res = (
        client.table("room_members")
        .select("id")
        .eq("room_id", room_id)
        .eq("member_id", m["id"])
        .limit(1)
        .execute()
    )
    if not (res.data or []):
        raise HTTPException(status_code=403, detail="Not a member of this room")

    # Waiting-room gate (B2b): do not mint a token until the host has admitted.
    # 'admit' / 'no_session' -> proceed; 'pending' -> 202; 'denied' -> 403.
    decision = _rpc(client, "svc_admission_for_token", {
        "p_room_id": room_id,
        "p_member_id": m["id"],
    })
    if decision == "pending":
        raise HTTPException(status_code=202, detail="Awaiting host admission")
    if decision == "denied":
        raise HTTPException(status_code=403, detail="Admission denied")

    grants = livekit_api.VideoGrants(
        room_join=True,
        room=room_id,
        can_publish=True,
        can_subscribe=True,
    )
    access = (
        livekit_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(m["id"])
        .with_name(m["full_name"])
        .with_grants(grants)
        .with_ttl(timedelta(hours=2))
    )
    return {
        "token": access.to_jwt(),
        "url": LIVEKIT_URL,
        "room": room_id,
        "identity": m["id"],
    }


# ============================================================================
# Stage B - B3: no-install guests via magic link (S2 backend).
#
# Guests NEVER touch RLS. Every guest call validates a raw token against the
# stored HASH (token_hash) server-side (service role) and returns only the
# permitted slice. Flow: a member mints a link (/rtc/invite-guest) -> guest
# opens it -> /guest/resolve (render join + consent screen) -> /guest/consent
# (the gate) -> /guest/livekit-token (only if consented AND a live session
# exists in their room). Reusable until expiry; revoke + consent-gate +
# session-window are the real guards. Single-use is a documented fast-follow.
# ============================================================================

def _token_hash(raw: str) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def _guest_invite_row(client, token_hash: str):
    rows = (client.table("guest_invitations")
            .select("id, room_id, session_id, guest_kind, role, display_name, "
                    "language, status, expires_at, consent_at, consent_recording, consent_ai")
            .eq("token_hash", token_hash).limit(1).execute().data) or []
    return rows[0] if rows else None


def _guest_expired(inv: dict) -> bool:
    try:
        exp = datetime.fromisoformat(str(inv["expires_at"]).replace("Z", "+00:00"))
        return exp <= datetime.now(timezone.utc)
    except Exception:  # noqa: BLE001 — unparseable expiry -> treat as expired (safe)
        return True


@app.post("/rtc/invite-guest")
def rtc_invite_guest(
    room_id: str,
    guest_kind: str,
    role: str,
    display_name: str,
    language: str = "zh-Hant-HK",
    principal_member_id: str = "",
    session_id: str = "",
    expires_in_hours: int = 24,
    authorization: str = Header(default=""),
):
    """
    Member mints a guest magic link. Generates a high-entropy raw token, stores
    ONLY its hash, and returns the raw token + join URL ONCE (never retrievable
    again). Authorization (inviter + any principal must be room members) is
    enforced inside svc_create_guest_invitation.
    """
    if guest_kind not in ("external", "delegate"):
        raise HTTPException(status_code=400, detail="guest_kind must be 'external' or 'delegate'")
    m = resolve_member(authorization)
    client = get_service_client()

    raw = secrets.token_urlsafe(32)
    hours = max(1, min(int(expires_in_hours or 24), 168))  # clamp 1h..7d
    expires_at = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()

    inv = _rpc(client, "svc_create_guest_invitation", {
        "p_room_id": room_id,
        "p_invited_by": m["id"],
        "p_guest_kind": guest_kind,
        "p_role": role,
        "p_display_name": display_name,
        "p_token_hash": _token_hash(raw),
        "p_expires_at": expires_at,
        "p_language": language,
        "p_principal_member_id": _none_if_blank(principal_member_id),
        "p_session_id": _none_if_blank(session_id),
    })
    inv_id = inv.get("id") if isinstance(inv, dict) else None
    if not inv_id:
        raise HTTPException(status_code=500, detail="Could not create invitation")
    # The raw token lives only in this response; the link puts it in the URL
    # fragment (#) so it is never sent to the server in a referrer / access log.
    return {
        "invitation_id": inv_id,
        "token": raw,
        "join_url": f"{GUEST_BASE_URL}/j#{raw}",
        "expires_at": expires_at,
        "role": role,
        "guest_kind": guest_kind,
        "display_name": display_name,
        "language": language,
    }


@app.post("/guest/resolve")
def guest_resolve(token: str = Body(..., embed=True)):
    """
    No auth. Render-the-join-screen view for a guest holding a raw link token.
    Returns room title/type + the guest's role/language + whether the link is
    usable and whether consent has already been given. Bumps last_seen.
    """
    client = get_service_client()
    inv = _guest_invite_row(client, _token_hash(token))
    if not inv:
        raise HTTPException(status_code=404, detail="Invalid or unknown link")

    expired = _guest_expired(inv)
    usable = (inv["status"] == "active") and not expired

    room = (client.table("rooms").select("title, room_type, status")
            .eq("id", inv["room_id"]).limit(1).execute().data or [{}])[0]

    client.table("guest_invitations").update(
        {"last_seen_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", inv["id"]).execute()

    return {
        "room_id": inv["room_id"],
        "room_title": room.get("title"),
        "room_type": room.get("room_type"),
        "display_name": inv["display_name"],
        "role": inv["role"],
        "guest_kind": inv["guest_kind"],
        "language": inv["language"],
        "status": inv["status"],
        "expired": expired,
        "usable": usable,
        "consent_given": inv.get("consent_at") is not None,
    }


@app.post("/guest/consent")
def guest_consent(
    token: str = Body(..., embed=True),
    recording: bool = Body(..., embed=True),
    ai: bool = Body(..., embed=True),
    text_version: str = Body(default="guest_consent_v1", embed=True),
):
    """
    No auth. The gate: record the guest's recording/AI consent. svc_guest_consent
    refuses unknown / revoked / consumed / expired links.
    """
    client = get_service_client()
    row = _rpc(client, "svc_guest_consent", {
        "p_token_hash": _token_hash(token),
        "p_recording": bool(recording),
        "p_ai": bool(ai),
        "p_text_version": text_version,
    })
    return {
        "consent_at": row.get("consent_at") if isinstance(row, dict) else None,
        "recording": bool(recording),
        "ai": bool(ai),
        "status": row.get("status") if isinstance(row, dict) else None,
    }


@app.post("/guest/livekit-token")
def guest_livekit_token(token: str = Body(..., embed=True)):
    """
    No auth. Mint a LiveKit join token for a consented guest — but ONLY while a
    live session exists in their room (the session-window guard). Identity is
    'guest_<invitation_id>' (never a member id), so per-track egress attributes
    the audio to the guest, not a member. Room grant = room_id (same value member
    tokens use), so the guest lands in the same realtime room as the clinicians.
    """
    if not (LIVEKIT_URL and LIVEKIT_API_KEY and LIVEKIT_API_SECRET):
        raise HTTPException(status_code=500, detail="LiveKit is not configured")
    client = get_service_client()
    inv = _guest_invite_row(client, _token_hash(token))
    if not inv:
        raise HTTPException(status_code=404, detail="Invalid or unknown link")
    if inv["status"] != "active":
        raise HTTPException(status_code=403, detail="Link is not active")
    if _guest_expired(inv):
        raise HTTPException(status_code=403, detail="Link expired")
    if not inv.get("consent_at"):
        raise HTTPException(status_code=409, detail="Consent required before joining")

    # Session-window: pinned session if the invite names one, else any live
    # session in the room. No live session -> nothing to join yet.
    q = (client.table("live_sessions").select("id, status")
         .eq("room_id", inv["room_id"]).eq("status", "live"))
    if inv.get("session_id"):
        q = q.eq("id", inv["session_id"])
    live = (q.limit(1).execute().data) or []
    if not live:
        raise HTTPException(status_code=409, detail="No live session to join yet")

    identity = f"guest_{inv['id']}"
    grants = livekit_api.VideoGrants(
        room_join=True, room=inv["room_id"], can_publish=True, can_subscribe=True)
    access = (
        livekit_api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_name(inv["display_name"])
        .with_grants(grants)
        .with_ttl(timedelta(hours=2))
    )
    client.table("guest_invitations").update(
        {"last_seen_at": datetime.now(timezone.utc).isoformat()}
    ).eq("id", inv["id"]).execute()
    return {
        "token": access.to_jwt(),
        "url": LIVEKIT_URL,
        "room": inv["room_id"],
        "identity": identity,
        "display_name": inv["display_name"],
    }


# ----------------------------------------------------------------------------
# Transcription worker (Stage A8.2c) — two engines: FAST primary, BATCH fallback
#
# Strategy (decided with the user): fast transcription (synchronous, seconds) is
# the primary; batch transcription (async, no RPM wall) is the fallback. The
# QUEUE (008/012) owns retry/backoff/concurrency/quota and the fast->batch
# switch; this worker just drives whichever engine a claimed job is in.
#
#   FAST  : download audio bytes from the private bucket -> POST inline to Azure
#           -> transcript back in one call. Default multilingual model (no
#           locale) — best for HK Cantonese-English code-mixing.
#   BATCH : Azure fetches the audio by URL, so the worker mints a SHORT-LIVED
#           (30 min) Supabase signed URL, submits the job, and parks it
#           ('awaiting'); a later /drain pass polls and finalizes it. The signed
#           URL is never logged or stored — only its expiry is recorded.
#
# Engines are swappable behind get_transcriber(): real Azure when the key is
# set, fakes otherwise — so deploying this changes NOTHING until AZURE_SPEECH_KEY
# is present. Engine identity is stored per transcript (transcript_engine).
# ----------------------------------------------------------------------------


class RateLimited(Exception):
    """Fast engine throttled (HTTP 429). The queue retries fast a few times,
    then falls back to batch — handled by fail_transcription_job."""


class FastTranscriber:
    name = "azure_fast_v1"

    def __init__(self, key: str, region: str, locales: str, api_version: str):
        self.key, self.region, self.locales, self.api_version = key, region, locales, api_version

    def transcribe(self, audio: bytes):
        url = (
            f"https://{self.region}.api.cognitive.microsoft.com"
            f"/speechtotext/transcriptions:transcribe?api-version={self.api_version}"
        )
        definition: dict = {}
        if self.locales:
            definition["locales"] = [s.strip() for s in self.locales.split(",") if s.strip()]
        files = {
            "audio": ("audio.m4a", audio, "application/octet-stream"),
            "definition": (None, json.dumps(definition), "application/json"),
        }
        r = httpx.post(url, headers={"Ocp-Apim-Subscription-Key": self.key}, files=files, timeout=120)
        if r.status_code == 429:
            raise RateLimited("fast transcription rate-limited (429)")
        r.raise_for_status()
        data = r.json()
        phrases = data.get("combinedPhrases") or []
        text = " ".join(p.get("text", "") for p in phrases).strip()
        seconds = int(round((data.get("durationMilliseconds") or 0) / 1000)) or 1
        return text, seconds


class BatchTranscriber:
    name = "azure_batch_v1"

    def __init__(self, key: str, region: str, locale: str):
        self.key, self.locale = key, locale
        self.base = f"https://{region}.api.cognitive.microsoft.com/speechtotext/v3.2"

    def _h(self):
        return {"Ocp-Apim-Subscription-Key": self.key}

    def submit(self, content_url: str) -> str:
        body = {
            "contentUrls": [content_url],
            "locale": self.locale,
            "displayName": "nanohab-connect voice note",
            "properties": {"timeToLiveHours": 6},
        }
        r = httpx.post(self.base + "/transcriptions", headers={**self._h(),
                       "Content-Type": "application/json"}, json=body, timeout=60)
        r.raise_for_status()
        return r.json()["self"]  # the job URL we poll later

    def poll(self, job_url: str):
        r = httpx.get(job_url, headers=self._h(), timeout=60)
        r.raise_for_status()
        status = r.json().get("status")
        if status in ("NotStarted", "Running"):
            return ("pending", None, None)
        if status == "Failed":
            raise RuntimeError("batch transcription failed")
        # Succeeded: fetch the transcription result file and parse it.
        fr = httpx.get(job_url + "/files", headers=self._h(), timeout=60)
        fr.raise_for_status()
        files = fr.json().get("values", [])
        turl = next((f["links"]["contentUrl"] for f in files if f.get("kind") == "Transcription"), None)
        if not turl:
            raise RuntimeError("batch result file missing")
        tr = httpx.get(turl, timeout=60)  # contentUrl is pre-authorized by Azure
        tr.raise_for_status()
        res = tr.json()
        phrases = res.get("combinedRecognizedPhrases") or []
        text = " ".join(p.get("display", "") for p in phrases).strip()
        seconds = int(round((res.get("durationInTicks") or 0) / 10_000_000)) or 1
        return ("done", text, seconds)


class FakeFast:
    name = "fake_fast_v0"

    def transcribe(self, audio: bytes):
        return ("[fake fast transcript \u00b7 yue]", 5)


class FakeBatch:
    name = "fake_batch_v0"

    def submit(self, content_url: str) -> str:
        return "https://fake.local/transcriptions/" + uuid.uuid4().hex

    def poll(self, job_url: str):
        return ("done", "[fake batch transcript \u00b7 yue]", 5)


def get_transcriber():
    """Routing seam. Returns (fast_primary, batch_fallback). Real Azure engines
    when the key is set; fakes otherwise so deploys never break pre-key."""
    if AZURE_SPEECH_KEY and AZURE_SPEECH_REGION:
        return (
            FastTranscriber(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_SPEECH_LOCALES, AZURE_FAST_API_VERSION),
            BatchTranscriber(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION, AZURE_BATCH_LOCALE),
        )
    return FakeFast(), FakeBatch()


def _artifact_audio_path(client, artifact_id: str) -> str:
    rows = (client.table("ai_artifacts").select("audio_path")
            .eq("id", artifact_id).limit(1).execute().data) or []
    if not rows or not rows[0].get("audio_path"):
        raise RuntimeError("artifact has no audio_path")
    return rows[0]["audio_path"]


def _download_audio(client, artifact_id: str) -> bytes:
    """Fast path: pull the audio bytes from the private bucket (service role)."""
    return client.storage.from_("voice-notes").download(_artifact_audio_path(client, artifact_id))


def _signed_audio_url(client, artifact_id: str, expires_seconds: int = 1800):
    """Batch path: mint a short-lived signed URL Azure can fetch. The URL is a
    time-boxed read capability; we return it for immediate use and record only
    its EXPIRY in the DB — never the URL itself."""
    path = _artifact_audio_path(client, artifact_id)
    res = client.storage.from_("voice-notes").create_signed_url(path, expires_seconds)
    url = res.get("signedURL") or res.get("signedUrl") or res.get("signed_url")
    if not url:
        raise RuntimeError("could not mint signed url")
    if url.startswith("/"):
        url = SUPABASE_URL + url
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_seconds)).isoformat()
    return url, expires_at


@app.post("/drain")
def drain(x_operator_key: str = Header(default=""), limit: int = 10):
    """
    Drain the transcription queue. Two phases per call:
      1. Claim queued jobs (under the concurrency cap) and act by engine phase:
         fast  -> download bytes, transcribe synchronously, set_transcript+complete
         batch -> mint signed URL, submit job, park as 'awaiting'
      2. Poll 'awaiting' batch jobs: on success set_transcript+complete; on
         failure/expiry fail (retry/backoff/dead-letter).
    Any engine error -> fail_transcription_job (the recording is never lost).
    Gated by the operator key; intended to run on a Cloud Scheduler cadence.
    """
    require_operator(x_operator_key)
    client = get_service_client()
    fast, batch = get_transcriber()
    s = {"fast_done": 0, "batch_submitted": 0, "batch_done": 0, "pending": 0, "failed": 0}

    # Phase 1 — claim and act
    claimed = (client.rpc("claim_transcription_jobs", {"p_limit": limit}).execute().data) or []
    for job in claimed:
        jid, aid, phase = job["job_id"], job["artifact_id"], job.get("engine_phase", "fast")
        try:
            if phase == "fast":
                audio = _download_audio(client, aid)
                text, seconds = fast.transcribe(audio)
                client.rpc("set_transcript", {"p_artifact_id": aid, "p_transcript": text,
                           "p_engine": fast.name}).execute()
                client.rpc("complete_transcription_job", {"p_job_id": jid, "p_seconds": seconds}).execute()
                s["fast_done"] += 1
            else:
                signed_url, expires_at = _signed_audio_url(client, aid)
                job_url = batch.submit(signed_url)
                client.rpc("await_transcription_job", {"p_job_id": jid, "p_azure_job_url": job_url,
                           "p_expires_at": expires_at}).execute()
                s["batch_submitted"] += 1
        except Exception as e:  # noqa: BLE001 — any engine error -> fail (retry/switch/dead-letter)
            client.rpc("fail_transcription_job", {"p_job_id": jid, "p_error": str(e)[:500]}).execute()
            s["failed"] += 1

    # Phase 2 — poll awaiting batch jobs
    awaiting = (client.rpc("list_awaiting_jobs", {"p_limit": limit}).execute().data) or []
    for job in awaiting:
        jid, aid, job_url = job["job_id"], job["artifact_id"], job["azure_job_url"]
        try:
            status, text, seconds = batch.poll(job_url)
            if status == "done":
                client.rpc("set_transcript", {"p_artifact_id": aid, "p_transcript": text,
                           "p_engine": batch.name}).execute()
                client.rpc("complete_transcription_job", {"p_job_id": jid, "p_seconds": seconds or 0}).execute()
                s["batch_done"] += 1
            else:
                s["pending"] += 1
        except Exception as e:  # noqa: BLE001
            client.rpc("fail_transcription_job", {"p_job_id": jid, "p_error": str(e)[:500]}).execute()
            s["failed"] += 1

    # Phase 3 — B4b.2: drive ONE auto-minutes job (reconcile->transcribe->minutes).
    # Reuses this every-minute scheduler tick; no separate cron needed. One job per
    # call keeps the request well under Cloud Run's request timeout.
    try:
        s["minutes"] = _process_one_minutes_job(client) or "idle"
    except Exception as e:  # noqa: BLE001 — minutes must never break the drain
        s["minutes"] = "error"
        print(f"[drain] minutes phase error: {e}")

    return s


def _process_one_minutes_job(client):
    """
    Claim and run ONE auto-minutes job end to end: reconcile (per_track) ->
    transcribe -> minutes, using the recording's started_by as the acting member
    (a consented room member, so every membership/gate check passes). The cores
    are idempotent, so a reclaim after a crash just repeats safely.
    Returns 'done' | 'retry' | 'failed' | None (nothing queued).
    """
    job = _rpc_quiet(client, "svc_claim_minutes_job",
                     {"p_max_attempts": 5, "p_stale_minutes": 3})
    rec = job[0] if isinstance(job, list) and job else (job if isinstance(job, dict) else None)
    if not rec or not rec.get("id"):
        return None
    rid = rec["id"]
    member_id = rec.get("started_by")
    if not member_id:
        _rpc_quiet(client, "svc_finish_minutes_job",
                   {"p_recording_id": rid, "p_status": "failed", "p_error": "no started_by"})
        return "failed"
    try:
        if (rec.get("recording_mode") or "composite") == "per_track":
            recon = _reconcile_recording_core(client, rid, member_id)
            if (recon.get("tracks_found") or 0) == 0:
                # Track files not finalized yet (or a silent recording) -> retry next tick.
                _rpc_quiet(client, "svc_finish_minutes_job",
                           {"p_recording_id": rid, "p_status": "pending",
                            "p_error": "no track files yet"})
                return "retry"
        _transcribe_recording_core(client, rid, member_id)          # idempotent
        _minutes_recording_core(client, rid, member_id, "tight")    # conservative default
        _rpc_quiet(client, "svc_finish_minutes_job",
                   {"p_recording_id": rid, "p_status": "done", "p_error": None})
        print(f"[minutes] auto-minutes done for recording {rid}")
        return "done"
    except Exception as e:  # noqa: BLE001
        _rpc_quiet(client, "svc_finish_minutes_job",
                   {"p_recording_id": rid, "p_status": "failed", "p_error": str(e)[:500]})
        print(f"[minutes] auto-minutes failed for recording {rid}: {e}")
        return "failed"


def _maybe_enqueue_minutes(client, session_id: str, session_row) -> None:
    """
    Best-effort: when a session recorded WITH ai-minutes consent ends, queue
    auto-minutes for its (completed) recording. Never raises — must not break
    /rtc/end. Sessions without ai_minutes consent are intentionally skipped (the
    host-only transcribe-later gate handles those).
    """
    try:
        row = session_row[0] if isinstance(session_row, list) and session_row else session_row
        if not isinstance(row, dict):
            return
        if not (row.get("recording_enabled") and row.get("ai_minutes_enabled")):
            return
        recs = (client.table("meeting_recordings")
                .select("id, status")
                .eq("live_session_id", session_id)
                .order("created_at", desc=True).limit(1).execute().data) or []
        if not recs or recs[0].get("status") != "completed":
            return
        _rpc_quiet(client, "svc_enqueue_minutes", {"p_recording_id": recs[0]["id"]})
        print(f"[minutes] enqueued auto-minutes for recording {recs[0]['id']}")
    except Exception as e:  # noqa: BLE001
        print(f"[minutes] enqueue skipped: {e}")


# ----------------------------------------------------------------------------
# Note structuring (Stage A8.3)
#
# Turns a transcript into a structured clinical-note DRAFT via a pluggable LLM
# engine. Clinician-initiated (called when a clinician opens a note to review),
# so it is human-paced rather than fired for every recording — keeping LLM spend
# on notes someone actually reviews and avoiding draft-time bursts. The engine is
# swappable; the fake below proves the loop with no LLM/key/cost. Engine identity
# is an engine_version LABEL, never a model name.
# ----------------------------------------------------------------------------


class FakeStructurer:
    name = "structure_fake_v0"

    def structure(self, transcript: str, language: str) -> str:
        body = (transcript or "").strip()
        return (
            "Draft note (from voice note, review required)\n"
            f"Language: {language}\n"
            f"Summary: {body[:240]}"
        )


class AzureStructurer:
    # Provenance LABEL, never a model name (matches the NanoHab "review_v1" rule).
    name = "review_v1"

    SYSTEM = (
        "You are a clinical documentation assistant for a Hong Kong speech therapy team. "
        "You receive a raw speech-to-text transcript of a clinician's spoken voice note. "
        "The transcript is Hong Kong Cantonese mixed with English clinical terms and may contain "
        "speech-to-text errors, especially at Cantonese-English boundaries (an English word split "
        "into Chinese characters). Produce a cleaned, structured DRAFT note for the clinician to "
        "review. Rules: "
        "1) Correct obvious transcription errors using clinical context, especially mis-split "
        "English terms (for example '\u5730fer' -> 'defer'). "
        "2) Use Hong Kong written-Cantonese conventions (for example write '\u54b3' not '\u5662'). "
        "3) Add natural punctuation. "
        "4) Keep the original language mix; do NOT translate Cantonese to English or vice versa. "
        "5) Structure concisely when the content supports it (e.g. observation, plan); otherwise "
        "keep clean prose. "
        "6) NEVER invent clinical facts, names, numbers, or recommendations not in the transcript; "
        "if unclear, preserve rather than guess. "
        "7) Output in Traditional Chinese (\u7e41\u9ad4\u4e2d\u6587, Hong Kong convention); "
        "preserve English terms exactly as written; never output Simplified Chinese. "
        "Output only the cleaned draft note text, with no preamble."
    )

    def __init__(self, endpoint: str, key: str, deployment: str, api_version: str):
        self.endpoint = endpoint.rstrip("/")
        self.key, self.deployment, self.api_version = key, deployment, api_version

    def structure(self, transcript: str, language: str) -> str:
        url = (f"{self.endpoint}/openai/deployments/{self.deployment}"
               f"/chat/completions?api-version={self.api_version}")
        body = {
            "messages": [
                {"role": "system", "content": self.SYSTEM},
                {"role": "user", "content": (transcript or "").strip()},
            ],
            "temperature": 0.2,
            "max_tokens": 800,
        }
        r = httpx.post(url, headers={"api-key": self.key, "Content-Type": "application/json"},
                       json=body, timeout=60)
        r.raise_for_status()
        return (r.json()["choices"][0]["message"]["content"] or "").strip()


def get_structurer(language: str):
    """Routing seam. Real Azure OpenAI when configured; fake otherwise so deploys
    never break pre-key. Engine identity is the LABEL name, not the model."""
    if AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY and AZURE_OPENAI_DEPLOYMENT:
        return AzureStructurer(AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY,
                               AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_VERSION)
    return FakeStructurer()


@app.post("/structure")
def structure(artifact_id: str, authorization: str = Header(default="")):
    """
    Draft a structured note from an artifact's transcript.

    Clinician-initiated: the caller must be a member of the artifact's room and
    the artifact must be in 'transcribed' state. Produces the AI draft via the
    pluggable engine and writes it via set_ai_draft (transcribed -> drafted). The
    state-machine trigger keeps the draft write-once and blocks re-drafting.
    """
    m = resolve_member(authorization)
    client = get_service_client()

    rows = (
        client.table("ai_artifacts")
        .select("room_id, state, transcript")
        .eq("id", artifact_id)
        .limit(1)
        .execute()
        .data
    ) or []
    if not rows:
        raise HTTPException(status_code=404, detail="No such artifact")
    art = rows[0]

    member_rows = (
        client.table("room_members")
        .select("id")
        .eq("room_id", art["room_id"])
        .eq("member_id", m["id"])
        .limit(1)
        .execute()
        .data
    ) or []
    if not member_rows:
        raise HTTPException(status_code=403, detail="Not a member of this artifact's room")

    if art["state"] != "transcribed":
        raise HTTPException(
            status_code=409, detail=f"Artifact is not ready to draft (state={art['state']})"
        )

    engine = get_structurer("yue")
    draft = engine.structure(art.get("transcript") or "", "yue")
    client.rpc(
        "set_ai_draft",
        {"p_artifact_id": artifact_id, "p_draft": draft, "p_engine_version": engine.name},
    ).execute()

    return {"artifact_id": artifact_id, "engine_version": engine.name, "drafted": True}


@app.get("/ops/orgs")
def ops_orgs(x_operator_key: str = Header(default="")):
    """
    OPERATOR stub: a cross-org summary for company-internal use.

    Returns each org with its member count. This deliberately reads across all
    orgs (the operator's job), which is exactly why it is locked behind the
    operator key rather than a member token.
    """
    require_operator(x_operator_key)

    client = get_service_client()
    orgs = (client.table("organizations").select("id, name").execute().data) or []
    members = (client.table("members").select("org_id").execute().data) or []

    counts: dict = {}
    for m in members:
        counts[m["org_id"]] = counts.get(m["org_id"], 0) + 1

    summary = [
        {"org_id": o["id"], "name": o["name"], "member_count": counts.get(o["id"], 0)}
        for o in orgs
    ]
    return {"org_count": len(summary), "orgs": summary}


# ============================================================================
# Stage B - Slice 1: live-session lifecycle + consent (the multi-party spine).
# Thin endpoints: authenticate the member from their bearer token, then call a
# service-role RPC that does authorization + the atomic write. Same two-lane
# pattern as /rtc/token and /structure.
# ============================================================================
def _rpc(client, fn: str, params: dict):
    """Call a service-role RPC and map known SQL errors to HTTP status codes."""
    try:
        return client.rpc(fn, params).execute().data
    except HTTPException:
        raise
    except Exception as e:  # supabase-py raises on a Postgres error
        msg = str(e)
        if "Not a member" in msg or "can end it" in msg or "42501" in msg:
            raise HTTPException(status_code=403, detail="Not authorized for this room")
        if "No such" in msg:
            raise HTTPException(status_code=404, detail="Not found")
        raise HTTPException(status_code=500, detail="Live-session operation failed")


# ============================================================================
# Stage B4a — meeting recording via LiveKit room-composite (audio-only) egress.
# Audio is mixed server-side and written to the recordings bucket over the
# S3-compatible endpoint. Egress calls are async; these routes are sync, so we
# drive them with asyncio.run (FastAPI runs sync routes in a worker thread, so
# there is no already-running loop to clash with). Recording is BEST-EFFORT:
# every failure is logged and swallowed so a live call is never broken by a
# recording problem.
# ============================================================================
def _rpc_quiet(client, fn: str, params: dict):
    """Like _rpc, but never raises HTTP — for best-effort recording writes."""
    try:
        return client.rpc(fn, params).execute().data
    except Exception as e:
        print(f"[rec] rpc {fn} failed: {e}")
        return None


def _lk_api():
    return livekit_api.LiveKitAPI(LIVEKIT_HTTP_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)


def _s3_upload():
    """Supabase S3-compatible upload target (shared by composite + per-track)."""
    return livekit_api.S3Upload(
        bucket=RECORDINGS_BUCKET,
        region=SUPABASE_S3_REGION,
        access_key=SUPABASE_S3_ACCESS_KEY,
        secret=SUPABASE_S3_SECRET_KEY,
        endpoint=SUPABASE_S3_ENDPOINT,
        force_path_style=True,
    )


def _start_audio_egress(room_name: str, object_key: str) -> str:
    """Start a room-composite audio-only egress to the recordings bucket;
    return the LiveKit egress id."""
    async def _run() -> str:
        lk = _lk_api()
        try:
            req = livekit_api.RoomCompositeEgressRequest(
                room_name=room_name,
                audio_only=True,
                file_outputs=[livekit_api.EncodedFileOutput(
                    file_type=livekit_api.EncodedFileType.OGG,
                    filepath=object_key,
                    s3=_s3_upload(),
                )],
            )
            info = await lk.egress.start_room_composite_egress(req)
            return info.egress_id
        finally:
            await lk.aclose()
    return asyncio.run(_run())


def _stop_egress(egress_id: str) -> None:
    """Stop a running egress. The file finalizes asynchronously afterwards."""
    async def _run() -> None:
        lk = _lk_api()
        try:
            await lk.egress.stop_egress(livekit_api.StopEgressRequest(egress_id=egress_id))
        finally:
            await lk.aclose()
    asyncio.run(_run())


def _ensure_room(room_name: str) -> None:
    """Create the LiveKit room if it doesn't exist yet (idempotent).

    Composite egress attaches to an existing room; if recording starts before
    the first participant joins (e.g. host enables recording at go-live, or a
    server-driven start), the room would not exist and egress 404s. We set a
    short empty_timeout so the room lingers briefly while joiners arrive.
    """
    async def _run() -> None:
        lk = _lk_api()
        try:
            await lk.room.create_room(
                livekit_api.CreateRoomRequest(name=room_name, empty_timeout=300)
            )
        finally:
            await lk.aclose()
    asyncio.run(_run())


# --- per-track egress (B4 P2) ------------------------------------------------
def _identity_from_path(path: str):
    """The publisher identity (= member id) lives in its own '/p_<identity>/'
    path segment, so attribution is an unambiguous parse — no diarization."""
    for seg in (path or "").split("/"):
        if seg.startswith("p_"):
            return seg[2:]
    return None


def _trackid_from_path(path: str):
    for seg in (path or "").split("/"):
        if seg.startswith("t_"):
            return seg[2:].split(".")[0]
    return None


def _ensure_room_with_track_egress(room_name: str, prefix: str) -> None:
    """Recreate the room with AUTO TRACK egress so each participant's audio is
    recorded to its own file as it is published. The filepath template puts the
    publisher identity (member id) in its own path segment for clean attribution.

    Auto-egress config is fixed at room creation, so we delete+recreate to
    guarantee fresh per-session config. Safe because this runs at go-live BEFORE
    any participant connects (the client joins only after /rtc/start returns)."""
    template = prefix + "/p_{publisher_identity}/t_{track_id}"
    async def _run() -> None:
        lk = _lk_api()
        try:
            try:
                await lk.room.delete_room(livekit_api.DeleteRoomRequest(room=room_name))
            except Exception:
                pass  # room may not exist yet
            await lk.room.create_room(livekit_api.CreateRoomRequest(
                name=room_name, empty_timeout=300,
                egress=livekit_api.RoomEgress(
                    tracks=livekit_api.AutoTrackEgress(filepath=template, s3=_s3_upload()),
                ),
            ))
        finally:
            await lk.aclose()
    asyncio.run(_run())


def _list_room_egresses(room_name: str):
    """List a room's egresses as plain dicts. Defensive getattr throughout — the
    EgressInfo shape varies by SDK/egress type; we read file_results for the
    object key + duration and parse identity/track from the templated path."""
    async def _run():
        lk = _lk_api()
        out = []
        try:
            resp = await lk.egress.list_egress(
                livekit_api.ListEgressRequest(room_name=room_name))
            for info in (getattr(resp, "items", None) or []):
                fname, dur_ns = None, None
                fr = getattr(info, "file_results", None) or []
                if fr:
                    fname = getattr(fr[0], "filename", None) or getattr(fr[0], "location", None)
                    dur_ns = getattr(fr[0], "duration", None)
                out.append({
                    "egress_id": getattr(info, "egress_id", None),
                    "status": int(getattr(info, "status", 0) or 0),  # 1/2 active-ish, 3 complete
                    "filename": fname,
                    "duration_s": int(dur_ns / 1e9) if dur_ns else None,
                    "identity": _identity_from_path(fname),
                    "track_id": _trackid_from_path(fname),
                })
        finally:
            await lk.aclose()
        return out
    return asyncio.run(_run())


def _session_room(client, session_id: str) -> str:
    rows = (client.table("live_sessions").select("livekit_room")
            .eq("id", session_id).limit(1).execute().data) or []
    return (rows[0].get("livekit_room") if rows else None) or session_id


def _list_session_track_files(client, bucket: str, room_id: str, session_id: str):
    """Reconcile per-track files from STORAGE (the source of truth), not from
    list_egress — so it is immune to LiveKit room reuse / delete+recreate.

    Auto-track egress writes, per participant, into:
      {room_id}/{session_id}/p_<publisher_identity>/t_<track_id>.ogg   (audio)
      {room_id}/{session_id}/p_<publisher_identity>/EG_<egress_id>.json (manifest)
    Returns [{identity, audio_path, egress_id, track_id}]."""
    base = f"{room_id}/{session_id}"
    out = []
    try:
        folders = client.storage.from_(bucket).list(base) or []
    except Exception as e:
        print(f"[rec] storage list '{base}' failed: {e}")
        return out
    for f in folders:
        fname = (f or {}).get("name") or ""
        if not fname.startswith("p_"):
            continue  # only participant folders
        identity = fname[2:]
        folder = f"{base}/{fname}"
        audio_path, egress_id, track_id = None, None, None
        try:
            files = client.storage.from_(bucket).list(folder) or []
        except Exception:
            files = []
        for fi in files:
            n = (fi or {}).get("name") or ""
            if n.endswith(".ogg"):
                audio_path = f"{folder}/{n}"
                if n.startswith("t_"):
                    track_id = n[2:].rsplit(".", 1)[0]
            elif n.startswith("EG_") and n.endswith(".json"):
                egress_id = n[:-5]  # manifest filename stem is the egress id
        if audio_path:
            out.append({
                "identity": identity,
                "audio_path": audio_path,
                # dedup key for svc_record_track: egress id if known, else stable path
                "egress_id": egress_id or audio_path,
                "track_id": track_id,
            })
    return out


def _active_recording(client, session_id: str):
    rows = (client.table("meeting_recordings")
            .select("id, egress_id, recording_mode, created_at")
            .eq("live_session_id", session_id)
            .eq("status", "active")
            .limit(1).execute().data) or []
    return rows[0] if rows else None


def _maybe_start_recording(client, session: dict, member_id: str) -> str:
    """Best-effort: start recording for a recording-enabled session and log the
    row. Returns 'started' | 'already' | 'off' | 'failed'.

    per_track (default): recreate the room with auto track-egress (each
    participant -> own file); the parent row carries no single egress_id.
    composite (fallback): start one room-composite egress."""
    if not isinstance(session, dict) or not session.get("recording_enabled"):
        return "off"
    if not _recordings_configured():
        return "off"
    session_id = session["id"]
    room_name = session.get("livekit_room") or session_id
    mode = RECORDING_MODE if RECORDING_MODE in ("composite", "per_track") else "composite"
    try:
        if _active_recording(client, session_id):
            return "already"  # idempotent: a second joiner must not start again

        if mode == "per_track":
            prefix = f"{room_name}/{session_id}"
            _ensure_room_with_track_egress(room_name, prefix)
            _rpc_quiet(client, "svc_start_recording", {
                "p_session_id": session_id,
                "p_member_id": member_id,
                "p_egress_id": None,
                "p_mode": "per_track",
                "p_bucket": RECORDINGS_BUCKET,
                "p_path": prefix,
            })
            return "started"

        # composite fallback
        object_key = f"{room_name}/{session_id}.ogg"
        _ensure_room(room_name)
        egress_id = _start_audio_egress(room_name, object_key)
        _rpc_quiet(client, "svc_start_recording", {
            "p_session_id": session_id,
            "p_member_id": member_id,
            "p_egress_id": egress_id,
            "p_mode": "composite",
            "p_bucket": RECORDINGS_BUCKET,
            "p_path": object_key,
        })
        return "started"
    except Exception as e:
        print(f"[rec] start failed for session {session_id}: {e}")
        return "failed"


def _maybe_stop_recording(client, session_id: str) -> str:
    """Best-effort: stop a session's recording and close out its row.
    Returns 'stopped' | 'none' | 'failed'.

    per_track: stop any still-active track egresses for the room, then finish the
    parent. The per-track FILES are written to recording_tracks by the reconcile
    step (timing: files finalize asynchronously after stop).
    composite: stop the single egress and finish."""
    rec = _active_recording(client, session_id)
    if not rec:
        return "none"
    mode = rec.get("recording_mode") or "composite"

    def _approx_dur():
        try:
            created = datetime.fromisoformat(str(rec["created_at"]).replace("Z", "+00:00"))
            return max(1, int((datetime.now(timezone.utc) - created).total_seconds()))
        except Exception:
            return None

    try:
        if mode == "per_track":
            # Track egresses auto-stop when each participant unpublishes (leaves),
            # so by /rtc/end the files are already finalizing. Just close the
            # parent; the per-track FILES are written by /rtc/reconcile-tracks,
            # which reads them from storage (immune to LiveKit room reuse).
            _rpc_quiet(client, "svc_finish_recording", {
                "p_recording_id": rec["id"], "p_status": "completed",
                "p_duration": _approx_dur(), "p_path": None, "p_error": None,
            })
            return "stopped"

        # composite
        _stop_egress(rec["egress_id"])
        _rpc_quiet(client, "svc_finish_recording", {
            "p_recording_id": rec["id"], "p_status": "completed",
            "p_duration": _approx_dur(), "p_path": None, "p_error": None,
        })
        return "stopped"
    except Exception as e:
        print(f"[rec] stop failed for session {session_id}: {e}")
        return "failed"


@app.post("/rtc/start")
def rtc_start(
    room_id: str,
    recording: bool = False,
    ai_minutes: bool = False,
    waiting_room: bool = False,
    authorization: str = Header(default=""),
):
    """
    Start (or join) the room's live session. Idempotent: if the room is already
    live, returns the existing session rather than erroring. The caller must be
    a member of the room (enforced inside svc_start_live_session).
    """
    m = resolve_member(authorization)
    client = get_service_client()
    data = _rpc(client, "svc_start_live_session", {
        "p_room_id": room_id,
        "p_member_id": m["id"],
        "p_recording": recording,
        "p_ai_minutes": ai_minutes,
        "p_waiting_room": waiting_room,
    })
    rec_status = _maybe_start_recording(client, data, m["id"])
    return {"session": data, "recording": rec_status}


@app.post("/rtc/end")
def rtc_end(session_id: str, authorization: str = Header(default="")):
    """
    End a live session. Only the room host or the member who started it may end
    it (enforced inside svc_end_live_session). Returns the room to 'open'.
    """
    m = resolve_member(authorization)
    client = get_service_client()
    data = _rpc(client, "svc_end_live_session", {
        "p_session_id": session_id,
        "p_member_id": m["id"],
    })
    rec_status = _maybe_stop_recording(client, session_id)
    _maybe_enqueue_minutes(client, session_id, data)
    return {"session": data, "recording": rec_status}


@app.post("/rtc/reconcile-tracks")
def rtc_reconcile_tracks(recording_id: str, authorization: str = Header(default="")):
    """
    For a per_track recording, list the session's per-participant files from
    STORAGE and write each into recording_tracks (idempotent upsert via
    svc_record_track). Attribution comes from the templated path
    ('/p_<member-id>/'), not diarization. Immune to LiveKit room reuse.

    Call AFTER /rtc/end and a short wait (track files finalize asynchronously).
    Re-runnable. Seeds B4b' per-track transcription.
    """
    return _reconcile_recording_core(
        get_service_client(), recording_id, resolve_member(authorization)["id"])


def _reconcile_recording_core(client, recording_id: str, member_id: str) -> dict:
    """
    Shared reconcile core (HTTP endpoint + B4b.2 minutes auto-trigger worker).
    member_id must be a room member; the worker passes the recording's started_by.
    """
    rows = (client.table("meeting_recordings")
            .select("id, live_session_id, room_id, recording_mode, storage_bucket")
            .eq("id", recording_id).limit(1).execute().data) or []
    if not rows:
        raise HTTPException(status_code=404, detail="No such recording")
    rec = rows[0]
    if not (client.table("room_members").select("id")
            .eq("room_id", rec["room_id"]).eq("member_id", member_id).limit(1).execute().data or []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    if (rec.get("recording_mode") or "composite") != "per_track":
        raise HTTPException(status_code=400, detail="Not a per_track recording")

    bucket = rec.get("storage_bucket") or RECORDINGS_BUCKET
    files = _list_session_track_files(client, bucket, rec["room_id"], rec["live_session_id"])

    found, tracks = 0, []
    for fobj in files:
        found += 1
        row = _rpc_quiet(client, "svc_record_track", {
            "p_recording_id": recording_id,
            "p_member_id": member_id,
            "p_participant_identity": fobj["identity"],
            "p_egress_id": fobj["egress_id"],
            "p_track_id": fobj["track_id"],
            "p_bucket": bucket,
            "p_path": fobj["audio_path"],
            "p_status": "completed",
            "p_duration": None,
            "p_error": None,
        })
        resolved = None
        if isinstance(row, list) and row:
            resolved = row[0].get("member_id")
        elif isinstance(row, dict):
            resolved = row.get("member_id")
        tracks.append({
            "identity": fobj["identity"],
            "member_id": resolved,
            "path": fobj["audio_path"],
            "egress_id": fobj["egress_id"],
        })

    return {"recording_id": recording_id, "tracks_found": found, "tracks": tracks}


@app.post("/rtc/consent")
def rtc_consent(
    session_id: str,
    recording: bool,
    ai: bool,
    text_version: str = "",
    authorization: str = Header(default=""),
):
    """
    Record (upsert) the calling member's recording + AI consent for a session.
    One row per member per session; re-submitting updates in place.
    """
    m = resolve_member(authorization)
    client = get_service_client()
    data = _rpc(client, "svc_record_consent", {
        "p_session_id": session_id,
        "p_member_id": m["id"],
        "p_recording": recording,
        "p_ai": ai,
        "p_text_version": (text_version or None),
    })
    return {"consent": data}


# ============================================================================
# Stage B - Slice 2b: waiting-room admit (token-layer gate). Joiners request
# admission; the host admits/denies; /rtc/token (above) refuses to mint until
# admitted. All authorization lives in the svc_* RPCs.
# ============================================================================
@app.post("/rtc/join-request")
def rtc_join_request(session_id: str, authorization: str = Header(default="")):
    """
    Ask to join a live session. Host/starter is admitted immediately; everyone
    else lands 'pending'. Idempotent - re-call to poll the current status.
    Returns {"status": "admitted" | "pending" | "denied"}.
    """
    m = resolve_member(authorization)
    client = get_service_client()
    data = _rpc(client, "svc_request_admission", {
        "p_session_id": session_id,
        "p_member_id": m["id"],
    })
    status = data.get("status") if isinstance(data, dict) else None
    return {"status": status}


@app.get("/rtc/admissions")
def rtc_admissions(session_id: str, authorization: str = Header(default="")):
    """
    The host's knocking list: pending requests for a session, with names
    resolved server-side (so cross-org names still show). Host/starter only.
    """
    m = resolve_member(authorization)
    client = get_service_client()

    sess = (
        client.table("live_sessions")
        .select("room_id, started_by")
        .eq("id", session_id)
        .limit(1)
        .execute()
        .data
    ) or []
    if not sess:
        raise HTTPException(status_code=404, detail="No such session")
    room_id = sess[0]["room_id"]
    started_by = sess[0]["started_by"]

    is_host = (
        client.table("room_members")
        .select("id")
        .eq("room_id", room_id)
        .eq("member_id", m["id"])
        .eq("member_role", "host")
        .limit(1)
        .execute()
        .data
    ) or []
    if not is_host and started_by != m["id"]:
        raise HTTPException(status_code=403, detail="Only the host can view admissions")

    pending = (
        client.table("admissions")
        .select("member_id, requested_at")
        .eq("live_session_id", session_id)
        .eq("status", "pending")
        .order("requested_at")
        .execute()
        .data
    ) or []

    out = []
    for a in pending:
        mem = (
            client.table("members")
            .select("full_name")
            .eq("id", a["member_id"])
            .limit(1)
            .execute()
            .data
        ) or []
        out.append({
            "member_id": a["member_id"],
            "full_name": (mem[0]["full_name"] if mem else "Unknown"),
            "requested_at": a["requested_at"],
        })
    return {"pending": out}


@app.post("/rtc/admit")
def rtc_admit(session_id: str, member_id: str, authorization: str = Header(default="")):
    """Host/starter admits a pending member."""
    m = resolve_member(authorization)
    client = get_service_client()
    data = _rpc(client, "svc_decide_admission", {
        "p_session_id": session_id,
        "p_target_member_id": member_id,
        "p_decider_id": m["id"],
        "p_admit": True,
    })
    return {"admission": data}


@app.post("/rtc/deny")
def rtc_deny(session_id: str, member_id: str, authorization: str = Header(default="")):
    """Host/starter denies a pending member."""
    m = resolve_member(authorization)
    client = get_service_client()
    data = _rpc(client, "svc_decide_admission", {
        "p_session_id": session_id,
        "p_target_member_id": member_id,
        "p_decider_id": m["id"],
        "p_admit": False,
    })
    return {"admission": data}


# ============================================================================
# Stage B - B4b: diarized meeting transcription (the segment-aware lane).
#
# Distinct from the A8 voice-note path on purpose: that path joins Azure's
# combinedPhrases into ONE text blob and drops timing + speaker. Meetings need
# the opposite, so MeetingTranscriber parses the per-phrase `phrases[]` array
# (speaker / offsetMilliseconds / durationMilliseconds / text / confidence) and
# we persist SEGMENTS via the 017 svc_* RPCs. The voice-note path is untouched.
#
# Composite egress mixes everyone into one mono channel, so diarization must
# GUESS how many voices are present. We cap maxSpeakers by the room's member
# count, clamped to [2, 8]: a too-high cap makes diarization over-split one
# voice into several. The clinician's speaker-confirm at review (B4d) is the
# real source of truth - here we only need clean-ish clusters to map from.
# TODO(B4 hardening): upgrade the speaker-count signal from room_members to the
# actual LiveKit call participants once the egress/participant webhook is wired.
# ============================================================================
MEETING_TRANSCRIBE_LOCALE = os.environ.get("AZURE_MEETING_LOCALE", AZURE_BATCH_LOCALE or "zh-HK")


def _meeting_max_speakers(client, room_id: str) -> int:
    """Clamp the diarization speaker cap to the room's size, in [2, 8]."""
    try:
        rows = (client.table("room_members").select("id")
                .eq("room_id", room_id).execute().data) or []
        n = len(rows)
    except Exception:
        n = 0
    return max(2, min(8, n or 2))


class MeetingTranscriber:
    """Azure fast transcription with diarization on, parsed into segments."""
    name = "azure_fast_diar_v1"

    def __init__(self, key: str, region: str, locale: str, api_version: str):
        self.key, self.region, self.locale, self.api_version = key, region, locale, api_version

    def transcribe(self, audio: bytes, max_speakers: int, diarize: bool = True):
        url = (
            f"https://{self.region}.api.cognitive.microsoft.com"
            f"/speechtotext/transcriptions:transcribe?api-version={self.api_version}"
        )
        definition: dict = {}
        if diarize:
            definition["diarization"] = {"maxSpeakers": int(max_speakers), "enabled": True}
        if self.locale:
            definition["locales"] = [self.locale]
        files = {
            "audio": ("audio.ogg", audio, "application/octet-stream"),
            "definition": (None, json.dumps(definition), "application/json"),
        }
        r = httpx.post(url, headers={"Ocp-Apim-Subscription-Key": self.key}, files=files, timeout=300)
        if r.status_code == 429:
            raise RateLimited("meeting transcription rate-limited (429)")
        r.raise_for_status()
        data = r.json()

        # Per-phrase detail (carries speaker + timing); combinedPhrases is just
        # the merged text we keep as full_text for quick reads/search.
        phrases = data.get("phrases") or []
        segments = []
        for i, p in enumerate(phrases):
            spk = p.get("speaker")
            label = f"Speaker {spk}" if spk is not None else "Speaker ?"
            off = p.get("offsetMilliseconds")
            dur = p.get("durationMilliseconds")
            conf = p.get("confidence")
            segments.append({
                "seq": i,
                "speaker_label": label,
                "start_ms": int(off) if off is not None else None,
                "end_ms": (int(off) + int(dur)) if (off is not None and dur is not None) else None,
                "text": (p.get("text") or "").strip(),
                "confidence": float(conf) if conf is not None else None,
            })

        combined = data.get("combinedPhrases") or []
        full_text = " ".join(c.get("text", "") for c in combined).strip()
        if not full_text:  # fall back to stitching the phrases
            full_text = " ".join(s["text"] for s in segments if s["text"]).strip()
        seconds = int(round((data.get("durationMilliseconds") or 0) / 1000)) or 1
        return full_text, segments, seconds


class FakeMeetingTranscriber:
    name = "fake_meeting_v0"

    def transcribe(self, audio: bytes, max_speakers: int, diarize: bool = True):
        segs = [
            {"seq": 0, "speaker_label": "Speaker 1", "start_ms": 0, "end_ms": 4000,
             "text": "[fake] patient shows mild hoarseness", "confidence": 0.9},
            {"seq": 1, "speaker_label": "Speaker 2", "start_ms": 4200, "end_ms": 9000,
             "text": "[fake] recommend voice therapy twice a week", "confidence": 0.85},
        ]
        return ("[fake] patient shows mild hoarseness recommend voice therapy twice a week", segs, 9)


def _get_meeting_transcriber():
    if AZURE_SPEECH_KEY and AZURE_SPEECH_REGION:
        return MeetingTranscriber(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION,
                                  MEETING_TRANSCRIBE_LOCALE, AZURE_FAST_API_VERSION)
    return FakeMeetingTranscriber()


def _download_meeting_audio(client, bucket: str, path: str) -> bytes:
    """Pull the recording bytes from the (private) meeting-recordings bucket."""
    return client.storage.from_(bucket).download(path)


def _member_label(client, member_id, identity) -> str:
    """Display label for a per-track speaker: the member's name when resolvable,
    else a guest marker. Attribution itself is the member_id, not this label."""
    if member_id:
        rows = (client.table("members").select("full_name")
                .eq("id", member_id).limit(1).execute().data) or []
        if rows and rows[0].get("full_name"):
            return rows[0]["full_name"]
        return "Member"
    return "Guest"


def _transcribe_per_track(client, recording_id: str, transcript_id: str, rec: dict) -> dict:
    """Per-track transcription (B4 P3): transcribe EACH participant file on its
    own (one voice per file -> diarization off), stamp every segment with that
    file's member_id, then merge all segments by start_ms into one ordered
    transcript. Attribution is exact and pre-filled — B4d becomes verify, not
    guess. full_text is built as '<name>: <text>' lines, which also gives the
    minutes LLM clean who-said-what structure."""
    bucket = rec.get("storage_bucket") or RECORDINGS_BUCKET
    tracks = (client.table("recording_tracks")
              .select("member_id, participant_identity, storage_path")
              .eq("recording_id", recording_id).eq("status", "completed")
              .execute().data) or []
    tracks = [t for t in tracks if t.get("storage_path")]
    if not tracks:
        _rpc_quiet(client, "svc_finish_meeting_transcript", {
            "p_transcript_id": transcript_id, "p_status": "failed",
            "p_error": "no per-track files (run /rtc/reconcile-tracks first)"})
        raise HTTPException(status_code=409,
                            detail="No per-track files yet; run /rtc/reconcile-tracks first")

    engine = _get_meeting_transcriber()
    merged, total_ms = [], 0
    for t in tracks:
        label = _member_label(client, t.get("member_id"), t.get("participant_identity"))
        try:
            audio = _download_meeting_audio(client, bucket, t["storage_path"])
        except Exception as e:  # noqa: BLE001
            print(f"[transcribe] per_track download failed {t['storage_path']}: {e}")
            continue
        _ft, segs, secs = engine.transcribe(audio, 1, diarize=False)  # one voice per file
        total_ms = max(total_ms, int(secs) * 1000)
        for s in segs:
            merged.append({
                "start_ms": s.get("start_ms"),
                "end_ms": s.get("end_ms"),
                "text": s.get("text"),
                "confidence": s.get("confidence"),
                "speaker_member_id": t.get("member_id"),  # exact attribution
                "speaker_label": label,
            })

    merged.sort(key=lambda s: s["start_ms"] if s["start_ms"] is not None else 0)
    for i, s in enumerate(merged):
        s["seq"] = i
    full_text = "\n".join(f'{s["speaker_label"]}: {s["text"]}'
                          for s in merged if (s.get("text") or "").strip())
    seconds = int(round(total_ms / 1000)) or 1

    if merged:
        _rpc_quiet(client, "svc_write_transcript_segments", {
            "p_transcript_id": transcript_id, "p_segments": merged})
    engine_name = "azure_pertrack_v1"
    done = _rpc(client, "svc_finish_meeting_transcript", {
        "p_transcript_id": transcript_id, "p_status": "completed",
        "p_full_text": full_text, "p_engine": engine_name,
        "p_language": MEETING_TRANSCRIBE_LOCALE, "p_duration": seconds, "p_error": None})
    return {
        "transcript_id": transcript_id, "status": "completed", "mode": "per_track",
        "track_count": len(tracks),
        "segment_count": done.get("segment_count") if isinstance(done, dict) else None,
        "speaker_count": done.get("speaker_count") if isinstance(done, dict) else None,
        "language": MEETING_TRANSCRIBE_LOCALE, "engine": engine_name,
        "duration_seconds": seconds,
    }


@app.post("/rtc/transcribe")
def rtc_transcribe(recording_id: str, authorization: str = Header(default="")):
    """
    Manually transcribe a completed recording with diarization (B4b slice 1).

    Flow: authenticate the caller -> svc_start_meeting_transcript (which enforces
    room membership, recording-completed, and the ai_minutes_enabled credit gate
    + is idempotent) -> download the .ogg -> Azure fast transcription w/
    diarization -> store segments -> finish. Synchronous (meeting clips are
    short). On any engine error the transcript row is marked 'failed' (never left
    dangling) and a 502 is returned.
    """
    return _transcribe_recording_core(
        get_service_client(), recording_id, resolve_member(authorization)["id"])


def _transcribe_recording_core(client, recording_id: str, member_id: str) -> dict:
    """
    Shared transcribe core (HTTP endpoint + B4b.2 minutes auto-trigger worker).
    member_id must be a room member; the worker passes the recording's started_by.
    """
    # Create/return the transcript row (authorization + gating live in the RPC).
    tr = _rpc(client, "svc_start_meeting_transcript", {
        "p_recording_id": recording_id,
        "p_member_id": member_id,
    })
    if not isinstance(tr, dict) or not tr.get("id"):
        raise HTTPException(status_code=500, detail="Could not start transcript")
    transcript_id = tr["id"]

    # Already done on a prior call? Return it without spending Azure credit again.
    if tr.get("status") == "completed":
        return {"transcript_id": transcript_id, "status": "completed",
                "segment_count": tr.get("segment_count"), "speaker_count": tr.get("speaker_count"),
                "language": tr.get("language"), "engine": tr.get("engine"), "reused": True}

    # Look up the recording's mode/bucket/path/room (service role; already authorized).
    rec_rows = (client.table("meeting_recordings")
                .select("storage_bucket, storage_path, room_id, recording_mode")
                .eq("id", recording_id).limit(1).execute().data) or []
    if not rec_rows:
        _rpc_quiet(client, "svc_finish_meeting_transcript", {
            "p_transcript_id": transcript_id, "p_status": "failed",
            "p_error": "recording not found"})
        raise HTTPException(status_code=404, detail="Recording not found")
    rec = rec_rows[0]

    # per_track: transcribe each participant file and merge (exact attribution).
    if (rec.get("recording_mode") or "composite") == "per_track":
        try:
            return _transcribe_per_track(client, recording_id, transcript_id, rec)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            _rpc_quiet(client, "svc_finish_meeting_transcript", {
                "p_transcript_id": transcript_id, "p_status": "failed",
                "p_error": str(e)[:500]})
            print(f"[transcribe] per_track failed for recording {recording_id}: {e}")
            raise HTTPException(status_code=502, detail="Per-track transcription failed")

    # composite (fallback): single mixed file with diarization.
    if not rec.get("storage_path"):
        _rpc_quiet(client, "svc_finish_meeting_transcript", {
            "p_transcript_id": transcript_id, "p_status": "failed",
            "p_error": "recording has no storage_path"})
        raise HTTPException(status_code=404, detail="Recording file not found")
    bucket = rec.get("storage_bucket") or RECORDINGS_BUCKET

    try:
        audio = _download_meeting_audio(client, bucket, rec["storage_path"])
        max_spk = _meeting_max_speakers(client, rec["room_id"])
        engine = _get_meeting_transcriber()
        full_text, segments, seconds = engine.transcribe(audio, max_spk)

        if segments:
            _rpc_quiet(client, "svc_write_transcript_segments", {
                "p_transcript_id": transcript_id,
                "p_segments": segments,
            })
        done = _rpc(client, "svc_finish_meeting_transcript", {
            "p_transcript_id": transcript_id,
            "p_status": "completed",
            "p_full_text": full_text,
            "p_engine": engine.name,
            "p_language": MEETING_TRANSCRIBE_LOCALE,
            "p_duration": seconds,
            "p_error": None,
        })
        return {
            "transcript_id": transcript_id,
            "status": "completed",
            "segment_count": done.get("segment_count") if isinstance(done, dict) else None,
            "speaker_count": done.get("speaker_count") if isinstance(done, dict) else None,
            "max_speakers_sent": max_spk,
            "language": MEETING_TRANSCRIBE_LOCALE,
            "engine": engine.name,
            "duration_seconds": seconds,
        }
    except Exception as e:  # noqa: BLE001 - mark failed, surface a clean error
        _rpc_quiet(client, "svc_finish_meeting_transcript", {
            "p_transcript_id": transcript_id, "p_status": "failed",
            "p_error": str(e)[:500]})
        print(f"[transcribe] failed for recording {recording_id}: {e}")
        raise HTTPException(status_code=502, detail="Transcription failed")


# ============================================================================
# Stage B - B4c: AI meeting minutes from a transcript.
#
# Reuses the ai_artifacts provenance machine (007) via the 018/019 svc_* RPCs:
# minutes are a typed artifact (meeting_minutes) that goes transcribed->drafted
# and later review/sign (B4d). Decisions + EXPLICIT action items are written as
# confirmed extractions; in 'detailed' style, INFERRED follow-ups are written
# separately as kind='suggested' (offset seq) so they can never masquerade as
# confirmed clinical instructions - the clinician promotes them at review.
#
# Engine identity is a LABEL ('minutes_v1'), never a model name. Conservative by
# construction: the prompt forbids inventing facts and separates 'said' from
# 'suggested'. Residency note (B4c hardening, not a blocker): move this Azure
# OpenAI deployment to an Asia region + disable prompt retention before launch.
# ============================================================================
import re as _re_minutes


def _parse_minutes_json(raw: str) -> dict:
    """Defensively parse the model's JSON (tolerate code fences / stray prose)."""
    s = (raw or "").strip()
    if s.startswith("```"):
        s = _re_minutes.sub(r"^```[a-zA-Z]*\n?", "", s)
        s = _re_minutes.sub(r"\n?```$", "", s).strip()
    try:
        return json.loads(s)
    except Exception:
        m = _re_minutes.search(r"\{.*\}", s, _re_minutes.DOTALL)  # first {...} block
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    raise ValueError("minutes model did not return valid JSON")


class FakeMinutes:
    name = "minutes_fake_v0"

    def generate(self, transcript: str, style: str) -> dict:
        out = {
            "minutes": "[fake] MDT summary: mild hoarseness discussed; voice therapy plan agreed.",
            "decisions": [{"text": "Start voice therapy twice weekly"}],
            "action_items": [{"text": "Book first voice therapy session", "owner_hint": "SLP", "due_hint": "this week"}],
        }
        if style == "detailed":
            out["suggested_action_items"] = [
                {"text": "Consider GERD review (implied, confirm)", "owner_hint": "GP", "due_hint": None}
            ]
        return out


class MinutesGenerator:
    name = "minutes_v1"  # provenance LABEL, never a model name

    _BASE = (
        "You are a clinical meeting-minutes assistant for a Hong Kong allied-health / MDT team. "
        "You receive a diarized speech-to-text transcript of a multi-party clinical meeting. It is "
        "Hong Kong Cantonese mixed with English clinical terms and MAY contain transcription errors, "
        "especially at Cantonese-English boundaries. "
        "Produce DRAFT minutes for a clinician to review. Hard rules: "
        "(1) NEVER invent clinical facts, names, numbers, doses, or recommendations not supported by "
        "the transcript. If unclear, omit rather than guess. "
        "(2) Keep the original language mix; do NOT translate. Use Hong Kong written-Cantonese "
        "conventions and Traditional Chinese; preserve English terms exactly. "
        "(3) A 'decision' is something the group EXPLICITLY agreed. An 'action_item' is a task someone "
        "was EXPLICITLY asked to do; capture owner_hint (the name/role as said) and due_hint (the timing "
        "as said) only if stated, else null. Do not assign owners that were not named. "
        "(4) Output ONLY a single JSON object, no markdown, no preamble."
    )
    _TIGHT = (
        " Style: TIGHT. Include only explicitly-stated decisions and action items. "
        'JSON shape: {"minutes": "<concise prose summary>", '
        '"decisions": [{"text": "..."}], '
        '"action_items": [{"text": "...", "owner_hint": "...|null", "due_hint": "...|null"}]}.'
    )
    _DETAILED = (
        " Style: DETAILED. In addition to explicit decisions/action items, you MAY add inferred "
        "follow-ups the discussion IMPLIED but did not explicitly assign - but ONLY in a separate "
        "'suggested_action_items' array, each phrased as a suggestion to confirm, never as fact. "
        'JSON shape: {"minutes": "<prose summary, may include a brief topic structure>", '
        '"decisions": [{"text": "..."}], '
        '"action_items": [{"text": "...", "owner_hint": "...|null", "due_hint": "...|null"}], '
        '"suggested_action_items": [{"text": "... (confirm)", "owner_hint": "...|null", "due_hint": "...|null"}]}.'
    )

    def __init__(self, endpoint: str, key: str, deployment: str, api_version: str):
        self.endpoint = endpoint.rstrip("/")
        self.key, self.deployment, self.api_version = key, deployment, api_version

    def generate(self, transcript: str, style: str) -> dict:
        system = self._BASE + (self._DETAILED if style == "detailed" else self._TIGHT)
        url = (f"{self.endpoint}/openai/deployments/{self.deployment}"
               f"/chat/completions?api-version={self.api_version}")
        body = {
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": (transcript or "").strip()},
            ],
            "temperature": 0.2,
            "max_tokens": 1500,
        }
        r = httpx.post(url, headers={"api-key": self.key, "Content-Type": "application/json"},
                       json=body, timeout=90)
        r.raise_for_status()
        content = (r.json()["choices"][0]["message"]["content"] or "").strip()
        return _parse_minutes_json(content)


def get_minutes_generator():
    if AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_KEY and AZURE_OPENAI_DEPLOYMENT:
        return MinutesGenerator(AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY,
                                AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_VERSION)
    return FakeMinutes()


def _completed_transcript_for(client, recording_id: str):
    rows = (client.table("meeting_transcripts")
            .select("id, room_id, full_text, status")
            .eq("recording_id", recording_id).eq("status", "completed")
            .order("created_at", desc=True).limit(1).execute().data) or []
    return rows[0] if rows else None


@app.post("/rtc/minutes")
def rtc_minutes(recording_id: str, style: str = "tight", authorization: str = Header(default="")):
    """
    Generate AI minutes for a recording's completed transcript (B4c).

    style = 'tight' (explicit only) | 'detailed' (adds flagged suggested items).
    Flow: find the completed transcript -> svc_create_minutes_artifact (gates on
    membership + ai_minutes) -> LLM -> svc_set_minutes_draft (the prose) ->
    svc_write_meeting_extractions (decisions + explicit actions) -> if detailed,
    svc_write_suggested_action_items (inferred, offset seq). Idempotent on the
    artifact: a second call returns the existing drafted minutes without re-spend.
    """
    if style not in ("tight", "detailed"):
        raise HTTPException(status_code=400, detail="style must be 'tight' or 'detailed'")
    return _minutes_recording_core(
        get_service_client(), recording_id, resolve_member(authorization)["id"], style)


def _minutes_recording_core(client, recording_id: str, member_id: str, style: str) -> dict:
    """
    Shared minutes-generation core (HTTP endpoint + B4b.2 auto-trigger worker).
    member_id must be a room member; the worker passes the recording's started_by.
    Assumes style already validated ('tight' | 'detailed').
    """
    tr = _completed_transcript_for(client, recording_id)
    if not tr:
        raise HTTPException(status_code=409, detail="No completed transcript for this recording (run /rtc/transcribe first)")
    transcript_id = tr["id"]

    art = _rpc(client, "svc_create_minutes_artifact", {
        "p_transcript_id": transcript_id, "p_member_id": member_id})
    if not isinstance(art, dict) or not art.get("id"):
        raise HTTPException(status_code=500, detail="Could not create minutes artifact")
    artifact_id = art["id"]

    # Already drafted on a prior call -> return it without re-spending the LLM.
    if art.get("state") in ("drafted", "under_review", "approved", "posted"):
        return {"minutes_artifact_id": artifact_id, "state": art["state"], "reused": True}

    try:
        engine = get_minutes_generator()
        result = engine.generate(tr.get("full_text") or "", style)

        minutes_text = (result.get("minutes") or "").strip()
        decisions = [{"seq": i, "text": (d.get("text") or "").strip()}
                     for i, d in enumerate(result.get("decisions") or []) if (d.get("text") or "").strip()]
        actions = [{"seq": i, "text": (a.get("text") or "").strip(),
                    "owner_hint": a.get("owner_hint"), "due_hint": a.get("due_hint")}
                   for i, a in enumerate(result.get("action_items") or []) if (a.get("text") or "").strip()]
        suggested = []
        if style == "detailed":
            suggested = [{"seq": 1000 + i, "text": (s.get("text") or "").strip(),
                          "owner_hint": s.get("owner_hint"), "due_hint": s.get("due_hint")}
                         for i, s in enumerate(result.get("suggested_action_items") or []) if (s.get("text") or "").strip()]

        _rpc(client, "svc_set_minutes_draft", {
            "p_artifact_id": artifact_id, "p_member_id": member_id,
            "p_draft": minutes_text, "p_engine_version": engine.name})
        _rpc_quiet(client, "svc_write_meeting_extractions", {
            "p_transcript_id": transcript_id, "p_minutes_artifact_id": artifact_id,
            "p_member_id": member_id, "p_decisions": decisions, "p_action_items": actions})
        if suggested:
            _rpc_quiet(client, "svc_write_suggested_action_items", {
                "p_transcript_id": transcript_id, "p_minutes_artifact_id": artifact_id,
                "p_member_id": member_id, "p_items": suggested})

        return {
            "minutes_artifact_id": artifact_id, "state": "drafted", "style": style,
            "decision_count": len(decisions), "action_item_count": len(actions),
            "suggested_count": len(suggested), "engine": engine.name,
        }
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"[minutes] failed for recording {recording_id}: {e}")
        raise HTTPException(status_code=502, detail="Minutes generation failed")


@app.get("/rtc/minutes")
def rtc_minutes_read(recording_id: str, authorization: str = Header(default="")):
    """Read back the minutes draft + decisions + action items (explicit + suggested)."""
    m = resolve_member(authorization)
    client = get_service_client()

    tr = _completed_transcript_for(client, recording_id)
    if not tr:
        raise HTTPException(status_code=404, detail="No completed transcript for this recording")
    # membership gate
    if not (client.table("room_members").select("id")
            .eq("room_id", tr["room_id"]).eq("member_id", m["id"]).limit(1).execute().data or []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    transcript_id = tr["id"]

    art_rows = (client.table("ai_artifacts")
                .select("id, state, ai_draft, edited_text, approved_text, ai_engine_version")
                .eq("source_transcript_id", transcript_id).eq("artifact_type", "meeting_minutes")
                .neq("state", "discarded").order("created_at", desc=True).limit(1).execute().data) or []
    art = art_rows[0] if art_rows else None

    decisions = (client.table("meeting_decisions").select("seq, text")
                 .eq("transcript_id", transcript_id).order("seq").execute().data) or []
    actions = (client.table("meeting_action_items")
               .select("id, seq, text, owner_hint, due_hint, status, kind, owner_member_id, promoted_at")
               .eq("transcript_id", transcript_id).order("seq").execute().data) or []

    return {
        "minutes": art,
        "decisions": decisions,
        "action_items": [a for a in actions if a.get("kind") == "explicit"],
        "suggested_action_items": [a for a in actions if a.get("kind") == "suggested"],
    }


# ============================================================================
# Stage B - B4d: clinician review/sign endpoints (thin wrappers over the 022
# service-role RPCs). Each authenticates the caller and passes an explicit
# p_member_id; the RPC does the membership check and drives the provenance guard.
# ============================================================================
def _none_if_blank(s):
    return s if (s is not None and s != "") else None


@app.get("/rtc/transcript")
def rtc_transcript_read(recording_id: str, authorization: str = Header(default="")):
    """Read a recording's transcript segments (with pre-filled per-track speaker
    attribution) for the review screen."""
    m = resolve_member(authorization)
    client = get_service_client()
    tr = _completed_transcript_for(client, recording_id)
    if not tr:
        raise HTTPException(status_code=404, detail="No completed transcript for this recording")
    if not (client.table("room_members").select("id")
            .eq("room_id", tr["room_id"]).eq("member_id", m["id"]).limit(1).execute().data or []):
        raise HTTPException(status_code=403, detail="Not a member of this room")
    segs = (client.table("transcript_segments")
            .select("id, seq, speaker_label, speaker_member_id, start_ms, end_ms, text, confidence")
            .eq("transcript_id", tr["id"]).order("seq").execute().data) or []
    return {"transcript_id": tr["id"], "segments": segs}


@app.post("/rtc/segment-speaker")
def rtc_segment_speaker(segment_id: str, speaker_member_id: str = "",
                        speaker_label: str = "", authorization: str = Header(default="")):
    """Confirm/correct a segment's speaker (per-track pre-fills it)."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_set_segment_speaker", {
        "p_segment_id": segment_id, "p_member_id": m["id"],
        "p_speaker_member_id": _none_if_blank(speaker_member_id),
        "p_speaker_label": _none_if_blank(speaker_label),
    })
    return {"segment": row}


@app.post("/rtc/minutes/review")
def rtc_minutes_review(artifact_id: str, authorization: str = Header(default="")):
    """Move minutes drafted -> under_review."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_begin_minutes_review", {
        "p_artifact_id": artifact_id, "p_member_id": m["id"]})
    return {"minutes": row}


@app.post("/rtc/minutes/edit")
def rtc_minutes_edit(artifact_id: str, text: str = Body(..., embed=True),
                     authorization: str = Header(default="")):
    """Save the clinician's working edits (keeps state; blocked once signed)."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_save_minutes_edit", {
        "p_artifact_id": artifact_id, "p_member_id": m["id"], "p_edited_text": text})
    return {"minutes": row}


@app.post("/rtc/minutes/approve")
def rtc_minutes_approve(artifact_id: str, text: str = Body(..., embed=True),
                        authorization: str = Header(default="")):
    """Sign the minutes: (drafted|under_review) -> approved, recording the signer.
    This is the provenance event."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_approve_minutes", {
        "p_artifact_id": artifact_id, "p_member_id": m["id"], "p_text": text})
    return {"minutes": row}


@app.post("/rtc/action-item/promote")
def rtc_action_item_promote(action_item_id: str, authorization: str = Header(default="")):
    """Promote a suggested action item to confirmed (kind='explicit', promoted_at)."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_promote_action_item", {
        "p_action_item_id": action_item_id, "p_member_id": m["id"]})
    return {"action_item": row}


@app.post("/rtc/action-item/status")
def rtc_action_item_status(action_item_id: str, status: str,
                           authorization: str = Header(default="")):
    """Set an action item's status: open | done | cancelled."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_set_action_item_status", {
        "p_action_item_id": action_item_id, "p_member_id": m["id"], "p_status": status})
    return {"action_item": row}


@app.post("/rtc/action-item/owner")
def rtc_action_item_owner(action_item_id: str, owner_member_id: str = "",
                          authorization: str = Header(default="")):
    """Map an action item's owner to a real member (blank clears it)."""
    m = resolve_member(authorization)
    client = get_service_client()
    row = _rpc(client, "svc_set_action_item_owner", {
        "p_action_item_id": action_item_id, "p_member_id": m["id"],
        "p_owner_member_id": _none_if_blank(owner_member_id)})
    return {"action_item": row}
