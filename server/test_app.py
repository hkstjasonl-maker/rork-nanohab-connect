"""Verification: prove the scaffold boots and the endpoints behave, using a
fake Supabase client so we don't need the real project or service_role key.
The real Supabase round-trip is verified AFTER deploy with a live token."""
from types import SimpleNamespace
import main
from fastapi.testclient import TestClient

client = TestClient(main.app)

# --- Fakes that mimic the supabase-py method chain we use -------------------
class FakeQuery:
    def __init__(self, rows): self._rows = rows
    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def limit(self, *a, **k): return self
    def execute(self): return SimpleNamespace(data=self._rows)

class FakeAuth:
    def __init__(self, user): self._user = user
    def get_user(self, token):
        if token == "good": return SimpleNamespace(user=self._user)
        raise Exception("bad token")

class FakeClient:
    def __init__(self, user, rows):
        self.auth = FakeAuth(user); self._rows = rows
    def table(self, name): return FakeQuery(self._rows)

def install_fake(user, rows):
    main.get_service_client = lambda: FakeClient(user, rows)

PASS = 0
def check(label, cond):
    global PASS
    assert cond, f"FAIL: {label}"
    PASS += 1; print(f"  ok  {label}")

# 1) health
r = client.get("/")
check("health 200", r.status_code == 200)
check("health status ok", r.json()["status"] == "ok")
check("health reports not-configured here", r.json()["configured"] is False)

# 2) whoami missing token -> 401
r = client.get("/whoami")
check("whoami no header -> 401", r.status_code == 401)

# 3) whoami bad token -> 401
install_fake(SimpleNamespace(id="auth-123"), [])
r = client.get("/whoami", headers={"Authorization": "Bearer wrong"})
check("whoami bad token -> 401", r.status_code == 401)

# 4) whoami good token but no member row -> 404
install_fake(SimpleNamespace(id="auth-123"), [])
r = client.get("/whoami", headers={"Authorization": "Bearer good"})
check("whoami no member -> 404", r.status_code == 404)

# 5) whoami good token + member -> 200 with resolved member
install_fake(
    SimpleNamespace(id="auth-123"),
    [{"id": "mem-1", "org_id": "org-1", "full_name": "Jeffrey Choi", "org_role": "org_owner"}],
)
r = client.get("/whoami", headers={"Authorization": "Bearer good"})
check("whoami resolves member -> 200", r.status_code == 200)
check("whoami returns member_id", r.json()["member_id"] == "mem-1")
check("whoami returns org_role", r.json()["org_role"] == "org_owner")

print(f"\nALL {PASS} CHECKS PASSED")
