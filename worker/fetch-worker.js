// md-fetch v2: URL → 構造化レコード（一覧）/ 本文+related（詳細）。Cloudflare Workers 単体・依存なし
//   GET /https://example.com/list   または   GET /?url=https://example.com/list
//   Accept: application/json または &format=json で JSON
// ヘッダー: X-Image-Mode: id(既定)|full|none   X-Mode: auto(既定)|markdown   X-Max-Chars: 8000   X-No-Cache: true
// 環境変数(任意): API_KEY → Authorization: Bearer <key> 必須

const VERSION = "2026-11-07.5", STALE_TTL = 86400;
const TTL = 3600, MAX_BYTES = 5 * 1024 * 1024, MAX_WAIT = 90;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CORS = { "X-Version": VERSION, "Access-Control-Expose-Headers": "*", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
const DROP = new Set(["svg","style","noscript","template","iframe","canvas","select","dialog","video","audio"]);
const NOTEXT = new Set(["script","style","svg","noscript","template","iframe","canvas","select","head","button","input","textarea"]);
const VOID = new Set(["img","br","hr","input","meta","link","source","wbr","area","col","embed","param","track"]);
const INLINE = new Set(["a","span","b","i","em","strong","small","u","sup","sub","abbr","code","mark","time","label","img","br"]);
const DEL = new Set(["del","s","strike"]);
const ENT = {amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ndash:"–",mdash:"—",hellip:"…",laquo:"«",raquo:"»",copy:"©",lsquo:"‘",rsquo:"’",ldquo:"“",rdquo:"”",middot:"·",yen:"¥",times:"×"};
const MON = {mai:5,okt:10,dez:12,ene:1,abr:4,ago:8,dic:12,jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const c = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(c); } catch { return m; } }
  return ENT[e.toLowerCase()] ?? m;
});
const clean = (s) => decode(s).replace(/\s+/g, " ").trim();
const seg = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
function cut(s, n) {
  if (s.length <= n) return s;
  if (seg) { let o = 0; for (const { segment } of seg.segment(s)) { if (o + segment.length > n) break; o += segment.length; } return s.slice(0, o); }
  const c = s.charCodeAt(n - 1); return s.slice(0, c >= 0xD800 && c <= 0xDBFF ? n - 1 : n);
}
const toNum = (s) => Number(String(s).replace(/,/g, ""));
const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const abs = (u, base) => { try { return new URL(decode(String(u)).trim(), base).href; } catch { return null; } };
const resp = (body, status = 200, extra = {}) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...extra } });

function normDate(s) {
  let m = s.match(/(\d{4})\s?[-\/.年년]\s?(\d{1,2})\s?[-\/.月월]\s?(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = s.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})/);
  if (m && MON[m[2].toLowerCase()]) return iso(m[3], MON[m[2].toLowerCase()], m[1]);
  m = s.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/);
  if (m && MON[m[1].toLowerCase()]) return iso(m[3], MON[m[1].toLowerCase()], m[2]);
  return null;
}

// ---------- 画像 ----------
function maxSrc(list, base) {
  let best = null, bw = -1;
  for (const a of list) for (const k of ["srcset", "data-srcset"]) if (a[k]) for (const part of a[k].split(/,\s+/)) {
    const [u, d] = part.trim().split(/\s+/); if (!u) continue;
    const w = d ? parseFloat(d) * (/x$/.test(d) ? 1000 : 1) : 0;
    if (w > bw) { bw = w; best = u; }
  }
  if (best) return abs(best, base);
  for (const a of list) { const s = a.src || a["data-src"] || a["data-original"] || a["data-lazy-src"] || a["data-lazy"]; if (s && !/^data:/i.test(s)) return abs(s, base); }
  return null;
}
const imgSrc = (n, base) => maxSrc([n.a, ...(n.p && n.p.t === "picture" ? n.p.c.filter((c) => typeof c !== "string" && c.t === "source").map((c) => c.a) : [])], base);
function imgId(url) {
  try {
    const segs = new URL(url).pathname.split("/").filter(Boolean);
    let name = (segs.pop() || "").replace(/\.\w{2,5}$/, "");
    if (segs.length && (name.length <= 6 || /^\d+x?\d*$/.test(name))) name = segs.pop() + "/" + name;
    return name;
  } catch { return null; }
}
const fmtImg = (url, mode) => !url || mode === "none" ? null : mode === "full" ? url : imgId(url);

// ---------- ツリー ----------
async function buildTree(html, textSel) {
  if (!/<body[\s>]/i.test(html)) html = "<body>" + html;
  const root = { t: "root", a: {}, c: [], p: null, d: 0, u: 0 };
  const meta = { title: "", desc: "", next: "", scripts: [], partial: null };
  let cur = root, drop = 0, uid = 0, sc = null, tb = "", inHead = false, tt = "", scTotal = 0;
  const hook = (el, fn) => { try { el.onEndTag(fn); return true; } catch { return false; } };
  function onText(t) {
    if (drop || inHead && !sc) return;
    if (sc) { if (scTotal < 800000) { sc.txt += t.text; scTotal += t.text.length; } return; }
    tb += t.text;
    if (!t.lastInTextNode) return;
    const x = tb; tb = "";
    if (x) cur.c.push(/\S/.test(x) || cur.t === "pre" ? x : " ");
  }
  try {
    await new HTMLRewriter()
      .on("title", { text(t) { tt += t.text; if (t.lastInTextNode) { meta.title = clean(tt); tt = ""; } } })
      .on("*", {
        element(el) {
          const t = el.tagName;
          if (drop) return;
          const a = {}; for (const [k, v] of el.attributes) a[k] = v;
          if (t === "meta") { const n = (a.name || a.property || "").toLowerCase(); if ((n === "description" || n === "og:description") && !meta.desc) meta.desc = a.content || ""; return; }
          if (t === "link") { if (/\bnext\b/i.test(a.rel || "") && a.href) meta.next = a.href; return; }
          if (t === "title") return;
          if (t === "head") { if (hook(el, () => { inHead = false; })) inHead = true; return; }
          if (DROP.has(t)) { if (hook(el, () => { drop--; })) drop++; return; }
          if (t === "script") { if (a.src) return; const o = { txt: "", type: a.type || "", id: a.id || "" }; if (hook(el, () => { if (sc && sc.txt) meta.scripts.push(sc); sc = null; })) sc = o; return; }
          const n = { t, a, c: [], p: cur, d: cur.d + 1, u: ++uid };
          cur.c.push(n);
          if (!VOID.has(t) && hook(el, () => { cur = n.p || root; })) cur = n;
        },
        ...(textSel === "*" ? { text: onText } : {}),
      })
      .on(textSel === "*" ? "html-never" : "body", { text: onText })
      .transform(new Response(html, { headers: { "content-type": "text/html" } })).arrayBuffer();
  } catch (e) { meta.partial = String((e && e.message) || e); }
  return { root, meta };
}

