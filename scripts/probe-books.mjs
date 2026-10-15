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
const isbns = [...found.keys()].slice(0, 150);
console.log(`PROBE ISBN 候補 ${found.size} 件`);
const res = JSON.parse(await get(`https://api.openbd.jp/v1/get?isbn=${isbns.join(',')}`));
const books = [];
res.forEach((b, i) => {
  if (!b) return;
  const subj = (b.onix?.DescriptiveDetail?.Subject || []).map((x) => x.SubjectCode).join(',');
  const desc = (b.onix?.CollateralDetail?.TextContent || []).map((t) => t.Text).join(' ');
  books.push({ isbn: isbns[i], title: b.summary.title, author: b.summary.author, publisher: b.summary.publisher, pubdate: b.summary.pubdate, cover: b.summary.cover, subj, desc: desc.length, from: found.get(isbns[i]).from });
});
const nonComic = books.filter((b) => !/^C?\d?\d?79/.test(b.subj) && !/コミック/.test(b.subj));
console.log(`PROBE openBD ${books.length} 件（コミック以外 ${nonComic.length} 件）`);
for (const b of nonComic.slice(0, 25)) console.log(`PROBE BOOK ${b.isbn} ${b.title} / ${b.author} / ${b.publisher} / ${b.pubdate} / subj:${b.subj} / cover:${!!b.cover} / desc:${b.desc} ← ${b.from}`);
// 表紙の取得先の確認
for (const b of nonComic.slice(0, 5)) {
  for (const u of [`https://www.hanmoto.com/bd/isbn/${b.isbn}`, `https://cover.openbd.jp/${b.isbn}.jpg`, `https://images-na.ssl-images-amazon.com/images/P/${b.isbn.slice(3, 12)}${(() => { let s = 0; for (let i = 0; i < 9; i++) s += (10 - i) * +b.isbn[3 + i]; const c = (11 - (s % 11)) % 11; return c === 10 ? 'X' : c; })()}.09.LZZZZZZZ.jpg`]) {
    try {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(12000) });
      const ct = r.headers.get('content-type') || '';
      let extra = '';
      if (ct.includes('html')) { const h = await r.text(); extra = (h.match(/<meta[^>]+og:image[^>]+>/i) || [''])[0].slice(0, 200) + ' | ' + (h.match(/<meta[^>]+og:description[^>]+>/i) || [''])[0].slice(0, 200); }
      else extra = `${(await r.arrayBuffer()).byteLength} bytes`;
      console.log(`PROBE COVER ${r.status} ${ct} ${u} ${extra}`);
    } catch (e) { console.log(`PROBE COVER ERR ${u} ${e.message}`); }
  }
}
