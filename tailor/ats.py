"""ATS keyword match: how well a built resume covers the keywords an ATS would search for.

Usage:  python3 tailor/ats.py keywords.json RESUME.docx [--out report.json]

keywords.json is a list made by Claude from the job description, most important first:
  [{"term": "operating rhythm", "variants": ["operating cadence"], "kind": "skill|tool|domain|title|qualification",
    "importance": "required|preferred|other", "evidence": "AMZ-2" | null}, ...]
  - variants: other spellings an ATS would also accept (plural/singular is handled automatically)
  - evidence: the career-inventory fact ID that backs the term, or null if nothing in the inventory does

Prints and writes a report: match % (weighted: required 3, preferred 2, other 1), covered terms,
"supported but missing" terms (in the inventory but not on the resume: add them), and gaps
(not in the inventory: ask the user). No model calls; it only reads the files.
"""
import json, re, sys
import docx

WEIGHT = {"required": 3, "preferred": 2, "other": 1}


def norm(s):
    s = s.lower().replace("&", " and ").replace("/", " ")
    s = re.sub(r"[^a-z0-9+#.% ]+", " ", s)
    words = [w.rstrip(".") for w in s.split()]
    return " ".join(w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w for w in words)


def resume_text(path):
    d = docx.Document(path)
    parts = [p.text for p in d.paragraphs]
    for t in d.tables:
        for row in t.rows:
            parts += [c.text for c in row.cells]
    return " " + norm(" ".join(parts)) + " "


def score(keywords, text):
    covered, supported_missing, gaps = [], [], []
    got = total = 0
    for k in keywords:
        w = WEIGHT.get(k.get("importance", "other"), 1)
        total += w
        forms = [k["term"]] + list(k.get("variants") or [])
        hit = next((f for f in forms if f" {norm(f)} " in text), None)
        if hit:
            got += w
            covered.append(k["term"])
        elif k.get("evidence"):
            supported_missing.append(k["term"])
        else:
            gaps.append(k["term"])
    return {"match": round(100 * got / total) if total else 0, "covered": covered,
            "supportedMissing": supported_missing, "gaps": gaps, "keywordCount": len(keywords)}


if __name__ == "__main__":
    kw = json.load(open(sys.argv[1]))
    rep = score(kw, resume_text(sys.argv[2]))
    if "--out" in sys.argv:
        json.dump(rep, open(sys.argv[sys.argv.index("--out") + 1], "w"), indent=1)
    print(json.dumps(rep, indent=1))
