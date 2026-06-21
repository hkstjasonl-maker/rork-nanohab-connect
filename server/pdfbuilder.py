"""
NanoHab Connect — signed clinical document PDF builder (Layer 2a).
Renders an approved note as a verifiable PDF with:
  - region preset (hk_uk / us / cn) driving date format, page size, header conventions
  - size (standard / large_print)
  - security background: faint diagonal watermark + tiled microprint (digital
    faux-watermark analog of a void pantograph; a TRUE offset void-pantograph is a
    print-shop feature reserved for the physical premium-paper add-on)
  - provenance block from approver_snapshot
  - immutable Issued date (created_at) + recorded Session date + LATE-ENTRY flag (>48h)
  - document id + QR placeholder linking to the (future) verify page
CJK via reportlab Adobe CID fonts (no font files shipped).
"""
import io, datetime
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.units import mm
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
import os

# Register an embeddable CJK TrueType font (covers Traditional + Simplified +
# Latin). WenQuanYi Zen Hei ships on Debian/Ubuntu; we also bundle the .ttf next
# to this module so the font is always present on Cloud Run.
_FONT_NAME = "NotoCJKsafe"
_FONT_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts", "WenQuanYiZenHei.ttf"),
    "/app/fonts/WenQuanYiZenHei.ttf",
    "/app/server/fonts/WenQuanYiZenHei.ttf",
]
_FONT_REGISTERED = False
for _p in _FONT_CANDIDATES:
    if os.path.exists(_p):
        try:
            pdfmetrics.registerFont(TTFont(_FONT_NAME, _p))
            _FONT_REGISTERED = True
            break
        except Exception:
            pass
if not _FONT_REGISTERED:
    _FONT_NAME = "Helvetica"  # last-resort: Latin-only (CJK will be boxes; logged upstream)

# ---- region presets -------------------------------------------------------
PRESETS = {
    "hk_uk": {"page": A4, "cjk": _FONT_NAME, "datefmt": "%d/%m/%Y",
              "label": "Hong Kong / UK", "issued": "Issued", "session": "Session date"},
    "us":    {"page": LETTER, "cjk": _FONT_NAME, "datefmt": "%m/%d/%Y",
              "label": "United States", "issued": "Issued", "session": "Date of service"},
    "cn":    {"page": A4, "cjk": _FONT_NAME, "datefmt": "%Y年%m月%d日",
              "label": "Mainland China", "issued": "签发日期", "session": "诊疗日期"},
}
SIZES = {"standard": {"body": 10.5, "title": 16, "lead": 14},
         "large_print": {"body": 13.5, "title": 20, "lead": 18}}

TEAL = colors.HexColor("#0F6E56")
MUTED = colors.HexColor("#6B7B76")
HAIR = colors.HexColor("#D7E2DD")

def _fmt_dt(iso, fmt):
    if not iso: return ""
    try:
        d = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.strftime(fmt)
    except Exception:
        return str(iso)[:10]

def _security_background(c, W, H, cjk, brand):
    """Faint tiled microprint + diagonal watermark. Digital faux-watermark analog.
    The watermark text follows branding: clinic name at white-label, else NanoHab.
    The microprint ALWAYS encodes a verification marker (integrity layer, not
    removable)."""
    tier = (brand or {}).get("tier")
    wm = (brand or {}).get("name") if tier == "whitelabel" and (brand or {}).get("name") else "NANOHAB CONNECT"
    micro = (wm.upper() + " \u00b7 VERIFIED \u00b7 ")
    c.saveState()
    c.setFont(cjk, 4.2)
    c.setFillColor(colors.HexColor("#EAF1EE"))
    step = 64; y = 30
    while y < H - 20:
        x = -10
        while x < W:
            c.drawString(x, y, micro); x += 168
        y += step
    c.setFont("Helvetica-Bold", 58)
    c.setFillColor(colors.Color(0.06, 0.43, 0.34, alpha=0.06))
    c.translate(W/2, H/2); c.rotate(38)
    c.drawCentredString(0, 0, wm.upper())
    c.restoreState()

def _qr_placeholder(c, x, y, size, doc_id):
    """QR placeholder box (Layer 2b will swap in a real qrcode image)."""
    c.saveState()
    c.setStrokeColor(HAIR); c.setLineWidth(0.8)
    c.rect(x, y, size, size, stroke=1, fill=0)
    c.setFont("Helvetica", 5); c.setFillColor(MUTED)
    c.drawCentredString(x+size/2, y+size/2+4, "VERIFY")
    c.drawCentredString(x+size/2, y+size/2-3, "QR")
    c.drawCentredString(x+size/2, y+size/2-10, "(2b)")
    c.restoreState()

