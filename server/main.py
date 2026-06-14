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
import os
from datetime import timedelta

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

app = FastAPI(title="NanoHab Connect API", version="0.6.0")

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
# Transcription worker (Stage A8.2b)
#
# The queue (jobs, concurrency cap, retry/backoff, per-org quota) lives in the
# database. This worker is the drain: it claims due jobs, transcribes each via a
# PLUGGABLE engine, then completes or fails them through the SQL RPCs. The
# engine is swappable — the fake below proves the loop with no provider/keys;
# real engines (Azure zh-HK, a self-hosted Cantonese model) implement the same
# transcribe(audio, language) -> (text, seconds) contract and slot into
# get_transcriber(). That routing seam is how "both engines" stays cheap.
# ----------------------------------------------------------------------------


class FakeTranscriber:
    """Stand-in engine: returns a canned transcript so we can prove the drain
    loop end-to-end without any provider, key, or cost."""

    name = "fake_v0"

    def transcribe(self, audio: bytes, language: str):
        return (f"[fake transcript \u00b7 {language}]", 5)


def get_transcriber(language: str):
    """Routing seam for 'both engines': choose the engine per language. For now
    one fake engine; later e.g. a self-hosted Cantonese model for 'yue' and
    Azure zh-HK for 'en'/'cmn', with failover between them."""
    return FakeTranscriber()


@app.post("/drain")
def drain(x_operator_key: str = Header(default=""), limit: int = 10):
    """
    Drain the transcription queue, within the DB-enforced concurrency cap.

    Intended to be called on a schedule (Cloud Scheduler). Claims due jobs,
    transcribes each through the pluggable engine, and records the outcome:
    success -> set_transcript + complete_transcription_job (usage metered);
    failure -> fail_transcription_job (retry with backoff, then dead-letter).
    A failed transcription never loses the recording — the artifact stays put.
    Gated by the operator key, like the other /ops surface.
    """
    require_operator(x_operator_key)
    client = get_service_client()

    claimed = (client.rpc("claim_transcription_jobs", {"p_limit": limit}).execute().data) or []
    summary = {"claimed": len(claimed), "succeeded": 0, "failed": 0}

    for job in claimed:
        job_id = job["job_id"]
        artifact_id = job["artifact_id"]
        try:
            # A real engine would download the audio from storage here; the fake
            # engine ignores it. Language will come from the artifact's chosen
            # language once the record-time selector ships; default Cantonese.
            language = "yue"
            engine = get_transcriber(language)
            text, seconds = engine.transcribe(b"", language)
            client.rpc(
                "set_transcript",
                {"p_artifact_id": artifact_id, "p_transcript": text, "p_engine": engine.name},
            ).execute()
            client.rpc(
                "complete_transcription_job",
                {"p_job_id": job_id, "p_seconds": seconds},
            ).execute()
            summary["succeeded"] += 1
        except Exception as e:  # noqa: BLE001 - any engine error -> fail the job
            client.rpc(
                "fail_transcription_job",
                {"p_job_id": job_id, "p_error": str(e)[:500]},
            ).execute()
            summary["failed"] += 1

    return summary


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


def get_structurer(language: str):
    """Routing seam: pick the LLM engine per language/use. One fake for now."""
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
