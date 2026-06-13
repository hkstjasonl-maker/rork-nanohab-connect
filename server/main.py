"""
NanoHab Connect — backend API (Cloud Run).

This is the TRUSTED server. It is the ONLY place the Supabase service_role key
lives. The service_role key bypasses Row Level Security, so every endpoint that
uses it MUST first verify *who is calling* (from their Supabase access token)
and scope all data access to that verified user. Never trust a caller-supplied
id; only trust the id derived from a verified token.

Stage 0 scope (build small, verify, then grow):
  GET /          -> health check (public; used by Cloud Run + uptime checks)
  GET /whoami    -> server-side member helper: verify token -> resolve member

Config comes from environment variables (set these in Cloud Run, never in code):
  SUPABASE_URL                -> https://<ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY   -> server-only secret (bypasses RLS)
"""

import os

from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import Client, create_client

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

app = FastAPI(title="NanoHab Connect API", version="0.1.0")

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
        # Misconfiguration should fail loudly, not silently behave wrongly.
        raise HTTPException(status_code=500, detail="Server is not configured")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)


@app.get("/")
def health():
    """Public health check. No secrets returned — only whether config is present."""
    return {
        "status": "ok",
        "service": "nanohab-connect-api",
        "version": app.version,
        "configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
    }


@app.get("/whoami")
def whoami(authorization: str = Header(default="")):
    """
    Server-side equivalent of the app's getCurrentMemberId().

    Flow: read the caller's Supabase access token from the Authorization header,
    verify it with Supabase to get the real auth user, then look up their member
    row. Because the service_role client bypasses RLS, scoping is enforced HERE
    by only querying for the verified user's auth_user_id.
    """
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Empty bearer token")

    client = get_service_client()

    # 1) Verify the token -> the real user. Never trust a client-supplied id.
    try:
        user_resp = client.auth.get_user(token)
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")
    user = getattr(user_resp, "user", None)
    if user is None or getattr(user, "id", None) is None:
        raise HTTPException(status_code=401, detail="Invalid token")

    # 2) Resolve the member for THIS verified user only.
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

    m = rows[0]
    return {
        "member_id": m["id"],
        "org_id": m["org_id"],
        "full_name": m["full_name"],
        "org_role": m["org_role"],
    }