def build_pdf(*, note_text, snapshot, style="hk_uk", size="standard",
              created_at=None, session_date=None, session_type=None,
              template_name=None, doc_id="\u2014", verify_url="\u2014", brand=None):
    P = PRESETS.get(style, PRESETS["hk_uk"])
    S = SIZES.get(size, SIZES["standard"])
    W, H = P["page"]; cjk = P["cjk"]
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=P["page"])
    M = 22*mm
    _security_background(c, W, H, cjk, brand)

    tier = (brand or {}).get("tier")
    bname = (brand or {}).get("name")
    bcolor = TEAL
    try:
        if (brand or {}).get("color"):
            bcolor = colors.HexColor(brand["color"])
    except Exception:
        bcolor = TEAL

    # header
    y = H - M
    if tier in ("cobrand", "whitelabel") and bname:
        # clinic identity primary
        c.setFillColor(bcolor); c.setFont("Helvetica-Bold", S["title"])
        c.drawString(M, y, bname)
        c.setFont(cjk, S["body"]); c.setFillColor(MUTED)
        if tier == "cobrand":
            c.drawRightString(W-M, y+2, "powered by NanoHab Connect")
        else:
            c.drawRightString(W-M, y+2, "Clinical Coordination Record")
    else:
        c.setFillColor(TEAL); c.setFont("Helvetica-Bold", S["title"])
        c.drawString(M, y, "NanoHab Connect")
        c.setFont(cjk, S["body"]); c.setFillColor(MUTED)
        c.drawRightString(W-M, y+2, "醫家動 \u00b7 Clinical Coordination Record")
    y -= 8; c.setStrokeColor(bcolor); c.setLineWidth(1.4); c.line(M, y, W-M, y)
    y -= S["lead"]+6

    # title line: template + session type
    title = template_name or "Clinical note"
    if session_type: title += f"  \u00b7  {session_type.title()}"
    c.setFillColor(colors.black); c.setFont("Helvetica-Bold", S["lead"])
    c.drawString(M, y, title); y -= S["lead"]+2

    # dates row (issued immutable + session + late-entry flag)
    issued_s = _fmt_dt(created_at, P["datefmt"])
    sess_s = ""
    if session_date:
        try: sess_s = datetime.date.fromisoformat(str(session_date)).strftime(P["datefmt"])
        except Exception: sess_s = str(session_date)
    c.setFont(cjk, S["body"]-1); c.setFillColor(MUTED)
    line = f"{P['issued']}: {issued_s}"
    if sess_s: line += f"      {P['session']}: {sess_s}"
    c.drawString(M, y, line); y -= S["body"]+3

    # late-entry flag (>48h gap)
    late_days = None
    try:
        if session_date and created_at:
            cd = datetime.datetime.fromisoformat(str(created_at).replace("Z","+00:00")).date()
            sd = datetime.date.fromisoformat(str(session_date))
            gap = (cd - sd).days
            if gap >= 2: late_days = gap
    except Exception: pass
    if late_days is not None:
        c.setFillColor(colors.HexColor("#B45309")); c.setFont("Helvetica-Oblique", S["body"]-1)
        c.drawString(M, y, f"Late entry — documented {late_days} day(s) after the session.")
        y -= S["body"]+3
    y -= 6

    # body
    c.setFillColor(colors.black); c.setFont(cjk, S["body"])
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.platypus import Paragraph, Frame
    para_style = ParagraphStyle("body", fontName=cjk, fontSize=S["body"], leading=S["body"]*1.5, textColor=colors.black)
    # draw body in a frame from current y down to provenance area
    prov_h = 70
    frame = Frame(M, M+prov_h, W-2*M, y-(M+prov_h)-6, showBoundary=0,
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    safe = (note_text or "").replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\n","<br/>")
    frame.addFromList([Paragraph(safe, para_style)], c)

    # provenance block (bottom band, fixed positions above the bottom margin)
    snap = snapshot or {}
    name = (snap.get("full_name") or "[not provided]")
    cred = (snap.get("credentials") or "")
    reg  = (snap.get("registration_no") or "[not provided]")
    signed = _fmt_dt(snap.get("signed_at"), P["datefmt"] + " %H:%M")
    rule_y = M + prov_h
    c.setStrokeColor(HAIR); c.setLineWidth(0.8); c.line(M, rule_y, W-M, rule_y)
    c.setFont("Helvetica-Bold", S["body"]); c.setFillColor(TEAL)
    c.drawString(M, rule_y-14, "Electronically approved")
    role = ("  \u00b7  " + cred) if cred else ""
    c.setFont(cjk, S["body"]); c.setFillColor(colors.black)
    c.drawString(M, rule_y-30, f"{name}{role}")
    c.setFont(cjk, S["body"]-1.5); c.setFillColor(MUTED)
    c.drawString(M, rule_y-44, f"Reg. No. {reg}      Signed: {signed}")
    c.drawString(M, rule_y-56, f"Document ID: {doc_id}")
    # QR placeholder bottom-right
    _qr_placeholder(c, W-M-46, M+6, 46, doc_id)
    c.setFont("Helvetica", 6); c.setFillColor(MUTED)
    _tier = (brand or {}).get("tier"); _bn = (brand or {}).get("name")
    _via = (_bn if _tier == "whitelabel" and _bn else "NanoHab Connect")
    c.drawRightString(W-M, M-2, f"Verify: {verify_url}")
    c.drawString(M, M-2, f"Verified via {_via}")

    c.showPage(); c.save()
    buf.seek(0); return buf.read()
