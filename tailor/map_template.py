"""Print every paragraph of tailor/template.docx with its index and style, so Claude can write tailor/template_map.json.
Usage: python3 tailor/map_template.py
"""
import os, docx
HERE = os.path.dirname(os.path.abspath(__file__))
for i, p in enumerate(docx.Document(os.path.join(HERE, "template.docx")).paragraphs):
    if p.text.strip():
        bold = "B" if any(r.bold for r in p.runs) else " "
        print(f"{i:3d} {bold} [{p.style.name[:14]:14}] {p.text[:110]}")
