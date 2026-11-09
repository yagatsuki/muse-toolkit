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
        def li(date, href, cls=""):
            return f'      <li{cls}><a href="{href}">{date} のレポート</a></li>'

        if not items:
            body = ('    <ul>\n'
                    '      <li class="empty">まだレポートがありません</li>\n'
                    '    </ul>')
        elif len(items) <= 3:
            lis = "\n".join(li(d, h) for d, h in items)
            body = f'    <ul>\n{lis}\n    </ul>'
        else:
            head, rest = items[:3], items[3:]
            lis_head = "\n".join(
                li(d, h, ' class="peek"' if i == 2 else "")
                for i, (d, h) in enumerate(head)
            )
            lis_rest = "\n".join(li(d, h) for d, h in rest)
            body = (
                f'    <ul>\n{lis_head}\n    </ul>\n'
                f'    <div class="more" id="more-{sub}">\n'
                f'    <ul>\n{lis_rest}\n    </ul>\n'
                f'    </div>\n'
                f'    <button class="toggle" data-target="more-{sub}" '
                f'data-more="もっと見る（残り{len(rest)}件）" '
                f'data-less="閉じる">もっと見る（残り{len(rest)}件）</button>'
            )
        sections.append(
            f'  <section id="{sub}">\n'
            f'    <h2>{label}</h2>\n'
            f'{body}\n'
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
  .peek {{ opacity: 0.45; transition: opacity 0.3s ease; }}
  section.open .peek {{ opacity: 1; }}
  .more {{ max-height: 0; overflow: hidden; transition: max-height 0.45s ease; }}
  .toggle {{ background: none; border: 1px solid #ccc; border-radius: 6px;
             padding: 4px 12px; font-size: 14px; color: #0b5cad;
             cursor: pointer; margin: 2px 0 10px 4px; }}
</style>
</head>
<body>
<h1>日次レポート集約</h1>
<p class="updated">全{total}件・更新: {now}（保持期間30日。古いレポートは自動削除されます）</p>
<nav>
  <a href="#bargain">特価</a><a href="#shop_b">予約・発売</a><a href="#platform_e">PlatformE</a><a href="#platform_a">PlatformA</a><a href="#platform_d">PlatformD</a><a href="#x">X</a>
</nav>
{chr(10).join(sections)}
<script>
document.querySelectorAll('.toggle').forEach(function (btn) {{
  btn.addEventListener('click', function () {{
    var box = document.getElementById(btn.dataset.target);
    var open = box.style.maxHeight && box.style.maxHeight !== '0px';
    box.style.maxHeight = open ? '0px' : box.scrollHeight + 'px';
    btn.textContent = open ? btn.dataset.more : btn.dataset.less;
    btn.closest('section').classList.toggle('open', !open);
  }});
}});
</script>
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
