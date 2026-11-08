#!/usr/bin/env python3
"""Convert a browser print-to-PDF of a ShopE Web (SITE_E) list
page into compact product lines:
  JAN | name | price_yen | stock | release | url

The browser cannot save HTML or export the DOM, but Chrome's
print-to-PDF preserves link annotations (product page URLs, whose
filename is the JAN code) and visible text with positions. The list is
a grid; each product's image-link rect anchors its cell, and words are
assigned to cells by position.

ShopE list cards show: name, price (tax incl.), points, stock status,
earliest shipping, rating, release month, and a description snippet.
List price (定価) is NOT shown; discount rates must be computed from
the JAN-known list price or the product page (existing bargain rule).

Usage: shop_e_pdf_extract.py <page.pdf> [<page2.pdf> ...]
Requires: pypdf (~/workspace/tools/pdf-venv), pdftotext (poppler).
"""
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

from pypdf import PdfReader

NS = "{http://www.w3.org/1999/xhtml}"
PROD_RE = re.compile(r"^https://shop_e_web\.jp/category/\d+/(\d+)\.html$")


def anchors(pdf_path):
    """One image anchor per product: {page, jan, url, rect(x0,y0,x1,y1)
    in top-down points}. The image link rect is ~71x70pt and appears
    twice per product; dedupe by (url, page, x0, y0)."""
    reader = PdfReader(pdf_path)
    seen = {}
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
            w, h = x1 - x0, y1 - y0
            if not (60 <= w <= 82 and 60 <= h <= 82):
                continue
            key = (url, pi, round(x0), round(height - y1))
            seen[key] = {"page": pi, "jan": m.group(1), "url": url,
                         "rect": (x0, height - y1, x1, height - y0)}
    return list(seen.values())


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
    """Return [{jan, url, lines}] — words grouped into card cells.
    Cards split across PDF page breaks: words at the top of the next
    PDF page (above its first image anchor, inside the same column)
    are appended to the last card of that column on the previous page."""
    ans = anchors(pdf_path)
    pages = words(pdf_path)
    by_page = {}
    for an in ans:
        by_page.setdefault(an["page"], []).append(an)
    cards = []          # in reading order
    card_by_key = {}
    prev_bottom = {}    # column x0 -> card index of last card on prev page
    for pi in sorted(by_page):
        plist = by_page[pi]
        cols = sorted({round(a["rect"][0]) for a in plist})
        ws = pages.get(pi, [])
        # tail words for cards split from the previous page
        if prev_bottom:
            for cx, ci in prev_bottom.items():
                nxt = [c for c in cols if c > cx + 5]
                x1 = min(nxt) if nxt else cx + 101
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
            x1 = min(nxt_cols) if nxt_cols else x0 + 101
            below = [a["rect"][1] for a in plist
                     if round(a["rect"][0]) == round(x0) and a["rect"][1] > y0 + 5]
            y1 = min(below) if below else y0 + 560
            cell = [w for w in ws
                    if x0 - 2 <= (w[0] + w[2]) / 2 < x1
                    and y0 - 2 <= (w[1] + w[3]) / 2 < y1]
            card = {"jan": an["jan"], "url": an["url"],
                    "lines": [t for _, t in lines_from_words(cell)]}
            cards.append(card)
            cur_bottom[round(x0)] = len(cards) - 1
        prev_bottom = cur_bottom
    return cards


def main():
    products = []
    warnings = []
    for pdf_path in sys.argv[1:]:
        for card in collect_card_lines(pdf_path):
            lines = card["lines"]
            if True:
                an = {"jan": card["jan"], "url": card["url"]}
                # price = first "<number> 円" in reading order (tax incl.
                # price precedes the points line, which also uses 円).
                price, price_idx = "", None
                for i, t in enumerate(lines):
                    m = re.search(r"([\d,]+)\s*円", t)
                    if m:
                        price, price_idx = m.group(1), i
                        break
                name_lines = lines[:price_idx] if price_idx is not None else []
                name = "".join(name_lines)
                name = re.sub(r"(?<=[^\x00-\x7F]) (?=[^\x00-\x7F])", "", name)
                blob = " ".join(lines)
                stock = ""
                for t in lines:
                    if "在庫" in t or "品切れ" in t or "予約受付" in t:
                        stock = t.strip()
                        break
                m = re.search(r"(\d{4}年\d{1,2}月)\s*発売", blob)
                release = m.group(1) + "発売" if m else ""
                m = re.search(r"([\d,]+)\s*円相当", blob)
                points = m.group(1) if m else ""
                products.append({"jan": an["jan"], "name": name,
                                 "price": price, "stock": stock,
                                 "release": release, "points": points,
                                 "url": an["url"]})
                if not name or not price:
                    warnings.append(f"{an['jan']}: name={'Y' if name else 'MISSING'} price={'Y' if price else 'MISSING'} (card may be split across PDF pages)")
    seen = set()
    for p in products:
        if p["jan"] in seen:
            continue
        seen.add(p["jan"])
        print(f"{p['jan']} | {p['name']} | ¥{p['price']} | {p['stock']} | {p['release']} | P{p['points']} | {p['url']}")
    print(f"# total: {len(seen)}", file=sys.stderr)
    for w in warnings:
        print(f"# warn: {w}", file=sys.stderr)


if __name__ == "__main__":
    main()
