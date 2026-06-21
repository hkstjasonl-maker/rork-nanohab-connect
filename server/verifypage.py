"""Server-rendered verify page (Layer 2b). Leak-proof: only verification facts.
Calm, official, trustworthy — built for someone checking a paper document on a phone."""
import datetime, html

def _fmt(iso, with_time=False):
    if not iso: return "\u2014"
    try:
        d = datetime.datetime.fromisoformat(str(iso).replace("Z","+00:00"))
        return d.strftime("%d %b %Y, %H:%M") if with_time else d.strftime("%d %b %Y")
    except Exception:
        return str(iso)[:10]

def render_verify_html(doc: dict | None, doc_id: str) -> str:
    # palette: deep clinical teal + warm paper + a single confident "verified" green.
    # type: a humanist sans for trust (system stack), tabular for the doc-id.
    found = doc is not None
    status = (doc or {}).get("status", "")
    valid = found and status == "valid"
    issuer = html.escape((doc or {}).get("verified_by") or "NanoHab Connect")

    if not found:
        verdict_label = "Not found"
        verdict_sub = "No document matches this code. Check the ID, or it may not have been issued."
        accent = "#B42318"; badge = "\u2715"
    elif valid:
        verdict_label = "Verified"
        verdict_sub = f"This is a genuine document issued through {issuer}."
        accent = "#0F7B5A"; badge = "\u2713"
    else:
        nice = {"revoked":"Revoked","superseded":"Superseded"}.get(status, status.title() or "Invalid")
        verdict_label = nice
        verdict_sub = "This document is no longer valid. Contact the issuer for a current version."
        accent = "#B45309"; badge = "!"

    signer = html.escape((doc or {}).get("signed_by") or "\u2014")
    creds = html.escape((doc or {}).get("credentials") or "")
    reg = html.escape((doc or {}).get("registration_no") or "\u2014")
    signed = _fmt((doc or {}).get("signed_at"))
    issued = _fmt((doc or {}).get("issued_at"), with_time=True)
    did = html.escape(doc_id)

    rows = ""
    if found:
        rows = f"""
        <dl class="facts">
          <div class="row"><dt>Signed by</dt><dd>{signer}{f' <span class="creds">{creds}</span>' if creds else ''}</dd></div>
          <div class="row"><dt>Registration</dt><dd class="mono">{reg}</dd></div>
          <div class="row"><dt>Date signed</dt><dd>{signed}</dd></div>
          <div class="row"><dt>Issued</dt><dd>{issued}</dd></div>
          <div class="row"><dt>Document ID</dt><dd class="mono">{did}</dd></div>
        </dl>"""

    return f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Document verification \u00b7 {issuer}</title>
<style>
  :root {{ --accent:{accent}; --ink:#1A2B26; --muted:#5E726B; --paper:#F6F4EF; --card:#FFFFFF; --line:#E4E9E6; }}
  * {{ box-sizing:border-box; }}
  html,body {{ margin:0; }}
  body {{ font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    background:var(--paper); color:var(--ink); line-height:1.5;
    -webkit-font-smoothing:antialiased; min-height:100vh;
    display:flex; align-items:flex-start; justify-content:center; padding:28px 18px 48px; }}
  .card {{ width:100%; max-width:440px; background:var(--card); border:1px solid var(--line);
    border-radius:18px; overflow:hidden; box-shadow:0 1px 2px rgba(20,40,34,.04),0 12px 32px rgba(20,40,34,.06); }}
  .top {{ padding:30px 26px 22px; text-align:center; border-bottom:1px solid var(--line); }}
  .badge {{ width:62px; height:62px; border-radius:50%; margin:0 auto 14px;
    display:flex; align-items:center; justify-content:center; font-size:30px; font-weight:700;
    color:#fff; background:var(--accent); box-shadow:0 6px 18px color-mix(in srgb, var(--accent) 32%, transparent); }}
  .verdict {{ font-size:24px; font-weight:750; letter-spacing:-.01em; margin:0 0 6px; color:var(--accent); }}
  .sub {{ font-size:14.5px; color:var(--muted); margin:0 auto; max-width:330px; }}
  .facts {{ margin:0; padding:8px 26px 8px; }}
  .row {{ display:flex; justify-content:space-between; gap:18px; padding:13px 0; border-bottom:1px solid var(--line); }}
  .row:last-child {{ border-bottom:0; }}
  dt {{ color:var(--muted); font-size:13.5px; flex:0 0 auto; }}
  dd {{ margin:0; text-align:right; font-size:14.5px; font-weight:550; }}
  .creds {{ display:block; font-weight:400; color:var(--muted); font-size:13px; }}
  .mono {{ font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13.5px; letter-spacing:.02em; }}
  .foot {{ padding:16px 26px 22px; text-align:center; border-top:1px solid var(--line); }}
  .foot .issuer {{ font-weight:650; font-size:13.5px; }}
  .foot .note {{ font-size:12px; color:var(--muted); margin-top:4px; }}
  @media (prefers-reduced-motion:no-preference) {{
    .card {{ animation:rise .5s cubic-bezier(.2,.7,.2,1) both; }}
    @keyframes rise {{ from {{ opacity:0; transform:translateY(10px); }} to {{ opacity:1; transform:none; }} }}
  }}
</style></head>
<body>
  <main class="card" role="main">
    <div class="top">
      <div class="badge" aria-hidden="true">{badge}</div>
      <h1 class="verdict">{verdict_label}</h1>
      <p class="sub">{verdict_sub}</p>
    </div>
    {rows}
    <div class="foot">
      <div class="issuer">{issuer}</div>
      <div class="note">Verification confirms authenticity only. No clinical information is shown here.</div>
    </div>
  </main>
</body></html>"""
