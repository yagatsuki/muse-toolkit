#!/usr/bin/env python3
"""レポート集約ページ（トップページ）の生成。

各ゴールの files/report_*.html を ~/workspace/reporting/site/ 配下へ
種別ごとにコピーし、日付順の一覧 index.html を作る。
site/ フォルダがそのまま公開サイトになる（Cloudflare Pages へデプロイ予定）。

実行:
    ~/workspace/tools/report-venv/bin/python ~/workspace/reporting/build_hub.py
（Jinja2 は使わず標準ライブラリのみでも動く）
"""
import os
import re
import shutil
import sys
from datetime import datetime

HOME = os.path.expanduser("~")
SITE = os.path.join(HOME, "workspace", "reporting", "site")

TYPES = [
    ("bargain", "特価チェック（対象商品）",
     "workspace/goals/goal_a/files"),
    ("shop_b", "予約・発売チェック（SHOP_B）",
     "workspace/goals/goal_b/files"),
    ("platform_e", "PlatformE 注目投稿の探索",
     "workspace/goals/goal_e/files"),
    ("platform_a", "PlatformA 紹介",
     "workspace/goals/goal_c/files"),
    ("platform_d", "PlatformD 紹介",
     "workspace/goals/goal_d/files"),
    ("x", "X 探索",
     "workspace/goals/goal_f/files"),
]

DATE_RE = re.compile(r"report_(\d{4}-\d{2}-\d{2})\.html$")


def collect(sub, src_dir):
    """src_dir の report_*.html を site/<sub>/ へコピーし、日付降順の項目を返す。"""
    dest = os.path.join(SITE, sub)
    os.makedirs(dest, exist_ok=True)
    # 既存コピーを消してから入れ直す（元ファイルの削除を反映するため）
    for f in os.listdir(dest):
        if DATE_RE.search(f):
            os.remove(os.path.join(dest, f))
    items = []
    if os.path.isdir(src_dir):
        for f in os.listdir(src_dir):
            m = DATE_RE.search(f)
            if not m:
                continue
            shutil.copy2(os.path.join(src_dir, f), os.path.join(dest, f))
            items.append((m.group(1), f"{sub}/{f}"))
    items.sort(reverse=True)
    return items


def main():
    os.makedirs(SITE, exist_ok=True)
    sections = []
    total = 0
    for sub, label, rel in TYPES:
        items = collect(sub, os.path.join(HOME, rel))
        total += len(items)
        lis = "\n".join(
            f'      <li><a href="{href}">{date} のレポート</a></li>'
            for date, href in items
        ) or '      <li class="empty">まだレポートがありません</li>'
        sections.append(
            f'  <section id="{sub}">\n'
            f'    <h2>{label}</h2>\n'
            f'    <ul>\n{lis}\n    </ul>\n'
            f'  </section>'
        )
    now = datetime.now().strftime("%Y-%m-%d")
    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>日次レポート集約</title>
<style>
  body {{ font-family: sans-serif; margin: 16px; line-height: 1.6; color: #222; }}
  h1 {{ font-size: 20px; }}
  h2 {{ font-size: 16px; border-bottom: 2px solid #ccc; padding-bottom: 4px; }}
  ul {{ list-style: none; padding-left: 4px; }}
  li {{ margin: 6px 0; }}
  a {{ color: #0b5cad; }}
  .empty {{ color: #888; }}
  .updated {{ color: #666; font-size: 13px; }}
  nav a {{ margin-right: 12px; }}
</style>
</head>
<body>
<h1>日次レポート集約</h1>
<p class="updated">全{total}件・更新: {now}（保持期間30日。古いレポートは自動削除されます）</p>
<nav>
  <a href="#bargain">特価</a><a href="#shop_b">予約・発売</a><a href="#platform_e">PlatformE</a><a href="#platform_a">PlatformA</a><a href="#platform_d">PlatformD</a><a href="#x">X</a>
</nav>
{chr(10).join(sections)}
</body>
</html>
"""
    with open(os.path.join(SITE, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    with open(os.path.join(SITE, "robots.txt"), "w", encoding="utf-8") as f:
        f.write("User-agent: *\nDisallow: /\n")
    print(f"hub built: {total} reports -> {SITE}/index.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
