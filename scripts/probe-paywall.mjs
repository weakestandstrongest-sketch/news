// 有料・会員限定記事の見分け方の確認用（一時的）
import { readFileSync } from 'node:fs';
import { parseFeed } from './lib/feed-parser.mjs';
const UA = { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const get = async (u) => { const r = await fetch(u, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(r.status); return r.text(); };
const cfg = JSON.parse(readFileSync('feeds.json', 'utf8'));
const feeds = new Map();
for (const c of cfg.categories) for (const f of c.feeds) if (!feeds.has(f.url) && !f.url.includes('youtube')) feeds.set(f.url, f.source);
const MARKERS = ['有料記事', '有料会員', '会員限定', '会員記事', 'プレミアム', '購読者限定', 'この記事は', '続きを読むには', 'ログインして', 'paywall', 'isPaid', 'premium'];
for (const [url, source] of feeds) {
  let items;
  try { items = parseFeed(await get(url)).slice(0, 12); } catch (e) { console.log(`PW ${source} FEED ERR ${e.message}`); continue; }
  const rows = await Promise.all(items.map(async (it) => {
    try {
      const html = await get(it.url);
      const ld = [...html.matchAll(/"isAccessibleForFree"\s*:\s*"?(true|false|False|True)"?/g)].map((m) => m[1].toLowerCase());
      const marks = MARKERS.filter((m) => html.includes(m));
      // マーカー前後の文字（どんな文脈で出てくるか）
      const ctx = ['有料記事', '有料会員', '会員限定', '会員記事'].map((m) => { const i = html.indexOf(m); return i >= 0 ? html.slice(Math.max(0, i - 60), i + 40).replace(/\s+/g, ' ') : null; }).filter(Boolean).slice(0, 2);
      return { title: it.title.slice(0, 40), ld: ld.join('/') || '-', marks, ctx, size: html.length };
    } catch (e) { return { title: it.title.slice(0, 40), err: e.message }; }
  }));
  const ok = rows.filter((r) => !r.err);
  const ldFalse = ok.filter((r) => r.ld.includes('false')).length;
  const ldTrue = ok.filter((r) => r.ld.includes('true') && !r.ld.includes('false')).length;
  const count = (m) => ok.filter((r) => r.marks.includes(m)).length;
  console.log(`PW ${source} ${url}\n   取得 ${ok.length}/${rows.length}  LD:false=${ldFalse} LD:true=${ldTrue}  ${MARKERS.map((m) => `${m}=${count(m)}`).join(' ')}`);
  for (const r of ok.filter((r) => r.ld.includes('false') || r.ctx.length).slice(0, 4)) console.log(`   ・[${r.ld}] ${r.title}  ${r.ctx.map((c) => `「…${c}…」`).join(' ')}`);
}
