"""Build a one-page cover letter using the header (first 3 paragraphs) of the user's resume template.

Usage: python3 tailor/cover.py letter.json OUT_BASENAME
letter.json: {"date": "October 7, 2026", "recipient": "Company Hiring Team\\nRe: Role (Location)",
              "salutation": "Dear Company Hiring Team,", "intro": [para, ...],
              "bullets": [["Bold lead. ", "text"], ...], "outro": [para, ...]}
Rules: facts only from the career inventory; one page; the last paragraph ends with
the contact line in tailor/profile.json ("closing", e.g. "You can reach me at <phone> or <email>.").
"""
import json, os, sys
import docx
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from resume import SRC, to_pdf

L = json.load(open(sys.argv[1])); OUT = sys.argv[2] + ".docx"
PROFILE = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "profile.json")))
assert PROFILE["closing"] in L["outro"][-1], "Closing contact line missing: end the last paragraph with " + PROFILE["closing"]
d = docx.Document(SRC); body = d.element.body; P = d.paragraphs
keep = {P[0]._p, P[1]._p, P[2]._p}
for el in list(body):
    if el.tag.endswith('}p') and el not in keep: body.remove(el)
    if el.tag.endswith('}tbl'): body.remove(el)

def para(text, bold=False, space_after=8, align=None):
    p = d.add_paragraph(); r = p.add_run(text); r.font.name = "Times New Roman"; r.font.size = Pt(11); r.bold = bold
    pf = p.paragraph_format; pf.space_after = Pt(space_after); pf.space_before = Pt(0); pf.line_spacing = 1.08
    if align: p.alignment = align

def bullet(label, text):
    p = d.add_paragraph(); pf = p.paragraph_format
    pf.left_indent = Inches(0.25); pf.first_line_indent = Inches(-0.18); pf.space_after = Pt(6); pf.line_spacing = 1.08
    for t, b in (("•  ", False), (label, True), (text, False)):
        r = p.add_run(t); r.font.name = "Times New Roman"; r.font.size = Pt(11); r.bold = b

para(L["date"], space_after=10); para(L["recipient"], space_after=12); para(L["salutation"])
for t in L["intro"]: para(t, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
for l, t in L["bullets"]: bullet(l, t)
for t in L["outro"]: para(t, align=WD_ALIGN_PARAGRAPH.JUSTIFY)
para("Sincerely,", space_after=2); para(PROFILE["name"], space_after=0)
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True); d.save(OUT)
pdf, pages = to_pdf(OUT)
print(json.dumps({"docx": OUT, "pdf": pdf, "pages": pages}))
if isinstance(pages, int) and pages != 1: sys.exit("Cover letter is longer than one page: trim it")
