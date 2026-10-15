// 有料記事の見分け方の確認用（一時的・3）
// 記事ごとに「有料・会員・続き」などを含む文言やクラス名を集め、一部の記事にだけ出てくるものを探す
import { parseFeed } from './lib/feed-parser.mjs';
const BOT = { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsReader/1.0)' };
const get = async (u) => { const r = await fetch(u, { headers: BOT, redirect: 'follow', signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(r.status); return { html: await r.text(), url: r.url }; };
const sites = [
  ['毎日新聞', ['https://mainichi.jp/rss/etc/mainichi-flash.rss', 'https://mainichi.jp/rss/etc/mainichi-sougou.rss']],
  ['ダイヤモンド', ['https://diamond.jp/list/feed/rss/dol']],
  ['プレジデント', ['https://president.jp/list/rss']],
  ['Business Insider', ['https://www.businessinsider.jp/feed/index.xml']],
];
const KEY = /有料|会員|プレミアム|premium|Premium|PREMIUM|paid|Paid|paywall|Paywall|lock|Lock|購読|ログイン|続き|残り|全文|限定|subscri|member|Member/;
function features(html) {
  const f = new Set();
  // 画面に出る文言（タグの間のテキスト）
  for (const m of html.matchAll(/>([^<>]{2,60})</g)) { const t = m[1].replace(/\s+/g, ' ').trim(); if (KEY.test(t)) f.add('T:' + t.replace(/[\d,]+/g, '#')); }
  // クラス名・id・data 属性
  for (const m of html.matchAll(/(?:class|id|data-[\w-]+)="([^"]{2,120})"/g)) for (const c of m[1].split(/\s+/)) if (KEY.test(c)) f.add('A:' + c.replace(/[\d]+/g, '#'));
  // JSON の中のキーと値
  for (const m of html.matchAll(/"([\w-]{3,40})"\s*:\s*("[^"]{0,30}"|true|false|\d+)/g)) if (KEY.test(m[1])) f.add('J:' + m[1] + '=' + m[2].replace(/\d{4,}/g, '#'));
  return f;
}
const textLength = (html) => (html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+/g, '').length;
for (const [name, feeds] of sites) {
  const items = [];
  for (const f of feeds) { try { items.push(...parseFeed((await get(f)).html)); } catch (e) { console.log(`PW3 ${name} FEED ERR ${f} ${e.message}`); } }
  const uniq = [...new Map(items.map((i) => [i.url, i])).values()].slice(0, 40);
  const pages = [];
  const q = [...uniq];
  await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const it = q.shift(); try { const { html, url } = await get(it.url); pages.push({ title: it.title, url, f: features(html), len: textLength(html) }); } catch {} } }));
  const n = pages.length;
  const count = new Map();
  for (const p of pages) for (const x of p.f) count.set(x, (count.get(x) || 0) + 1);
  const varying = [...count.entries()].filter(([, c]) => c > 0 && c < n && c <= n * 0.8).sort((a, b) => b[1] - a[1]);
  console.log(`PW3 ==== ${name}：${n} 記事。一部の記事にだけ出る特徴 ${varying.length} 種（多い順・最大 40）`);
  for (const [x, c] of varying.slice(0, 40)) console.log(`PW3   ${c}/${n}  ${x.slice(0, 120)}`);
  // 有力そうな特徴ごとに、該当記事の本文の長さを比べる
  for (const [x] of varying.slice(0, 6)) {
    const yes = pages.filter((p) => p.f.has(x)).map((p) => p.len);
    const no = pages.filter((p) => !p.f.has(x)).map((p) => p.len);
    const avg = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : 0);
    console.log(`PW3   本文の長さ  あり:平均${avg(yes)}  なし:平均${avg(no)}  ← ${x.slice(0, 80)}`);
  }
  for (const p of pages.slice(0, 40)) console.log(`PW3   ・${p.len}字 ${p.title.slice(0, 34)} ${p.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 50)}`);
}
