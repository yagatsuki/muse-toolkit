#!/usr/bin/env python3
"""日次チェック報告の HTML 生成（JSON → HTML）。

エージェントは構造化データ（JSON）を書くだけで、HTML の組み立ては
このスクリプトが行う（トークン消費を抑えるため）。

使い方:
    render.py DATA.json OUT.html

実行:
    ~/workspace/tools/report-venv/bin/python ~/workspace/reporting/render.py ...

データ形式:
  予約チェック (type: "shop_b"):
    {"type": "shop_b", "date": "2026-11-08", "title": "...",
     "sections": [{"heading": "新規予約", "items": [
        {"brand": "BRAND_1", "name": "...", "url": "https://...",
         "image_url": "https://... (直リンク。無ければ null)",
         "price": 3564, "list_price": 3960, "release": "2026年3月",
         "status": "予約受付中", "note": "..."}]}]}
  特価チェック (type: "bargain"):
    {"type": "bargain", "date": "2026-11-08", "title": "...",
     "products": [
        {"brand": "トミーテック", "name": "...", "list_price": 4620,
         "image_url": "https://... (代表画像の直リンク。無ければ null)",
         "offers": [
            {"store": "SHOP_D", "url": "https://...", "price": 1980,
             "shipping": 630, "stock": "在庫あり", "note": "..."}]}]}
    offers の total（送料込み総額）と discount_pct（総額ベースの割引率）は
    未指定ならスクリプトが計算する。
  リンク一覧 (type: "links"。PlatformA／PlatformD／X／PlatformE 等の紹介報告用。
  画像は使わない):
    {"type": "links", "date": "2026-11-08", "title": "...",
     "sections": [{"heading": "紹介", "items": [
        {"name": "r/example", "url": "https://...",
         "meta": "約280万人", "note": "対象外の理由など（任意）",
         "links": [{"label": "動画1", "url": "https://..."}]}]}]}
    links は任意の追加リンク（X の動画直リンク、PlatformE のプロフィール等）。
"""
import json
import os
import sys

from jinja2 import Environment, FileSystemLoader, select_autoescape

HERE = os.path.dirname(os.path.abspath(__file__))


def yen(v):
    if v is None:
        return ""
    return f"¥{v:,}"


def enrich_bargain(data):
    for p in data.get("products", []):
        lp = p.get("list_price")
        for o in p.get("offers", []):
            if o.get("total") is None and o.get("price") is not None:
                o["total"] = o["price"] + (o.get("shipping") or 0)
            if o.get("discount_pct") is None and lp and o.get("total") is not None:
                o["discount_pct"] = round((1 - o["total"] / lp) * 100, 1)
        o_list = p.get("offers", [])
        o_list.sort(key=lambda o: (o.get("total") is None, o.get("total") or 0))
        p["offers"] = o_list
    return data


def main():
    if len(sys.argv) != 3:
        print("usage: render.py DATA.json OUT.html", file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        data = json.load(f)
    rtype = data.get("type")
    if rtype not in ("shop_b", "bargain", "links"):
        print(f"unknown type: {rtype}", file=sys.stderr)
        return 2
    if rtype == "bargain":
        data = enrich_bargain(data)
    env = Environment(
        loader=FileSystemLoader(os.path.join(HERE, "templates")),
        autoescape=select_autoescape(["html"]),
    )
    env.filters["yen"] = yen
    tpl = env.get_template(f"{rtype}.html.j2")
    html = tpl.render(**data)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write(html)
    print(f"wrote {sys.argv[2]} ({len(html)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