const walk = (n, f) => { for (const c of n.c) if (typeof c !== "string" && f(c) !== false) walk(c, f); };
const inside = (n, tags) => { for (let p = n.p; p; p = p.p) if (tags.includes(p.t)) return true; return false; };
function tx(n) {
  if (n._x !== undefined) return n._x;
  let s = "";
  for (const c of n.c) s += typeof c === "string" ? c : c._skip || NOTEXT.has(c.t) ? "" : INLINE.has(c.t) ? tx(c) : " " + tx(c) + " ";
  return (n._x = clean(s));
}
function leaves(n, del, out) {
  let buf = "";
  const flush = () => { const s = clean(buf); if (s) out.push({ s, n, del }); buf = ""; };
  for (const c of n.c) {
    if (typeof c === "string") { buf += c; continue; }
    if (c._skip || NOTEXT.has(c.t)) continue;
    if (INLINE.has(c.t) && !c.a.class && c.t !== "a" && !DEL.has(c.t) && c.t !== "time") { buf += " " + tx(c) + " "; continue; }
    flush(); leaves(c, del || DEL.has(c.t), out);
  }
  flush(); return out;
}
const NOISE_CLS = /(^|[\s_-])(g?nav|navbar|navigation|menu|breadcrumbs?|pankuzu|sidebar|footer|cookie|banner|modal|popup|category-?tree|cat-?tree|ads?|share|sns)([\s_-]|$)/i;
const LAND_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar"]);
function markNoise(root, byClass) {
  walk(root, (n) => {
    const k = (n.a.class || "") + " " + (n.a.id || "");
    const role = String(n.a.role || "").toLowerCase();
    if (n.t === "nav" || n.t === "aside" || LAND_ROLES.has(role) || ((n.t === "header" || n.t === "footer") && !inside(n, ["article", "aside", "main", "nav", "section", "li"])) ||
      (byClass && n.t !== "body" && NOISE_CLS.test(k)) || n.a.hidden !== undefined || n.a["aria-hidden"] === "true") { n._skip = true; return false; }
  });
}

