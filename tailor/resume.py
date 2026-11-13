"""Build a tailored resume from a JSON config in the user's own template, keeping its exact format.

Usage:  python3 tailor/resume.py cfg.json OUT_BASENAME   (writes OUT_BASENAME.docx and, with LibreOffice, .pdf)

tailor/template.docx      the user's own resume (format never changes; only paragraph text is replaced)
tailor/template_map.json  made once at setup from `python3 tailor/map_template.py`:
  {"summary": 4,                                  paragraph index of the summary
   "roles": [{"key": "role1", "employer": "Acme", "title": 8, "bullets": [9,10,11,12]}, ...],   most recent first
   "skills": [30, 31],                            skill lines written "Label: body" (label bold)
   "tools": 32, "certs": 33,                      optional "Tools:" / "Certifications:" lines
   "pages": 2}                                    required page count
cfg.json:
  summary: str
  <role key>: list of bullets (at least 3 each; the most recent role 4-6). "@KEY" = phrasing from tailor/bullets.json
  titles: optional {<role key>: "Title"} to adjust a title's wording (left of the tab only)
  skills: [[label, body], [label, body]]; tools / certs: optional bodies
  estimates: EST ids (dashboard reference/estimates) used by bullets you wrote; ids behind @KEY bullets
             (tailor/estimates.json) are added automatically and printed as "estimates" -> save on the jobs doc.
Rules enforced: every bullet shows a business result; every role has at least 3 bullets; the page count matches.
"""
import copy, json, os, re, subprocess, sys
import docx

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "template.docx")
MAP = json.load(open(os.path.join(HERE, "template_map.json"))) if os.path.exists(os.path.join(HERE, "template_map.json")) else None

RESULT = re.compile(r"\d[\d,.]*\s?%|\$\s?\d|\bfrom\b[^;]{0,40}?\bto\b[^;]{0,25}?(\d|minutes|hours)|\bto within\b|\b(halved|doubled|tripled)\b"
    r"|\bfrom (one|two|three|four|five|six|seven|eight|nine|ten|twelve)\b[^;]{0,30}\bto\b|\d+\s?(hours?|days?|weeks?)\b[^;]{0,30}(saved|per|cut)"
    r"|\bsav(ed|ing)\b[^;]{0,25}\d|\bin (\d+|six|four|two) (months|weeks)\b|\d+%|\b\d+x\b|~\s?\$?\d|\btop \d\b|\d+\+? closed deals", re.I)

def set_text(p, text):
    rs = p.runs; rs[0].text = text
    for r in rs[1:]: r._r.getparent().remove(r._r)

def set_label(p, label, body):
    rs = p.runs; rs[0].text = label
    nb = next((r for r in rs[1:] if not r.bold), None)
    if nb is None: set_text(p, label + body); return
    for r in rs[1:]:
        if r is not nb: r._r.getparent().remove(r._r)
    nb.text = body

def set_title(p, title):
    rs = p.runs; k = next((i for i, r in enumerate(rs) if "\t" in r.text), None)
    if k is None: set_text(p, title); return
    rs[0].text = title
    for r in rs[1:k]: r._r.getparent().remove(r._r)

def fill_section(P, idxs, texts):
    paras = [P[i] for i in idxs]
    while len(paras) < len(texts):
        new = copy.deepcopy(paras[-1]._p); paras[-1]._p.addnext(new)
        paras.append(docx.text.paragraph.Paragraph(new, paras[-1]._parent))
    for p in paras[len(texts):]: p._p.getparent().remove(p._p)
    for p, t in zip(paras, texts): set_text(p, t)

def prepare(cfg):
    lib = json.load(open(os.path.join(HERE, "bullets.json")))
    est = json.load(open(os.path.join(HERE, "estimates.json")))
    keys = [r["key"] for r in MAP["roles"]]
    cfg["_estimates"] = sorted({e for k in keys for b in cfg.get(k, []) if b.startswith("@") for e in est.get(b[1:], [])} | set(cfg.get("estimates", [])))
    for k in keys: cfg[k] = [lib[b[1:]] if b.startswith("@") else b for b in cfg.get(k, [])]
    return cfg

def check(cfg):
    keys = [r["key"] for r in MAP["roles"]]
    short = [k for k in keys if len(cfg[k]) < 3]
    if short: sys.exit("Fewer than 3 bullets in: " + ", ".join(short) + ". Add relevant result bullets (shorten long ones if over the page limit).")
    weak = [t for k in keys for t in cfg[k] if not RESULT.search(t)]
    if weak: sys.exit("Bullets with no business result (add a real result, a same-program result, or a flagged ~estimate):\n- " + "\n- ".join(weak))

def build(cfg, out):
    d = docx.Document(SRC); P = d.paragraphs
    for r in MAP["roles"]:
        if cfg.get("titles", {}).get(r["key"]): set_title(P[r["title"]], cfg["titles"][r["key"]])
    for i, (label, body) in zip(MAP.get("skills", []), cfg.get("skills", [])): set_label(P[i], label, body)
    if cfg.get("tools") and MAP.get("tools") is not None: set_label(P[MAP["tools"]], "Tools: ", cfg["tools"])
    if cfg.get("certs") and MAP.get("certs") is not None: set_label(P[MAP["certs"]], "Certifications: ", cfg["certs"])
    set_text(P[MAP["summary"]], cfg["summary"])
    for r in sorted(MAP["roles"], key=lambda r: -r["bullets"][0]):   # bottom-up so indexes stay valid
        fill_section(P, r["bullets"], cfg[r["key"]])
    paras = d.paragraphs
    for k, p in enumerate(paras[:-1]):   # keep each role heading with its first bullet
        if p.style.name != "List Paragraph" and p.text.strip() and paras[k + 1].style.name == "List Paragraph":
            p.paragraph_format.keep_with_next = True
    d.save(out)

def to_pdf(docx_path):
    try:
        subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", os.path.dirname(docx_path) or ".", docx_path],
                       check=True, capture_output=True, timeout=180)
        pdf = docx_path[:-5] + ".pdf"
        out = subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout
        return pdf, int(re.search(r"Pages:\s+(\d+)", out).group(1)) if "Pages" in out else None
    except Exception as e:
        return None, f"PDF not made ({e.__class__.__name__}); install LibreOffice"

if __name__ == "__main__":
    if not MAP: sys.exit("tailor/template_map.json is missing: run setup's template-mapping step first.")
    cfg = prepare(json.load(open(sys.argv[1]))); check(cfg)
    out = sys.argv[2] + ".docx"; os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    build(cfg, out); pdf, pages = to_pdf(out)
    print(json.dumps({"docx": out, "pdf": pdf, "pages": pages, "estimates": cfg["_estimates"]}))
    if isinstance(pages, int) and pages != MAP.get("pages", 2):
        sys.exit(f"Resume is {pages} pages, not {MAP.get('pages', 2)}: shorten the longest bullets or drop an older bullet")
