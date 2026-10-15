// 有料・会員限定記事の見分け方の確認用（一時的・2）：判定に使えそうな箇所の値を記事ごとに比べる
import { parseFeed } from './lib/feed-parser.mjs';
const BOT = { 'User-Agent': 'Mozilla/5.0 (compatible; PersonalNewsReader/1.0)' };
const get = async (u, h = BOT) => { const r = await fetch(u, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(12000) }); if (!r.ok) throw new Error(r.status); return r.text(); };
const targets = [
  ['朝日新聞', 'https://www.asahi.com/rss/asahi/newsheadlines.rdf', [/isPaid[^,}]{0,40}/g, /"[a-zA-Z]*(?:[Pp]aid|[Pp]aywall|[Ll]ocked|[Mm]ember)[a-zA-Z]*"\s*:\s*[^,}]{1,20}/g, />有料記事</g]],
  ['毎日新聞', 'https://mainichi.jp/rss/etc/mainichi-flash.rss', [/有料記事判別 -->\s*<meta[^>]+>/g, /cXenseParse:mai-[a-z-]+" content="[^"]*"/g]],
  ['産経新聞', 'https://www.sankei.com/arc/outboundfeeds/rss/?outputType=xml', [/isAccessibleForFree[^,}]{0,20}/g, /有料会員[^<]{0,30}/g, /"[a-zA-Z_]*(?:paid|premium|paywall|subscri)[a-zA-Z_]*"\s*:\s*[^,}]{1,20}/gi]],
  ['ダイヤモンド', 'https://diamond.jp/list/feed/rss/dol', [/<[^>]*(?:premium|Premium)[^>]*>[^<]{0,30}/g, /有料会員限定[^<'"]{0,20}/g, /isAccessibleForFree[^,}]{0,20}/g]],
  ['プレジデント', 'https://president.jp/list/rss', [/<[^>]*(?:member|premium|paid)[^>]*>[^<]{0,30}/gi, /isAccessibleForFree[^,}]{0,20}/g]],
  ['Business Insider', 'https://www.businessinsider.jp/feed/index.xml', [/<[^>]*(?:premium|paid|paywall)[^>]*>[^<]{0,30}/gi, /isAccessibleForFree[^,}]{0,20}/g]],
  ['東洋経済', 'https://toyokeizai.net/list/feed/rss', [/isAccessibleForFree[^,}]{0,20}/g, /<[^>]*(?:premium|member-only|paid)[^>]*>[^<]{0,30}/gi]],
];
for (const [name, url, patterns] of targets) {
  let items;
  try { items = parseFeed(await get(url)).slice(0, 15); } catch (e) { console.log(`PW2 ${name} FEED ERR ${e.message}`); continue; }
  const per = await Promise.all(items.map(async (it) => {
    try {
      const html = await get(it.url);
      const hits = patterns.map((re) => [...new Set([...html.matchAll(re)].map((m) => m[0].replace(/\s+/g, ' ').replace(/\d{6,}/g, '#').slice(0, 110)))]);
      return { title: it.title.slice(0, 28), hits };
    } catch (e) { return { title: it.title.slice(0, 28), err: e.message }; }
  }));
  console.log(`PW2 ==== ${name}（${per.filter((p) => !p.err).length}/${per.length} 取得${per.find((p) => p.err) ? `、エラー例 ${per.find((p) => p.err).err}` : ''}）`);
  // パターンごとに、記事によって値が違うものを表示
  patterns.forEach((re, k) => {
    const counts = new Map();
    for (const p of per.filter((p) => !p.err)) for (const h of p.hits[k]) counts.set(h, (counts.get(h) || 0) + 1);
    const n = per.filter((p) => !p.err).length;
    const varying = [...counts.entries()].filter(([, c]) => c < n).slice(0, 8);
    console.log(`PW2   パターン${k + 1}: 全記事共通 ${[...counts.values()].filter((c) => c === n).length} 種 / 記事により異なる ${varying.length} 種`);
    for (const [h, c] of varying) console.log(`PW2     ${c}/${n}件: ${h}`);
  });
  for (const p of per.filter((p) => !p.err).slice(0, 15)) console.log(`PW2   ・${p.title} → ${p.hits.map((h) => h.length).join(',')}`);
}
