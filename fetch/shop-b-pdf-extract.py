#!/usr/bin/env python3
"""Convert a browser print-to-PDF of a SITE_B list page into compact
product lines: id | name | price | list_price | release | status.

The browser cannot save HTML, but Chrome's print-to-PDF preserves link
annotations (product page URLs = product IDs) and all visible text with
positions. Pairing is positional: each product's wide name-link
annotation rect anchors its card; words are grouped into card bands by
vertical position.

Usage: pdf_extract.py <page.pdf> [<page2.pdf> ...]
Requires: pypdf (~/workspace/tools/pdf-venv), pdftotext (poppler).
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

from pypdf import PdfReader

NS = "{http://www.w3.org/1999/xhtml}"
PRICE_RE = re.compile(r"¥\s*([\d,]+)")
RELEASE_RE = re.compile(r"(\d{1,2}月\d{0,2}日?|月以降|発売済|発売中止|予約品|再販|上旬|中旬|下旬)")


def annotations(pdf_path):
    """Return [{page, id, rect_td}] for product name-link anchors.
    rect_td is (x0, y0, x1, y1) in top-down points."""
    reader = PdfReader(pdf_path)
    out = []
    for pi, page in enumerate(reader.pages):
        height = float(page.mediabox.height)
        for a in page.get("/Annots") or []:
            o = a.get_object()
            act = o.get("/A")
            if not act or not act.get("/URI"):
                continue
            m = re.search(r"1999\.co\.jp/(\d+)$", str(act["/URI"]))
            if not m or not o.get("/Rect"):
                continue
            x0, y0, x1, y1 = (float(v) for v in o["/Rect"])
            # wide rect = name link (image link is ~90pt wide)
            if x1 - x0 < 200:
                continue
            out.append({"page": pi, "id": m.group(1),
                        "rect": (x0, height - y1, x1, height - y0)})
    return out


def words(pdf_path):
    """Return {page_idx: [(x0, y0, x1, y1, text)]} from pdftotext -bbox."""
    xml_text = subprocess.run(
        ["pdftotext", "-bbox", pdf_path, "-"],
        capture_output=True, text=True, check=True).stdout
    root = ET.fromstring(xml_text)
    pages = {}
    for pi, pg in enumerate(root.iter(NS + "page")):
        ws = []
        for w in pg.iter(NS + "word"):
            ws.append((float(w.get("xMin")), float(w.get("yMin")),
                       float(w.get("xMax")), float(w.get("yMax")),
                       w.text or ""))
        pages[pi] = ws
    return pages


def lines_from_words(ws):
    """Group words into lines (reading order) -> [(y_center, text)]."""
    ws = sorted(ws, key=lambda w: (round(w[1] / 4), w[0]))
    lines = []
    for w in ws:
        yc = (w[1] + w[3]) / 2
        if lines and abs(lines[-1][0] - yc) < 5:
            lines[-1][1] += " " + w[4]
            lines[-1][2].append(w)
        else:
            lines.append([yc, w[4], [w]])
    return [(yc, text) for yc, text, _ in lines]


def main():
    products = []
    for pdf_path in sys.argv[1:]:
        anchors = annotations(pdf_path)
        pages = words(pdf_path)
        by_page = {}
        for an in anchors:
            by_page.setdefault(an["page"], []).append(an)
        for pi, ans in sorted(by_page.items()):
            ans.sort(key=lambda a: a["rect"][1])
            ws = pages.get(pi, [])
            for i, an in enumerate(ans):
                y_top = an["rect"][1] - 4
                y_bot = ans[i + 1]["rect"][1] - 4 if i + 1 < len(ans) else 1e9
                band = [w for w in ws if y_top <= (w[1] + w[3]) / 2 < y_bot]
                lines = [t for _, t in lines_from_words(band)]
                blob = " ".join(lines)
                # Price line is the one containing ¥; its numbers in
                # x order are sale price then list price (the ¥ glyphs
                # are separate words and may sort after the numbers).
                price, list_price = "", ""
                for t in lines:
                    if "¥" in t:
                        nums = re.findall(r"[\d,]+", t)
                        if nums:
                            price = nums[0]
                            list_price = nums[1] if len(nums) > 1 else ""
                        break
                # Name = band lines that are not release/price/status
                # lines, stopping at the discount line.
                name_lines = []
                for t in lines:
                    if "発売予定" in t or "¥" in t or "%OFF" in t or "OFF" in t:
                        if name_lines:
                            break
                        continue
                    if t.strip() in ("予約品", "発売中止") or re.fullmatch(r"[\d\s]+", t):
                        continue
                    name_lines.append(t)
                name = " ".join(name_lines)
                name = re.sub(r"(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])", "", name)
                rel = ""
                m = re.search(r"(\d{1,2}月以降)\s*発売予定", blob)
                if m:
                    rel = m.group(1) + "発売予定"
                elif "発売中止" in blob:
                    rel = "発売中止"
                status = "予約品" if "予約品" in blob else ""
                products.append({
                    "id": an["id"], "name": name,
                    "price": price,
                    "list_price": list_price,
                    "release": rel, "status": status,
                })
    seen = set()
    for p in products:
        if p["id"] in seen:
            continue
        seen.add(p["id"])
        print(f"{p['id']} | {p['name']} | ¥{p['price']} | 定価¥{p['list_price']} | {p['release']} | {p['status']}")
    print(f"# total: {len(seen)}", file=sys.stderr)


if __name__ == "__main__":
    main()
