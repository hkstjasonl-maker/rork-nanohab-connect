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

import hmac
import json
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client
from livekit import api as livekit_api

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

LIVEKIT_URL = os.environ.get("LIVEKIT_URL", "")
LIVEKIT_API_KEY = os.environ.get("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.environ.get("LIVEKIT_API_SECRET", "")

OPERATOR_API_KEY = os.environ.get("OPERATOR_API_KEY", "")

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

app = FastAPI(title="NanoHab Connect API", version="0.11.0")

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

    return s


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
    return {"session": data}


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
    return {"session": data}


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