// ---------- 一覧アイテム検出 ----------
function hasLink(n) { let f = n.t === "a" && n.a.href; if (!f) walk(n, (e) => { if (e.t === "a" && e.a.href && !/^(#|javascript:)/.test(e.a.href)) f = true; return !f; }); return !!f; }
function mediaIn(n) { let f = false; walk(n, (e) => { if (e.t === "img" || e.t === "picture" || e.t === "video" || /url\(/i.test(e.a.style || "")) f = true; return !f; }); return f; }
const noisyUp = (n) => { for (let e = n; e; e = e.p) if (NOISE_CLS.test((e.a.class || "") + " " + (e.a.id || ""))) return true; return false; };
function findItems(root) {
  const groups = new Map();
  walk(root, (n) => {
    if (n._skip || n._rel) return false;
    if (n.t === "span" || n.t === "img" || n.t === "b" || n.t === "i") return;
    const key = `${n.t}|${n.a.class || ""}|${n.d}|${n.a.class ? "" : n.p.u}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(n);
  });
  const out = [];
  for (const g of groups.values()) {
    if (g.length < 3) continue;
    const ok = g.filter((n) => tx(n).length >= 4 && hasLink(n));
    if (ok.length < 3) continue;
    const avg = ok.reduce((x, n) => x + tx(n).length, 0) / ok.length;
    const media = ok.filter(mediaIn).length / ok.length;
    let sc = ok.length * Math.min(avg, 400) * (0.4 + media) * (media >= 0.5 ? 1.5 : 1);
    if (noisyUp(ok[0]) && media < 0.5) continue;
    if (media < 0.3 && avg < 30) continue;
    out.push({ nodes: ok, sc });
  }
  return out.sort((a, b) => b.sc - a.sc).slice(0, 6).map((x) => x.nodes);
}

// ---------- フィールド抽出 ----------
const CL = [[/shipping|postage|送料|配送料/i, "shipping"], [/buyback|買取|買い取り/i, "buyback"], [/list-?price|regular-?price|定価|msrp|original-?price/i, "list_price"], [/used|中古/i, "used_price"], [/price|価格|金額/i, "price"], [/discount|割引|(^|[-_ ])off([-_ ]|$)/i, "off"],
  [/like|fav|heart|いいね|お気に入り/i, "likes"], [/view|再生|閲覧/i, "views"], [/comment|コメント/i, "comments"], [/rating|star|score|評価/i, "rating"],
  [/stock|在庫/i, "stock"], [/release|発売|入荷/i, "release"], [/(^|[-_ ])(date|time|posted|publish)/i, "date"],
  [/model|actor|performer|出演/i, "model"], [/author|user-?name|screen-?name|account|投稿者|ユーザー/i, "author"], [/studio|maker|brand|メーカー|ブランド/i, "studio"], [/scale|スケール/i, "scale"], [/badge|ステータス|status/i, "status"]];
const UNIT = [[/(\d[\d,]*)\s*(?:I\s+)?(?:likes?|いいね|좋아요|赞)/i, "likes"], [/(\d[\d,]*)\s*(?:views?|回再生|回閲覧)/i, "views"], [/(\d[\d,]*)\s*comments?/i, "comments"], [/(\d[\d,]*)\s*(?:pt|ポイント)/i, "points"]];
const STAT = [[/予約/, "予約品"], [/品切れ|売り?切れ|sold ?out|在庫なし/i, "品切れ"], [/在庫あり|in stock/i, "在庫あり"], [/再販/, "再販"], [/入荷待ち|お?取り寄せ/, "取り寄せ"]];
function labelOf(n, stop) {
  for (let e = n; e && e !== stop; e = e.p) {
    const k = (e.a.class || "") + " " + (e.a.id || "") + " " + (e.a["aria-label"] || "") + " " + (e.a.title || "");
    if (k.trim()) for (const [re, lb] of CL) if (re.test(k)) return lb;
  }
  return null;
}
const CUR = { "¥": null, "￥": null, "円": null, "$": "USD", "US$": "USD", "€": "EUR", "£": "GBP", "₩": "KRW", "원": "KRW", "元": "CNY" };
const priceOf = (s) => {
  const m = s.match(/(US\$|[¥￥€£₩$])\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(円|元|원)/);
  return m ? { v: toNum(m[2] || m[3]), cur: CUR[m[1] || m[4]] || null } : null;
};
const NUMK = new Set(["price", "list_price", "used_price", "new_price", "shipping", "buyback", "off", "likes", "views", "comments", "rating", "stock", "points", "qty"]);
const firstNum = (s) => { const m = s.match(/\d[\d,]*(?:\.\d+)?/); return m ? toNum(m[0]) : NaN; };
const lbOfText = (s) => { for (const [re, lb] of CL) if (re.test(s)) return lb; return null; };

function collectFields(node, ctx, boil, skipText, wantExtra) {
  const f = [], extra = [], seen = new Set();
  const add = (k, v) => { if (v === "" || v == null || Number.isNaN(v) || seen.has(k)) return; seen.add(k); f.push([k, String(v)]); };
  const ls = leaves(node, false, []);
  let prev = null;
  for (let i = 0; i < ls.length; i++) {
    const { s, n, del } = ls[i];
    if (n.t === "time" && /^\d{4}-\d{2}-\d{2}/.test(n.a.datetime || "")) { add("date", n.a.datetime.slice(0, 10)); prev = null; continue; }
    if (boil.has(s) || (skipText && (s === skipText || (s.length > 3 && (skipText.includes(s) || s.includes(skipText)))))) { prev = null; continue; }
    const lb = labelOf(n, node);
    const isNum = /^[\d,.]+%?$/.test(s);
    if (n.t === "time" || lb === "date") { const d = n.a.datetime ? n.a.datetime.slice(0, 10) : normDate(s); if (d) { add("date", d); prev = null; continue; } }
    if (lb && NUMK.has(lb)) {
      if (/price$/.test(lb) || lb === "shipping" || lb === "buyback") { const p = priceOf(s) || (isNum ? { v: toNum(s) } : null); if (p) { add(del && lb === "price" ? "list_price" : lb, p.v); if (p.cur) add("cur", p.cur); } }
      else { const v = firstNum(s); if (!Number.isNaN(v)) add(lb, lb === "off" ? v + "%" : v); }
      prev = null; continue;
    }
    if (isNum) {
      const k = prev && lbOfText(prev.s);
      if (k && NUMK.has(k)) { const j = extra.indexOf(prev.s); if (j >= 0) extra.splice(j, 1); add(k, toNum(s)); }
      prev = null; continue;
    }
    if (lb && ["model", "studio", "scale", "status", "author"].includes(lb) && s.length <= 40) { add(lb, lb === "status" ? (STAT.find(([re]) => re.test(s)) || [0, cut(s, 20)])[1] : s); prev = null; continue; }
    let used = false;
    {
      const re = /(US\$|[¥￥€£₩$])\s*(\d[\d,]*(?:\.\d+)?)|(\d[\d,]*(?:\.\d+)?)\s*(円|元|원)/g;
      let m, last = 0, first = true;
      while ((m = re.exec(s))) {
        const pre = s.slice(Math.max(last, m.index - 14), m.index); last = m.index + m[0].length;
        const pv = first && prev && prev.s.length <= 12 ? prev.s : ""; first = false;
        const ctxs = pv + " " + pre + " " + m[0];
        const v = toNum(m[2] || m[3]), cur = CUR[m[1] || m[4]] || null;
        const kind = /送料|配送料|shipping|postage/i.test(ctxs) ? "shipping" : /買取|買い取り|buyback|trade-?in/i.test(ctxs) ? "buyback"
          : /ポイント|クーポン|coupon|他店|他ショップ|マーケットプレイス|marketplace|出品者|seller|手数料/i.test(ctxs) ? null : "price";
        if (kind === "shipping" || kind === "buyback") add(kind, v);
        else if (kind) { add(del || /定価|希望小売|通常価格/.test(ctxs) ? "list_price" : /中古|used/i.test(ctxs) ? "used_price" : /新品|\bnew\b/i.test(ctxs) ? "new_price" : "price", v); if (cur) add("cur", cur); }
        used = true;
      }
    }
    if (/^[^\n]{0,60}@[A-Za-z0-9_]{2,30}$/.test(s) && !/\s@\s/.test(s)) { add("author", s); prev = null; continue; }
    const om = s.match(/(\d{1,3})\s*[%％]\s*(?:OFF|off|オフ)/); if (om) { add("off", om[1] + "%"); used = true; }
    for (const [re, k] of UNIT) { const m = s.match(re); if (m) { add(k, toNum(m[1])); used = true; } }
    const rel = /発売|入荷|予定|再販|release/i.test(s) || /\d月(以降|上旬|中旬|下旬)/.test(s);
    const dt = normDate(s);
    if (rel) {
      const m = s.match(/(?:(\d{4})年)?\s*(\d{1,2})月(?:\s*(\d{1,2})日)?\s*(以降|上旬|中旬|下旬|頃|予定)?/);
      if (dt) add("release", dt);
      else if (m) add("release", m[1] && m[3] ? iso(m[1], m[2], m[3]) : m[1] ? `${m[1]}-${String(m[2]).padStart(2, "0")}${m[4] || ""}` : `${m[2]}月${m[4] || ""}`);
      else { const u = s.match(/(?:発売|入荷)(?:予定)?(?:日)?[:：]?\s*(.{1,12})/); if (u) add("release", u[1].trim()); }
      used = used || !!(dt || m);
    } else if (dt) { add("date", dt); used = true; }
    if (s.length <= 24) for (const [re, v] of STAT) if (re.test(s)) { add("status", v); used = true; }
    if (used && s.replace(/[\d,¥￥円%％\s:：\-\/.年月日以降上旬中旬下旬予定発売OFFoff定価]/g, "").length <= 6) { prev = null; continue; }
    if (wantExtra && s.length <= 40 && extra.length < 3) extra.push(s);
    prev = { s };
  }
  return { f, extra };
}

const SKIPLB = new Set(["intent", "share", "login", "signin", "signup", "search", "hashtag", "i", "home"]);
const inHeading = (l, root) => { for (let e = l; e && e !== root; e = e.p) if (/^h[1-6]$/.test(e.t)) return true; return false; };
function itemLinks(n, base) {
  const out = [];
  const push = (e) => {
    if (!e.a.href || /^(#|javascript:|mailto:|tel:)/.test(e.a.href)) return;
    const h = abs(e.a.href, base); if (!h) return;
    const u = new URL(h), ss = u.pathname.split("/").filter(Boolean), sl = ss.length >= 2 ? ss[ss.length - 2] : "";
    out.push({ n: e, h, u, ss, sl, prof: ss.length <= 1, key: u.host + "|" + (/^\d+$/.test(sl) ? "#" : sl) });
  };
  if (n.t === "a") push(n);
  walk(n, (e) => { if (e._skip) return false; if (e.t === "a") push(e); });
  return out;
}
function itemParts(n) {
  let hd = null; walk(n, (e) => { if (!hd && /^h[1-6]$/.test(e.t)) hd = e; return !hd; });
  let img = null; walk(n, (e) => { if (!img && e.t === "img") img = e; return !img; });
  return { hd, img };
}
const nameCands = (p) => ({ hd: p.hd ? tx(p.hd) : "", link: p.main && tx(p.main).length <= 120 ? tx(p.main) : "", alt: p.img ? clean(p.img.a.alt || "") : "" });
const ID_ATTR = /^data-(?:id|pid|sku|[a-z0-9-]*-id|(?:post|item|product|video|gallery|thread|article|entry|content|tweet|status|user)id)$/;
function dataIdsOf(n) {
  const o = {};
  const chk = (e, par) => { if (/^(img|source|picture|video|svg)$/.test(e.t)) return; for (const k in e.a) { const v = String(e.a[k]).trim(); if (ID_ATTR.test(k) && /^[\w.:-]{1,80}$/.test(v) && !/^(true|false|0)$/.test(v)) { const kk = k.slice(5).replace(/-/g, ""); if (!o[kk]) o[kk] = { v, par }; } } };
  chk(n, false); walk(n, (e) => { chk(e, false); }); if (n.p) chk(n.p, true);
  return o;
}
const URLISH = /^(?:https?:)?\/\/\S+$|^\/\S+$|^\S+\.(?:jpe?g|png|webp|gif|avif|mp4|webm|m4v|mov)(?:[?#]\S*)?$/i;
function previewsOf(n) {
  const out = [];
  const chk = (e) => { for (const k in e.a) if (/^data-[\w-]*(preview|hover|thumb|alt-?src)/.test(k)) { const v = String(e.a[k]).trim(); if (URLISH.test(v)) out.push(v); } };
  chk(n); walk(n, (e) => { chk(e); });
  return [...new Set(out)];
}
const pickMain = (ls, kind) => ls.filter((l) => l.key === kind).sort((a, b) => tx(b.n).length - tx(a.n).length)[0];

function itemRecord(n, ctx, boil, nameSrc, st) {
  const r = [], base = ctx.base, has = new Set();
  const add = (k, v) => { if (v === "" || v == null || has.has(k)) return; has.add(k); r.push([k, String(v)]); };
  const all = itemLinks(n, base).filter((l) => !st.common.has(l.h));
  const main = pickMain(all, st.kind);
  const p = { ...itemParts(n), main: main && main.n }, img = p.img;
  const dids = {}; for (const [k, o] of Object.entries(dataIdsOf(n))) if (!o.par || st.dataKeys.has(k)) dids[k] = o.v;
  let nid = null, slug = null;
  if (main) {
    const last = (main.ss[main.ss.length - 1] || "").replace(/\.\w{2,5}$/, "");
    const qid = main.u.searchParams.get("id") || main.u.searchParams.get("pid") || main.u.searchParams.get("p");
    const numId = qid || (main.u.pathname.match(/(\d{4,})(?!.*\d{4,})/) || [])[1];
    try { slug = decodeURIComponent(last); } catch { slug = last; }
    nid = numId || slug;
    add("id", nid);
    if (numId && slug && slug !== numId && !/^\d+$/.test(slug)) add("slug", slug);
    add("link", main.u.host === ctx.urlObj.host ? main.u.pathname + main.u.search : main.u.href);
  } else if (Object.values(dids)[0]) { nid = Object.values(dids)[0]; add("id", nid); }
  let title = nameSrc ? nameCands(p)[nameSrc] : "";
  if (title.length > 160) title = cut(title, 160) + "…";
  add("name", title);
  for (const [k, v] of Object.entries(dids)) if (String(v) !== String(nid)) add(k, v);
  const sec = new Map();
  for (const l of all) {
    if (l.key === st.kind || (main && l.h === main.h)) continue;
    const lb = l.prof ? "author" : /^[a-z][a-z_-]{1,19}$/i.test(l.sl) ? l.sl.toLowerCase() : null;
    if (!lb || SKIPLB.has(lb)) continue;
    const t = tx(l.n), sl = (l.ss[l.ss.length - 1] || "").replace(/\.\w{2,5}$/, "");
    const v = t && t.length <= 60 ? t : /^\d+$/.test(sl) ? "" : sl;
    if (!v) continue;
    const a = sec.get(lb) || sec.set(lb, new Map()).get(lb), o = a.get(l.h);
    if (!o) { if (a.size < 5) a.set(l.h, { v, text: !!(t && t.length <= 60) }); }
    else if (!o.text && t && t.length <= 60) a.set(l.h, { v, text: true });
  }
  const { f, extra } = collectFields(n, ctx, boil, title, ctx.extra);
  for (const [k, v] of f) add(k, v);
  for (const [k, a] of sec) add(k, [...new Set([...a.values()].map((o) => o.v))].join(","));
  for (const x of extra) add("extra", x);
  if (ctx.mode !== "none") {
    const src = img && fmtImg(imgSrc(img, base), ctx.mode); if (src) add("img", src);
    previewsOf(n).slice(0, 2).forEach((q, i) => add(i ? "preview2" : "preview", q));
  }
  return r;
}

// 戻り値 null = このグループは「複数アイテムを包むコンテナ」なので不採用
function extractItems(nodes, ctx) {
  const base = ctx.base, N = nodes.length;
  const raw = nodes.map((n) => itemLinks(n, base));
  const hc = new Map(); raw.forEach((ls) => new Set(ls.map((l) => l.h)).forEach((h) => hc.set(h, (hc.get(h) || 0) + 1)));
  const common = new Set(N >= 3 ? [...hc].filter(([, c]) => c >= N * 0.8).map(([h]) => h) : []);
  const ks = new Map();
  raw.forEach((ls, i) => {
    const per = new Map();
    for (const l of ls) { if (common.has(l.h)) continue; const e = per.get(l.key) || per.set(l.key, { hs: new Set(), media: false }).get(l.key); e.hs.add(l.h); if (mediaIn(l.n) || inHeading(l.n, nodes[i])) e.media = true; }
    per.forEach((e, k) => { const o = ks.get(k) || ks.set(k, { items: 0, hs: new Set(), dist: 0, media: 0 }).get(k); o.items++; e.hs.forEach((h) => o.hs.add(h)); o.dist += e.hs.size; if (e.media) o.media++; });
  });
  let kind = null, bs = -1, avgD = 1;
  for (const [k, o] of ks) {
    const cov = o.items / N, uniq = o.hs.size / o.dist;
    if (cov < 0.6 || uniq < 0.6) continue;
    const sc = cov * 0.3 + (o.media / o.items) * 0.5 + (o.items / o.dist) * 0.2;
    if (sc > bs) { bs = sc; kind = k; avgD = o.dist / o.items; }
  }
  if (kind && avgD > 1.6) return null;
  const dk = new Map(), dv = nodes.map(dataIdsOf);
  dv.forEach((o) => { for (const [k, x] of Object.entries(o)) if (x.par) (dk.get(k) || dk.set(k, new Set()).get(k)).add(x.v); });
  const dataKeys = new Set([...dk].filter(([, vs]) => vs.size >= N * 0.6).map(([k]) => k));
  const cnt = new Map();
  for (const n of nodes) for (const s of new Set(leaves(n, false, []).map((l) => l.s))) if (!/\d/.test(s)) cnt.set(s, (cnt.get(s) || 0) + 1);
  const boil = new Set();
  if (N >= 3) for (const [s, c] of cnt) if (c >= N * 0.8) boil.add(s);
  raw.forEach((ls) => ls.forEach((l) => { if (common.has(l.h)) { const t = tx(l.n); if (t) boil.add(t); } }));
  const cov = { hd: 0, link: 0, alt: 0 };
  nodes.forEach((n, i) => { const m = pickMain(raw[i].filter((l) => !common.has(l.h)), kind); const c = nameCands({ ...itemParts(n), main: m && m.n }); for (const k in cov) if (c[k]) cov[k]++; });
  const nameSrc = ["hd", "link", "alt"].find((k) => cov[k] >= N * 0.5) || null;
  const st = { kind, common, dataKeys };
  let recs = nodes.map((n) => itemRecord(n, ctx, boil, nameSrc, st)).filter((r) => r.length > 1);
  if (recs.length >= 5) {
    const kc = new Map(); recs.forEach((r) => new Set(r.map((x) => x[0])).forEach((k) => kc.set(k, (kc.get(k) || 0) + 1)));
    recs = recs.map((r) => r.filter(([k]) => ["id", "name", "link"].includes(k) || kc.get(k) >= recs.length * 0.2));
  }
  if (recs.length >= 3) {
    const col = (k) => recs.map((r) => (r.find((x) => x[0] === k) || [])[1]);
    for (const k of ["id", "link"]) { const v = col(k); if (v.every(Boolean) && new Set(v).size === 1) return null; }
  }
  return recs;
}
function linkRecords(root, ctx) {
  const out = [], seen = new Set();
  walk(root, (e) => { if (e._skip) return false; if (e.t === "a" && e.a.href && tx(e).length >= 2) { const h = abs(e.a.href, ctx.base); if (h && !seen.has(h) && out.length < 20) { seen.add(h); const ss = new URL(h).pathname.split("/").filter(Boolean); out.push([["id", (ss[ss.length - 1] || "").replace(/\.\w{2,5}$/, "")], ["name", cut(tx(e), 120)]]); } } });
  return out;
}

// ---------- ページ情報 ----------
function pageInfo(root, meta, ctx) {
  const u = ctx.urlObj, o = [];
  let pg = null, next = null, maxp = 0; const numLinks = new Map();
  walk(root, (e) => {
    const k = (e.a.class || "") + " " + (e.a.id || "");
    if (/pag(e?r|ination)|page-?nav|paging/i.test(k)) {
      walk(e, (c) => { if (c.t === "a" && /^\d{1,4}$/.test(tx(c))) { maxp = Math.max(maxp, +tx(c)); if (c.a.href) numLinks.set(+tx(c), c.a.href); } });
      walk(e, (c) => { if (!pg && (c.a["aria-current"] || /(^|[\s_-])(current|active|selected)([\s_-]|$)/i.test(c.a.class || "")) && /^\d+$/.test(tx(c))) pg = tx(c); });
      walk(e, (c) => { if (!next && c.t === "a" && c.a.href && (/\bnext\b/i.test(c.a.rel || "") || /^(次|次へ|次のページ|next|›|»|>|＞)/i.test(tx(c)) || /next|次/i.test(c.a.class || ""))) next = c.a.href; });
    }
    if (!next && e.t === "a" && /\bnext\b/i.test(e.a.rel || "") && e.a.href) next = e.a.href;
  });
  if (!next && meta.next) next = meta.next;
  if (!pg) pg = u.searchParams.get("page") || u.searchParams.get("p") || u.searchParams.get("paged") || (u.pathname.match(/\/page\/(\d+)/) || [])[1] || (u.pathname.match(/\/(\d{1,4})\/?$/) || [])[1] || "1";
  if (!next && pg && numLinks.has(+pg + 1)) next = numLinks.get(+pg + 1);
  const text = tx(root).slice(0, 60000);
  const tm = text.match(/(?:全|計|合計)?\s*([\d,]+)\s*(?:件|点|商品|アイテム)/) || text.match(/([\d,]+)\s*(?:results|items|videos|galleries|products|photos|models)/i) || text.match(/\bof\s+([\d,]+)\b/i);
  let nx = null; if (next) { const h = abs(next, ctx.base); if (h) { const x = new URL(h); nx = x.host === u.host ? x.pathname + x.search : h; } }
  const total = tm ? toNum(tm[1]) : null;
  let pages = maxp ? Math.max(maxp, +pg || 0) : null;
  if (!pages && total && ctx.count && nx) pages = Math.ceil(total / ctx.count);
  return { page: pg, total, next: nx, pages };
}

// ---------- Markdown（詳細本文） ----------
function md(n, c) {
  let o = "";
  for (const ch of n.c) {
    if (typeof ch === "string") { o += c.pre ? decode(ch).replace(/\r?\n/g, "\u0001").replace(/ /g, "\u0002").replace(/\t/g, "\u0002\u0002") : decode(ch).replace(/\s+/g, " "); continue; }
    if (ch._skip || NOTEXT.has(ch.t)) continue;
    const t = ch.t, nl = (k) => (c.cell ? " " : "\n".repeat(k));
    let m;
    if ((m = t.match(/^h([1-6])$/))) { o += nl(2) + "#".repeat(+m[1]) + " " + md(ch, c) + nl(2); continue; }
    switch (t) {
      case "br": o += nl(1); break;
      case "hr": o += "\n\n---\n\n"; break;
      case "p": case "figure": case "section": case "dl": o += nl(2) + md(ch, c) + nl(2); break;
      case "div": case "dt": case "dd": case "header": case "main": case "article": o += nl(1) + md(ch, c) + nl(1); break;
      case "strong": case "b": o += "**" + md(ch, c) + "**"; break;
      case "em": case "i": o += "*" + md(ch, c) + "*"; break;
      case "code": o += c.pre ? md(ch, c) : "`" + md(ch, c) + "`"; break;
      case "pre": c.pre = 1; o += "\n\n```\n" + md(ch, c) + "\n```\n\n"; c.pre = 0; break;
      case "blockquote": o += "\n\n> " + md(ch, c) + "\n\n"; break;
      case "a": { const h = ch.a.href && !/^(#|javascript:|mailto:|tel:)/i.test(ch.a.href) ? abs(ch.a.href, c.base) : null; const inner = md(ch, c).trim();
        if (h && inner) { const x = new URL(h); o += `[${inner}](${x.host === c.host ? x.pathname + x.search : h})`; } else o += inner; break; }
      case "img": if (c.mode === "full") { const s = imgSrc(ch, c.base); if (s) o += `![${clean(ch.a.alt || "")}](${s})`; } break;
      case "ul": case "ol": c.lists.push({ ord: t === "ol", n: 0 }); o += "\n" + md(ch, c) + "\n"; c.lists.pop(); break;
      case "li": { const L = c.lists[c.lists.length - 1]; o += "\n" + "\u0002\u0002".repeat(Math.max(0, c.lists.length - 1)) + (L && L.ord ? ++L.n + ". " : "- ") + md(ch, c); break; }
      case "table": o += "\n\n" + md(ch, c) + "\n\n"; break;
      case "tr": o += "\n|" + md(ch, c); break;
      case "td": case "th": c.cell = (c.cell || 0) + 1; o += " " + md(ch, c).trim() + " |"; c.cell--; break;
      default: o += md(ch, c);
    }
  }
  return o;
}
const tidy = (s) => s.replace(/\[\s*\]\([^)]*\)/g, "").replace(/\*\*\s*\*\*/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n +/g, "\n").replace(/ {2,}/g, " ")
  .replace(/^(?:\u0002)*(?:-|\d+\.) *$/gm, "").replace(/\n{3,}/g, "\n\n").trim().replace(/\u0001/g, "\n").replace(/\u0002/g, " ");

// ---------- 埋め込みJSON ----------
const NAMEK = /^(title|name|productname|product_name|label|headline)$/i;
function bestArray(v) {
  let best = null, bs = 0;
  const rec = (x, d) => {
    if (d > 8 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      const objs = x.filter((o) => o && typeof o === "object" && !Array.isArray(o));
      if (objs.length >= 3) { const keys = new Set(); objs.slice(0, 5).forEach((o) => Object.keys(o).forEach((k) => keys.add(k))); const sc = objs.length * keys.size; if (sc > bs && [...keys].some((k) => NAMEK.test(k))) { bs = sc; best = objs; } }
      x.forEach((e) => rec(e, d + 1));
    } else Object.values(x).forEach((e) => rec(e, d + 1));
  };
  rec(v, 0); return best;
}
function jsonRecord(o, ctx) {
  const r = [], snake = (k) => k.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  const idk = Object.keys(o).find((k) => /^(id|postid|post_id|productid|product_id|itemid|item_id|_id|uuid|slug|code)$/i.test(k));
  const nk = Object.keys(o).find((k) => NAMEK.test(k));
  if (idk) r.push(["id", String(o[idk])]);
  if (nk) r.push(["name", cut(clean(String(o[nk])), 160)]);
  for (const [k0, v] of Object.entries(o)) {
    if (k0 === idk || k0 === nk || v == null || r.length >= 16) continue;
    const k = snake(k0);
    if (typeof v === "number" || typeof v === "boolean") r.push([k, String(v)]);
    else if (typeof v === "string") {
      if (/image|img|thumb|photo|cover|poster|preview/.test(k)) { const x = fmtImg(abs(v, ctx.base), ctx.mode); if (x) r.push([k, x]); }
      else if (/date|time|_at$|^at$/.test(k)) { const d = /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : normDate(v); if (d) r.push([k, d]); }
      else if (/^(https?:)?\//.test(v)) { const ss = v.split("?")[0].split("/").filter(Boolean); r.push([k, (ss[ss.length - 1] || "").replace(/\.\w{2,5}$/, "")]); }
      else if (v.length <= 80) r.push([k, clean(v)]);
    }
  }
  return r;
}
function jsonFromScripts(meta, ctx) {
  for (const s of meta.scripts) {
    let data = null;
    try {
      if (/json/i.test(s.type) || s.id === "__NEXT_DATA__") data = JSON.parse(s.txt);
      else if (/__INITIAL_STATE__|__NUXT__|__APOLLO_STATE__|__DATA__/.test(s.txt)) { const i = s.txt.indexOf("{"), j = s.txt.lastIndexOf("}"); if (i >= 0 && j > i) data = JSON.parse(s.txt.slice(i, j + 1)); }
    } catch { continue; }
    const arr = data && bestArray(data);
    if (arr) return arr.map((o) => jsonRecord(o, ctx)).filter((r) => r.length > 1);
  }
  return [];
}

function findRelated(root) {
  const rel = [];
  walk(root, (n) => {
    if (n._skip) return false;
    const k = (n.a.class || "") + " " + (n.a.id || "");
    if (n.t !== "body" && n.t !== "html" && /related|recommend|similar|also-?like|more-?(from|like)|関連|おすすめ|オススメ/i.test(k) && tx(n).length > 0) { rel.push(n); return false; }
    if (/^h[2-6]$/.test(n.t) && tx(n).length < 40 && /関連|おすすめ|オススメ|related|you may also|similar|recommended|more like/i.test(tx(n)) && n.p && n.p.t !== "body") {
      let links = 0; walk(n.p, (e) => { if (e.t === "a" && e.a.href) links++; });
      if (links >= 3) { rel.push(n.p); return false; }
    }
  });
  const up = (x, m) => { for (let p = x.p; p; p = p.p) if (p === m) return true; return false; };
  return rel.filter((n) => !rel.some((m) => m !== n && up(n, m)));
}

function jsNote(root, meta) {
  let empty = false;
  walk(root, (n) => {
    if (n._skip) return false;
    const k = (n.a.class || "") + " " + (n.a.id || "");
    if (/(^|[-_ ])(list|items?|results?|grid|cards?|products?|feed)([-_ ]|$)/i.test(k) && !n.c.some((c) => typeof c !== "string") && tx(n).length < 20) empty = true;
  });
  const t = tx(root);
  if (empty || /enable javascript|JavaScriptを有効|JavaScript is required|requires JavaScript/i.test(t) || (t.length < 300 && meta.scripts.length > 0))
    return "js-rendered: list or content may be loaded by JavaScript and is missing from the HTML";
  return null;
}

// ---------- 解析本体 ----------
function analyze(root, meta, ctx) {
  const urlStr = ctx.urlObj.host + ctx.urlObj.pathname + ctx.urlObj.search;
  markNoise(root, false);
  const relRoots = findRelated(root);
  relRoots.forEach((n) => { n._rel = true; });
  let items = [];
  const groups = findItems(root);
  for (const g of groups) { const r = extractItems(g, ctx); if (r && r.length >= 3) { items = r; break; } }
  let src = "html";
  if (items.length < 3) { const j = jsonFromScripts(meta, ctx); if (j.length >= 3) { items = j; src = "embedded-json"; } }
  if (items.length >= 3) {
    const pi = pageInfo(root, meta, { ...ctx, count: items.length });
    const page = [["type", "list"], ["url", urlStr], ["page", pi.page], ["count", items.length], ["total", pi.total], ["pages", pi.pages], ["has_next", pi.next || (pi.pages && +pi.page < pi.pages) ? "true" : "false"], ["next", pi.next], ["source", src === "html" ? null : src]].filter(([, v]) => v != null);
    return { page, items };
  }
  if (groups.length > 0) {
    const pi = pageInfo(root, meta, { ...ctx, count: 0 });
    return { page: [["type", "list"], ["url", urlStr], ["page", pi.page], ["count", 0], ["total", pi.total], ["pages", pi.pages], ["has_next", pi.next || (pi.pages && +pi.page < pi.pages) ? "true" : "false"], ["next", pi.next], ["note", "no list block detected"]].filter(([, v]) => v != null), items: [] };
  }
  // 詳細ページ
  walk(root, (n) => { delete n._x; });
  markNoise(root, true);
  relRoots.forEach((n) => { n._skip = true; });
  walk(root, (n) => { delete n._x; });
  let main = null, ms = 0;
  walk(root, (n) => { if (!n._skip && (n.t === "main" || n.t === "article") && tx(n).length > ms) { main = n; ms = tx(n).length; } });
  main = main || root;
  let h1 = null; walk(main, (n) => { if (!h1 && n.t === "h1" && !n._skip) h1 = n; return !h1; });
  const title = h1 ? tx(h1) : meta.title;
  const { f } = collectFields(main, ctx, new Set(), title, false);
  const rec = [["id", ((ctx.urlObj.pathname.match(/(\d{4,})(?!.*\d{4,})/) || [])[1]) || ctx.urlObj.pathname.split("/").filter(Boolean).pop() || ""], ["name", title]];
  const seen = new Set();
  for (const [k, v] of f) if (!seen.has(k) && rec.length < 14) { seen.add(k); rec.push([k, v]); }
  const imgs = [];
  walk(main, (n) => { if (n._skip) return false; if (n.t === "img" && imgs.length < 10 && !(n.a.width && +n.a.width < 60)) { const x = fmtImg(imgSrc(n, ctx.base), ctx.mode); if (x && !imgs.includes(x)) imgs.push(x); } });
  if (imgs.length) rec.push(["images", imgs.join(",")]);
  const spec = [];
  walk(main, (n) => {
    if (n._skip) return false;
    if (n.t === "tr") { const cells = n.c.filter((c) => typeof c !== "string" && (c.t === "th" || c.t === "td")); if (cells.length === 2 && tx(cells[0]).length <= 20 && tx(cells[1]).length <= 100 && spec.length < 30) spec.push([tx(cells[0]), tx(cells[1])]); }
    if (n.t === "dl") { let k = null; for (const c of n.c) if (typeof c !== "string") { if (c.t === "dt") k = tx(c); else if (c.t === "dd" && k && spec.length < 30) { spec.push([k, cut(tx(c), 100)]); k = null; } } }
  });
  // 詳細ページらしい根拠（本文が十分ある／仕様表／価格／main・article）が無ければ、無理に詳細にせず一覧なし(count:0)で返す
  const evidence = ms >= 200 || spec.length > 0 || f.some(([k]) => /price$/.test(k)) || main !== root;
  if (!evidence) {
    const pi = pageInfo(root, meta, { ...ctx, count: 0 });
    return { page: [["type", "list"], ["url", urlStr], ["page", pi.page], ["count", 0], ["total", pi.total], ["pages", pi.pages], ["has_next", pi.next || (pi.pages && +pi.page < pi.pages) ? "true" : "false"], ["next", pi.next], ["note", jsNote(root, meta) || "no list block detected"]].filter(([, v]) => v != null), items: [] };
  }
  const sk = new Set(spec.map(([k]) => k));
  for (let i = rec.length - 1; i >= 2; i--) if (sk.has(rec[i][0])) rec.splice(i, 1);
  const c = { base: ctx.base, host: ctx.urlObj.host, mode: ctx.mode, lists: [], pre: 0, cell: 0 };
  let text = tidy(md(main, c));
  if (text.length > ctx.maxChars) text = cut(text, ctx.maxChars) + `\n…[truncated ${text.length - ctx.maxChars} chars]`;
  const related = [];
  for (const r of relRoots) {
    let its = null; for (const g of findItems(r)) { const x = extractItems(g, ctx); if (x && x.length >= 3) { its = x; break; } }
    its = its || linkRecords(r, ctx);
    related.push(...its.slice(0, 20));
  }
  return { page: [["type", "detail"], ["url", urlStr], ["count", 1], ["note", jsNote(root, meta)]].filter(([, v]) => v != null), items: [rec], spec, body: text, related };
}

function looseMarkdown(html, base, host) {
  let s = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, "");
  s = s.replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, h, t) => {
    t = clean(t.replace(/<[^>]+>/g, "")); const x = abs(h, base);
    return x && t ? `[${t}](${new URL(x).host === host ? new URL(x).pathname : x})` : t;
  });
  s = s.replace(/<\/?(p|div|li|tr|h[1-6]|br|section|article|table|ul|ol|blockquote)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, "");
  return decode(s).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

// ---------- 出力 ----------
const fmt = (r) => r.map(([k, v]) => `${k}:${String(v).replace(/\s*\|\s*/g, " / ").replace(/\s+/g, " ").trim()}`).join(" | ");
const obj = (r) => { const o = {}; for (const [k, v] of r) o[k] = o[k] === undefined ? (/^-?\d+(\.\d+)?$/.test(v) && !/^0\d/.test(v) && !/id$|^slug$|^link$/.test(k) ? Number(v) : v) : [].concat(o[k], v); return o; };
function render(a, json) {
  if (json) return JSON.stringify({ page: obj(a.page), items: a.items.map(obj), ...(a.spec ? { spec: obj(a.spec) } : {}), ...(a.body !== undefined ? { body: a.body } : {}), ...(a.related ? { related: a.related.map(obj) } : {}) });
  let o = "page: " + fmt(a.page) + "\n" + a.items.map(fmt).join("\n");
  if (a.spec && a.spec.length) o += "\nspec: " + fmt(a.spec);
  if (a.body) o += "\n--\n" + a.body;
  if (a.related && a.related.length) o += "\nrelated:\n" + a.related.map(fmt).join("\n");
  return o + "\n";
}

// ---------- エラー・取得 ----------
const errResp = (json, code, msg, u, extra = {}) => {
  const { upstream, ...rest } = extra;
  const h = rest.retryAfter ? { "Retry-After": String(rest.retryAfter) } : {};
  const body = json ? JSON.stringify({ error: { code, ...(upstream ? { upstream } : {}), message: msg, url: u, ...rest } })
    : `error:${code}` + (upstream ? ` | upstream:${upstream}` : "") + ` | message:${msg} | url:${u}` + Object.entries(rest).map(([k, v]) => ` | ${k}:${v}`).join("") + "\n";
  return new Response(body, { status: code, headers: { "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", ...CORS, ...h } });
};
const parseRetry = (v) => { if (!v) return 60; if (/^\d+$/.test(v.trim())) return +v; const t = Date.parse(v); return Number.isNaN(t) ? 60 : Math.max(1, Math.ceil((t - Date.now()) / 1000)); };
const BLOCKED = /^(just a moment|attention required|access denied|forbidden|403|アクセスが制限|アクセスエラー|robot check)/i;
function blockedHost(h) { h = h.toLowerCase(); return h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.includes(":") || /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h); }
function parseTarget(u) {
  let t = u.searchParams.get("url"); const viaQuery = !!t;
  let nocache = /^(1|true)$/i.test(u.searchParams.get("nocache") || "");
  if (!t) {
    let search = u.search.replace(/([?&])nocache=(?:1|true)(?=&|$)&?/i, (m, sep) => { nocache = true; return sep; }).replace(/[?&]$/, "");
    let raw = u.pathname.slice(1); try { raw = decodeURIComponent(raw); } catch {} raw += search;
    const m = raw.match(/^(https?):\/+(.+)$/i); if (m) t = m[1] + "://" + m[2]; else if (/^[^\s/]+\.[^\s/]+/.test(raw)) t = "https://" + raw;
  }
  return { target: t, viaQuery, nocache };
}
async function readCapped(res) {
  const rd = res.body.getReader(), ch = []; let n = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; ch.push(value); n += value.length; if (n > MAX_BYTES) { rd.cancel(); break; } }
  const buf = new Uint8Array(n); let o = 0; for (const c of ch) { buf.set(c, o); o += c.length; } buf.truncated = n > MAX_BYTES; return buf;
}
const CS_ALIAS = { sjis: "shift_jis", "x-sjis": "shift_jis", ms932: "shift_jis", cp932: "shift_jis", "windows-932": "shift_jis", eucjp: "euc-jp", "ujis": "euc-jp", utf8: "utf-8" };
function decodeBody(buf, ct) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return new TextDecoder("utf-8").decode(buf.subarray(3));
  if (buf[0] === 0xFF && buf[1] === 0xFE) return new TextDecoder("utf-16le").decode(buf.subarray(2));
  if (buf[0] === 0xFE && buf[1] === 0xFF) return new TextDecoder("utf-16be").decode(buf.subarray(2));
  const head = new TextDecoder("latin1").decode(buf.subarray(0, 16384));
  let label = (ct.match(/charset=["']?([\w-]+)/i) || [])[1] || (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || (head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i) || [])[1];
  if (label) label = CS_ALIAS[label.toLowerCase()] || label;
  const strict = (l) => { try { return new TextDecoder(l, { fatal: true }).decode(buf); } catch { return null; } };
  const garbled = (t) => { const hk = (t.match(/[\uFF61-\uFF9F]/g) || []).length, non = (t.match(/[^\x00-\x7F]/g) || []).length; return non > 20 && hk / non > 0.3; };
  if (label) {
    const t = strict(label);
    if (t !== null && !garbled(t)) return t;
  }
  for (const l of ["utf-8", "shift_jis", "euc-jp"]) { const t = strict(l); if (t !== null && !garbled(t)) return t; }
  try { return new TextDecoder(label || "utf-8").decode(buf); } catch { return new TextDecoder("utf-8").decode(buf); }
}
const UA2 = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const UA3 = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const hdr = (u, v) => ({
  "User-Agent": v === 2 ? UA3 : v ? UA2 : UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8", "Upgrade-Insecure-Requests": "1",
  "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Site": v ? "same-origin" : "none", "Sec-Fetch-User": "?1",
  ...(v ? { Referer: new URL(u).origin + "/" } : { "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"', "sec-ch-ua-mobile": "?0", "sec-ch-ua-platform": '"Windows"' }),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getUpstream(url) {
  let waited = false, tries = 0, attempts = 0, last = null;
  while (tries < 3 && attempts < 5) {
    attempts++;
    let res;
    try { res = await fetch(url, { headers: hdr(url, tries), redirect: "follow", signal: AbortSignal.timeout(20000) }); }
    catch (e) { last = [502, "fetch failed: " + (e.message || e), {}]; tries++; if (tries < 3) await sleep(300 * tries); continue; }
    if (res.status === 429) {
      const ra = parseRetry(res.headers.get("retry-after"));
      if (!waited && ra <= MAX_WAIT) { waited = true; res.body && res.body.cancel(); await sleep(ra * 1000); continue; }
      return { err: [429, "rate limited by upstream", { upstream: 429, retryAfter: ra }], attempts };
    }
    if (res.status === 403 || res.status >= 500) {
      last = [res.status === 403 ? 403 : 502, `upstream returned HTTP ${res.status}`, { upstream: res.status }];
      res.body && res.body.cancel(); tries++; if (tries < 3) await sleep(300 * tries); continue;
    }
    if (!res.ok) return { err: [res.status === 404 ? 404 : res.status === 401 ? 403 : 502, `upstream returned HTTP ${res.status}`, { upstream: res.status }], attempts };
    return { res, attempts };
  }
  return { err: last || [502, "upstream unavailable", {}], attempts };
}

// キャッシュ応答・古い成功応答（stale-if-error）
function serveCached(body, ct, t, tag, extra = {}) {
  const age = Math.floor((Date.now() - t) / 1000);
  return new Response(body, { headers: { "Content-Type": ct, ...CORS, "Cache-Control": `public, max-age=${Math.max(0, TTL - age)}`, "X-Cache": tag, "X-Cache-Age": String(age), ...extra } });
}
function markStale(body, json, age, reason) {
  if (json) { try { const o = JSON.parse(body); if (o.page) { o.page.stale = true; o.page.stale_age = age; o.page.stale_reason = reason; } return JSON.stringify(o); } catch { return body; } }
  return body.replace(/^(page: [^\n]*)/, `$1 | stale:true | stale_age:${age} | stale_reason:${reason}`);
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (req.method !== "GET" && req.method !== "HEAD") return resp("method not allowed", 405);
    if (env.API_KEY && req.headers.get("authorization") !== `Bearer ${env.API_KEY}`) return resp("unauthorized", 401);
    const u = new URL(req.url);
    if (u.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    const { target, viaQuery, nocache: ncq } = parseTarget(u);
    if (!target) return resp("md-fetch v2\nGET /https://example.com/list  (JSON: Accept: application/json)\nキャッシュ迂回: 末尾に ?nocache=1（または &nocache=1）/ ヘッダー X-No-Cache: true\nヘッダー: X-Image-Mode: id|full|none / X-Mode: markdown / X-Max-Chars\n");
    let tu; try { tu = new URL(target); } catch { return resp("invalid url", 400); }
    const json = (req.headers.get("accept") || "").includes("application/json") || (viaQuery && u.searchParams.get("format") === "json");
    if (!/^https?:$/.test(tu.protocol) || blockedHost(tu.hostname)) return errResp(json, 403, "blocked url", target);
    const imode = ["id", "full", "none"].includes(req.headers.get("x-image-mode")) ? req.headers.get("x-image-mode") : "id";
    const mmode = req.headers.get("x-mode") === "markdown" ? "markdown" : "auto";
    const maxChars = Math.min(50000, +req.headers.get("x-max-chars") || 8000);
    const nocache = ncq || req.headers.get("x-no-cache") === "true";
    const colo = (req.cf && req.cf.colo) || "";
    const cache = caches.default;
    const key = new Request(u.origin + "/__cache/" + VERSION + "/" + [json ? "j" : "t", imode, mmode, maxChars, req.headers.get("x-extra") === "true" ? "x" : ""].join("") + "/" + encodeURIComponent(tu.href));
    let stale = null, kvKey = null;
    if (env.CACHE) {
      try { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key.url)); kvKey = "v:" + [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join(""); } catch {}
    }
    if (!nocache) {
      const hit = await cache.match(key);
      if (hit) { const t = +hit.headers.get("x-stored-at") || 0, ctt = hit.headers.get("content-type"), body = await hit.text(); if (Date.now() - t < TTL * 1000) return serveCached(body, ctt, t, "HIT"); stale = { body, ct: ctt, t, raw: hit.headers.get("x-raw") === "1" }; }
      if (kvKey) { try { const kv = await env.CACHE.get(kvKey, "json"); if (kv) { if (Date.now() - kv.t < TTL * 1000) return serveCached(kv.body, kv.ct, kv.t, "HIT-KV"); if (!stale || kv.t > stale.t) stale = kv; } } catch {} }
    }
    const fail = (code, msg, extra = {}) => {
      if (stale && ![400, 404, 415].includes(code)) {
        const age = Math.floor((Date.now() - stale.t) / 1000);
        return serveCached(stale.raw ? stale.body : markStale(stale.body, json, age, extra.upstream || code), stale.ct, stale.t, "STALE", { "X-Colo": colo, "X-Stale-Reason": `${code}${extra.upstream ? "/upstream " + extra.upstream : ""}` });
      }
      return errResp(json, code, msg, tu.href, { ...extra, colo });
    };

    const up = await getUpstream(tu.href);
    if (up.err) return fail(up.err[0], up.err[1], { ...up.err[2], attempts: up.attempts });
    const res = up.res, finalUrl = res.url || tu.href, ct = res.headers.get("content-type") || "";
    const isHtml = /html|xhtml/i.test(ct) || ct === "", isJson = /json/i.test(ct);
    if (!isHtml && !/^text\/|json|xml/i.test(ct)) return errResp(json, 415, "unsupported content-type: " + ct, tu.href);
    const buf = await readCapped(res), text = decodeBody(buf, ct);
    const c = { base: finalUrl, urlObj: new URL(finalUrl), mode: imode, maxChars, extra: req.headers.get("x-extra") === "true" };
    let out, rawCt = null;
    try {
      if (isJson) {
        if (buf.truncated) return errResp(json, 413, `upstream json exceeds ${MAX_BYTES} bytes`, tu.href, { upstream: res.status });
        out = text; rawCt = ct;
      } else if (!isHtml) out = render({ page: [["type", "text"], ["url", c.urlObj.host + c.urlObj.pathname]], items: [], body: cut(text, maxChars) }, json);
      else {
        let tree = await buildTree(text, "body");
        if (text.length > 2000 && tx(tree.root).length < 50) tree = await buildTree(text, "*");
        const { root, meta } = tree;
        if (BLOCKED.test(meta.title) || /cf-chl|challenge-platform/.test(text.slice(0, 20000)) && tx(root).length < 400) return fail(403, "blocked by upstream bot protection", { upstream: res.status, attempts: up.attempts });
        if (mmode === "markdown") { markNoise(root, true); const cc = { base: finalUrl, host: c.urlObj.host, mode: imode, lists: [], pre: 0, cell: 0 }; let body = tidy(md(root, cc)); if (meta.partial && body.length < 50) body = looseMarkdown(text, finalUrl, c.urlObj.host); out = `Title: ${meta.title}\n\nURL Source: ${finalUrl}\n\nMarkdown Content:\n${cut(body, maxChars)}\n`; if (json) out = JSON.stringify({ title: meta.title, url: finalUrl, content: out }); }
        else {
          let a = null; try { a = analyze(root, meta, c); } catch {}
          const urlStr = c.urlObj.host + c.urlObj.pathname + c.urlObj.search;
          if (!a || (meta.partial && a.page[0][1] !== "list")) a = { page: [["type", "text"], ["url", urlStr], ["note", "html parse error: fell back to loose conversion"]], items: [], body: cut(looseMarkdown(text, finalUrl, c.urlObj.host), maxChars) };
          else if (meta.partial) a.page.push(["note", "partial: html parse error, results may be incomplete"]);
          out = render(a, json);
        }
      }
    } catch (e) { return errResp(json, 500, "convert failed: " + (e.message || e), tu.href); }
    const ctype = rawCt || (json ? "application/json" : "text/plain") + "; charset=utf-8", t0 = Date.now();
    ctx.waitUntil(cache.put(key, new Response(out, { headers: { "Content-Type": ctype, "Cache-Control": `public, max-age=${STALE_TTL}`, "X-Stored-At": String(t0), "X-Raw": rawCt ? "1" : "0" } })));
    if (kvKey) ctx.waitUntil(env.CACHE.put(kvKey, JSON.stringify({ body: out, ct: ctype, t: t0, raw: !!rawCt }), { expirationTtl: STALE_TTL }).catch(() => {}));
    const r = serveCached(out, ctype, t0, nocache ? "BYPASS" : "MISS", { "X-Colo": colo, "X-Attempts": String(up.attempts), "X-Source-Bytes": String(text.length), "X-Output-Bytes": String(out.length) });
    return r;
  },
};
export const _t = { analyze, markNoise, tx, cut, decodeBody, parseTarget, markStale };