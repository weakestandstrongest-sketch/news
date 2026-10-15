// 本のデータ取得先の確認用（一時的）：記事ページから ISBN を拾って openBD で引けるか
import { parseFeed } from './lib/feed-parser.mjs';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsReader/1.0)' };
const get = async (u) => { const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(r.status); return r.text(); };
const feeds = {
  'ほんのひきだし': 'https://hon-hikidashi.jp/feed/',
  'ダイヤモンド': 'https://diamond.jp/list/feed/rss/dol',
  '東洋経済': 'https://toyokeizai.net/list/feed/rss',
  'プレジデント': 'https://president.jp/list/rss',
  '現代ビジネス': 'https://gendai.media/list/feed/rss',
};
const isbn10to13 = (s) => { const b = '978' + s.slice(0, 9); let sum = 0; for (let i = 0; i < 12; i++) sum += +b[i] * (i % 2 ? 3 : 1); return b + ((10 - (sum % 10)) % 10); };
const found = new Map();
for (const [name, url] of Object.entries(feeds)) {
  const items = parseFeed(await get(url)).slice(0, 20);
  let hits = 0;
  await Promise.all(items.map(async (it) => {
    try {
      const html = await get(it.url);
      const set = new Set();
      for (const m of html.matchAll(/97[89][-‐]?\d[-‐\d]{9,13}/g)) { const d = m[0].replace(/\D/g, ''); if (d.length === 13) set.add(d); }
      for (const m of html.matchAll(/amazon\.co\.jp\/(?:[^"'\s]*\/)?(?:dp|gp\/product|ASIN)\/(4\d{8}[\dX])/gi)) set.add(isbn10to13(m[1]));
      if (set.size) { hits++; for (const i of set) if (!found.has(i)) found.set(i, { from: name, title: it.title }); }
    } catch {}
  }));
  console.log(`PROBE ${name}: ${items.length} 記事中 ${hits} 記事で ISBN を発見`);
}
const isbns = [...found.keys()].slice(0, 100);
console.log(`PROBE ISBN 候補 ${found.size} 件`);
if (isbns.length) {
  const res = JSON.parse(await get(`https://api.openbd.jp/v1/get?isbn=${isbns.join(',')}`));
  let ok = 0, cover = 0;
  res.forEach((b, i) => {
    if (!b) return; ok++; if (b.summary.cover) cover++;
    const desc = b.onix?.CollateralDetail?.TextContent?.[0]?.Text || '';
    if (ok <= 12) console.log(`PROBE BOOK ${b.summary.title} / ${b.summary.author} / ${b.summary.pubdate} / cover:${!!b.summary.cover} / desc:${desc.length} ← ${found.get(isbns[i]).from}「${found.get(isbns[i]).title.slice(0, 30)}」`);
  });
  console.log(`PROBE openBD: ${ok}/${isbns.length} 件ヒット、表紙あり ${cover} 件`);
}
