#!/usr/bin/env python3
"""Convert a browser print-to-PDF of a ShopC (SITE_C) search
list page into compact product lines:
  id | name | new_price | list_price | used_price | flags | url

Print-to-PDF preserves link annotations (product detail URLs) and
visible text with positions. Each product's topmost link annotation
anchors its card cell; words are assigned to cells by position
(same approach as the ShopE / ShopB extractors).

Card fields (visible text): product name, 新品通常価格 ¥A followed by
the tax-incl. price ￥B 税込 (B is the sale price when a time-sale
window is shown), 中古：￥C 税込, 定価：￥D, release date, 品切れ.

Usage: shop_c_pdf_extract.py <page.pdf> [<page2.pdf> ...]
Requires: pypdf (~/workspace/tools/pdf-venv), pdftotext (poppler).
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

from pypdf import PdfReader

NS = "{http://www.w3.org/1999/xhtml}"
PROD_RE = re.compile(r"^https://www\.SITE_C/item/([0-9A-Z]+)$")


def anchors(pdf_path):
    """One anchor per product: the topmost link rect for each URL."""
    reader = PdfReader(pdf_path)
    best = {}
    for pi, page in enumerate(reader.pages):
        height = float(page.mediabox.height)
        for a in page.get("/Annots") or []:
            o = a.get_object()
            act = o.get("/A")
            if not act or not act.get("/URI") or not o.get("/Rect"):
                continue
            url = str(act["/URI"]).split("#")[0].split("?")[0]
            m = PROD_RE.match(url)
            if not m:
                continue
            x0, y0, x1, y1 = (float(v) for v in o["/Rect"])
            top = height - y1
            area = (x1 - x0) * (y1 - y0)
            key = (pi, url)
            if key not in best or area > best[key]["area"]:
                best[key] = {"page": pi, "pid": m.group(1), "url": url,
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
    """[{pid, url, lines}] via anchor cells, with the ShopE-style
    handling of cards split across PDF page breaks."""
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
            x1 = min(nxt_cols) if nxt_cols else x0 + 200
            below = [a["rect"][1] for a in plist
                     if round(a["rect"][0]) == round(x0) and a["rect"][1] > y0 + 5]
            y1 = min(below) if below else y0 + 700
            cell = [w for w in ws
                    if x0 - 30 <= (w[0] + w[2]) / 2 < x1
                    and y0 - 2 <= (w[1] + w[3]) / 2 < y1]
            cards.append({"pid": an["pid"], "url": an["url"],
                          "lines": [t for _, t in lines_from_words(cell)]})
            cur_bottom[round(x0)] = len(cards) - 1
        prev_bottom = cur_bottom
    return cards


def yen(s):
    m = re.search(r"[¥￥]\s*([\d,]+)", s)
    return m.group(1) if m else ""


def merge_split(cards):
    merged = []
    for c in cards:
        if merged and merged[-1]["pid"] == c["pid"]:
            merged[-1]["lines"] += c["lines"]
        else:
            merged.append(c)
    return merged


def parse_card(card):
    lines = card["lines"]
    blob = " ".join(lines)
    list_price = ""
    m = re.search(r"定価[：:]\s*[¥￥]\s*([\d,]+)", blob)
    if m:
        list_price = m.group(1)
    new_price = ""
    # 新品通常価格 ¥A の直後にある ￥B 税込 が実売価格（セール時は B）。
    for i, t in enumerate(lines):
        if "新品通常価格" in t:
            for t2 in lines[i:i + 3]:
                if "税込" in t2:
                    new_price = yen(t2)
                    break
            if not new_price:
                new_price = yen(t)
            break
    used_price = ""
    m = re.search(r"中古[：:]?\s*[¥￥]\s*([\d,]+)\s*税込", blob)
    if m:
        used_price = m.group(1)
    flags = []
    if "品切れ" in blob:
        flags.append("品切れ")
    if re.search(r"\d{4}-\d{2}-\d{2}.*?から", blob):
        flags.append("タイムセール")
    m = re.search(r"発売日[：:]\s*(\d{4}/\d{2}/\d{2})", blob)
    if m:
        flags.append("発売" + m.group(1))
    # name: lines before the first price/date/maker line, minus chrome.
    name_parts = []
    for t in lines:
        if re.search(r"定価|通常価格|税込|発売日|送料無料|から$", t):
            break
        name_parts.append(t)
    name = "".join(name_parts)
    name = re.sub(r"(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])", "", name)
    return {"pid": card["pid"], "name": name, "new": new_price,
            "list": list_price, "used": used_price,
            "flags": ",".join(flags), "url": card["url"]}


def main():
    products, warnings = [], []
    for pdf_path in sys.argv[1:]:
        for card in merge_split(collect_card_lines(pdf_path)):
            p = parse_card(card)
            products.append(p)
            if not p["name"] or (not p["new"] and "品切れ" not in p["flags"]):
                warnings.append(f"{p['pid']}: name={'Y' if p['name'] else 'MISSING'} new={'Y' if p['new'] else 'MISSING'}")
    seen = set()
    for p in products:
        if p["pid"] in seen:
            continue
        seen.add(p["pid"])
        print(f"{p['pid']} | {p['name']} | 新品¥{p['new']} | 定価¥{p['list']} | 中古¥{p['used']} | {p['flags']} | {p['url']}")
    print(f"# total: {len(seen)}", file=sys.stderr)
    for w in warnings:
        print(f"# warn: {w}", file=sys.stderr)


if __name__ == "__main__":
    main()
