#!/usr/bin/env python3
"""Convert a browser print-to-PDF of an ShopD (SITE_D/eng) search
list page into compact product lines:
  gcode | name | price_jpy | list_price_jpy | status | url

Print-to-PDF preserves link annotations (detail/?gcode= URLs) and
visible text with positions. Each product's topmost link annotation
anchors its card cell; words are assigned to cells by position.

Card fields (visible text): status (Pre-order / Back-order / ...),
product name, brand line, then "<price> JPY<list_price>" — the sale
price in JPY immediately followed by the list price digits.

Usage: shop_d_pdf_extract.py <page.pdf> [<page2.pdf> ...]
Requires: pypdf (~/workspace/tools/pdf-venv), pdftotext (poppler).
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

from pypdf import PdfReader

NS = "{http://www.w3.org/1999/xhtml}"
PROD_RE = re.compile(r"^https://www\.shop_d\.com/detail/\?gcode=([A-Z0-9-]+)$")
STATUS_WORDS = ("Pre-order", "Back-order", "Pre-owned", "Re-release")


def anchors(pdf_path):
    reader = PdfReader(pdf_path)
    best = {}
    for pi, page in enumerate(reader.pages):
        height = float(page.mediabox.height)
        for a in page.get("/Annots") or []:
            o = a.get_object()
            act = o.get("/A")
            if not act or not act.get("/URI") or not o.get("/Rect"):
                continue
            url = str(act["/URI"]).split("#")[0]
            m = PROD_RE.match(url)
            if not m:
                continue
            x0, y0, x1, y1 = (float(v) for v in o["/Rect"])
            top = height - y1
            area = (x1 - x0) * (y1 - y0)
            key = (pi, url)
            if key not in best or area > best[key]["area"]:
                best[key] = {"page": pi, "gcode": m.group(1), "url": url,
                             "rect": (x0, top, x1, height - y0), "area": area}
    return list(best.values())


def words(pdf_path):
    xml_text = subprocess.run(
        ["pdftotext", "-bbox", pdf_path, "-"],
        capture_output=True, text=True, check=True).stdout
    root = ET.fromstring(xml_text)
    pages = {}
    for pi, pg in enumerate(root.iter(NS + "page")):
        pages[pi] = [(float(w.get("xMin")), float(w.get("yMin")),
                      float(w.get("xMax")), float(w.get("yMax")),
                      w.text or "") for w in pg.iter(NS + "word")]
    return pages


def lines_from_words(ws):
    ws = sorted(ws, key=lambda w: (round(w[1] / 4), w[0]))
    lines = []
    for w in ws:
        yc = (w[1] + w[3]) / 2
        if lines and abs(lines[-1][0] - yc) < 5:
            lines[-1][1] += " " + w[4]
        else:
            lines.append([yc, w[4]])
    return [(yc, t) for yc, t in lines]


def collect_card_lines(pdf_path):
    ans = anchors(pdf_path)
    pages = words(pdf_path)
    by_page = {}
    for an in ans:
        by_page.setdefault(an["page"], []).append(an)
    cards = []
    prev_bottom = {}
    for pi in sorted(by_page):
        plist = sorted(by_page[pi], key=lambda a: (round(a["rect"][0]), a["rect"][1]))
        cols = sorted({round(a["rect"][0]) for a in plist})
        ws = pages.get(pi, [])
        if prev_bottom:
            for cx, ci in prev_bottom.items():
                nxt = [c for c in cols if c > cx + 5]
                x1 = min(nxt) if nxt else cx + 200
                first_y = min(a["rect"][1] for a in plist if round(a["rect"][0]) == cx) \
                    if any(round(a["rect"][0]) == cx for a in plist) else 0
                tail = [w for w in ws
                        if cx - 2 <= (w[0] + w[2]) / 2 < x1
                        and 20 <= (w[1] + w[3]) / 2 < first_y - 2]
                if tail:
                    cards[ci]["lines"] += [t for _, t in lines_from_words(tail)]
        cur_bottom = {}
        for an in plist:
            x0, y0 = an["rect"][0], an["rect"][1]
            nxt_cols = [c for c in cols if c > round(x0) + 5]
            x1 = min(nxt_cols) if nxt_cols else an["rect"][2] + 40
            below = [a["rect"][1] for a in plist
                     if round(a["rect"][0]) == round(x0) and a["rect"][1] > y0 + 5]
            y1 = min(below) if below else y0 + 700
            cell = [w for w in ws
                    if x0 - 30 <= (w[0] + w[2]) / 2 < x1
                    and y0 - 2 <= (w[1] + w[3]) / 2 < y1]
            cards.append({"gcode": an["gcode"], "url": an["url"],
                          "lines": [t for _, t in lines_from_words(cell)]})
            cur_bottom[round(x0)] = len(cards) - 1
        prev_bottom = cur_bottom
    return cards


def merge_split(cards):
    merged = []
    for c in cards:
        if merged and merged[-1]["gcode"] == c["gcode"]:
            merged[-1]["lines"] += c["lines"]
        else:
            merged.append(c)
    return merged


def parse_card(card):
    lines = card["lines"]
    price, list_price, price_idx = "", "", None
    for i, t in enumerate(lines):
        m = re.search(r"([\d,]+)\s*JPY\s*([\d,]+)?", t)
        if m:
            price, price_idx = m.group(1), i
            list_price = m.group(2) or ""
            break
    status = ""
    for t in lines[:3]:
        for s in STATUS_WORDS:
            if s in t:
                status = s
                break
    name_lines = lines[:price_idx] if price_idx is not None else []
    name_lines = [t for t in name_lines if t.strip() not in STATUS_WORDS]
    name = " ".join(name_lines).strip()
    return {"gcode": card["gcode"], "name": name, "price": price,
            "list": list_price, "status": status, "url": card["url"]}


def main():
    products, warnings = [], []
    for pdf_path in sys.argv[1:]:
        for card in merge_split(collect_card_lines(pdf_path)):
            p = parse_card(card)
            products.append(p)
            if not p["name"] or not p["price"]:
                warnings.append(f"{p['gcode']}: name={'Y' if p['name'] else 'MISSING'} price={'Y' if p['price'] else 'MISSING'}")
    seen = set()
    for p in products:
        if p["gcode"] in seen:
            continue
        seen.add(p["gcode"])
        print(f"{p['gcode']} | {p['name']} | ¥{p['price']} | 定価¥{p['list']} | {p['status']} | {p['url']}")
    print(f"# total: {len(seen)}", file=sys.stderr)
    for w in warnings:
        print(f"# warn: {w}", file=sys.stderr)


if __name__ == "__main__":
    main()
