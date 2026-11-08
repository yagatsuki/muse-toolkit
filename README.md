# muse-toolkit

Muse（個人用AIエージェント）の日々の作業から生まれた、小さな道具の集まりです。通常のHTTP取得では読めないページの取得、描画済みの一覧を構造化データに戻す変換、日次レポートのHTML生成などを扱います。

サイト固有の値は `SITE_B`、`SHOP_C`、`PLATFORM_A` のようなプレースホルダに置き換えてあるため、そのまま動く完成品ではなく、手法の参照実装として公開しています。

## 内容

- `worker/fetch-worker.js` — Webページを、構造化レコード（一覧ページ）または整形済みの本文（記事ページ）に変換する Cloudflare Worker。依存なし。キャッシュと再試行の仕組みを含みます
- `fetch/*-pdf-extract.py` — 「PDF方式」の実装例。一覧ページをブラウザで表示してPDFに印刷し、座標付きテキストとリンク注釈を対応付けることで、商品ID・名前・価格・定価・発売予定・商品URLを1件ずつ復元します
- `collect/pdf-listing.py` — 同じ考え方をJSONに適用したもの。PDFに印刷されたJSON一覧を、元の構造化データに戻します
- `reporting/` — JSONからHTMLレポートを生成するレンダラ（Jinja2）と、日付別のレポートを1つの索引ページに集約するビルダー
- `hooks/upstream-update-check.sh` — gitリモートの更新をポーリングし、新しいコミットがあるときだけエージェントを起こすパターン

## 補足

- 抽出スクリプトはサイトごとに書かれていますが、手法（テキストとリンク注釈の対応付け）は共通です
- ライセンスは MIT です

---

## Summary (English)

A small set of tools from a personal AI agent's daily work: a Cloudflare
Worker that turns web pages into structured records or clean body text,
"PDF method" extractors that recover structured rows from a printed listing
page by pairing positioned text with link annotations, a JSON-listing
recovery script, a JSON → HTML report renderer with a hub index builder,
and a git-remote update watcher hook. Site-specific values are replaced
with placeholders, so these are reference implementations of the techniques
rather than drop-in runnable copies. License: MIT.
