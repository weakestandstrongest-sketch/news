#!/usr/bin/env node
// feeds.json に書かれた RSS を取得し、public/data/news.json を生成する
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed, decodeEntities, stripHtml, cleanTitle } from './lib/feed-parser.mjs';
import { clusterArticles } from './lib/cluster.mjs';
import { buildBooks } from './lib/books.mjs';
import { detectAccess } from './lib/paywall.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.NEWS_OUT || resolve(ROOT, 'public/data/news.json'));
const FEEDS = resolve(process.env.FEEDS_FILE || resolve(ROOT, 'feeds.json'));

const MAX_PER_CATEGORY = 40;
const MAX_SUMMARY = 160;
const MAX_PAGE_FETCH = 400;
const UA = 'Mozilla/5.0 (compatible; PersonalNewsReader/1.0)';

async function fetchText(url, { timeout = 15000, maxBytes = Infinity } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  // OGP 取得時は <head> だけ読めれば十分なので途中で打ち切る
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const bytes = Buffer.concat(chunks);
  return { text: decode(bytes, res.headers.get('content-type')), finalUrl: res.url };
}

// Shift_JIS や EUC-JP のサイトもあるので、ヘッダーや宣言から文字コードを判定する
function decode(bytes, contentType) {
  const head = bytes.subarray(0, 2048).toString('latin1');
  const charset = (
    contentType?.match(/charset=["']?([\w-]+)/i)?.[1] ||
    head.match(/<\?xml[^>]+encoding=["']([\w-]+)/i)?.[1] ||
    head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1] ||
    'utf-8'
  ).toLowerCase();
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid)/i.test(key)) u.searchParams.delete(key);
    }
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

function toHttps(url, base) {
  if (!url) return null;
  try {
    const u = new URL(url, base);
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function titleKey(title) {
  return title.replace(/[\s　「」『』【】（）()［］\[\]、。・:：!！?？…"'“”]/g, '').toLowerCase();
}

function articleId(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

// はてなブックマークのような「他サイトの記事を紹介するフィード」では、実際の掲載元の名前を使う
const SITE_NAMES = {
  'nhk.or.jp': 'NHK', 'web.nhk': 'NHK', 'asahi.com': '朝日新聞', 'mainichi.jp': '毎日新聞',
  'yomiuri.co.jp': '読売新聞', 'nikkei.com': '日本経済新聞', 'sankei.com': '産経新聞', 'jiji.com': '時事通信',
  'kyodonews.jp': '共同通信', '47news.jp': '47NEWS', 'tokyo-np.co.jp': '東京新聞', 'bunshun.jp': '文春オンライン',
  'toyokeizai.net': '東洋経済オンライン', 'diamond.jp': 'ダイヤモンド・オンライン', 'itmedia.co.jp': 'ITmedia',
  'impress.co.jp': 'Impress Watch', 'gizmodo.jp': 'GIZMODO', 'bbc.com': 'BBCニュース', 'cnn.co.jp': 'CNN.co.jp',
  'yahoo.co.jp': 'Yahoo!ニュース', 'gigazine.net': 'GIGAZINE', 'publickey1.jp': 'Publickey',
  'huffingtonpost.jp': 'ハフポスト', 'businessinsider.jp': 'Business Insider', 'nikkansports.com': '日刊スポーツ',
  'president.jp': 'プレジデント', 'gendai.media': '現代ビジネス', 'newsweekjapan.jp': 'ニューズウィーク日本版',
  'note.com': 'note', 'zenn.dev': 'Zenn', 'qiita.com': 'Qiita', 'github.com': 'GitHub', 'hatenablog.com': 'はてなブログ',
  'youtube.com': 'YouTube', 'x.com': 'X', 'twitter.com': 'X',
};

function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const key = Object.keys(SITE_NAMES).find((d) => host === d || host.endsWith(`.${d}`));
    return key ? SITE_NAMES[key] : host;
  } catch {
    return null;
  }
}

// 相対リンクや「null/article/…」のような壊れたリンク（産経新聞の RSS など）を、フィードのサイトを基準に直す
function absoluteUrl(link, base) {
  try {
    return new URL(link.replace(/^(null|undefined)\//, '/'), base).href;
  } catch {
    return link;
  }
}

async function loadFeed(feed) {
  let text;
  try {
    ({ text } = await fetchText(feed.url));
  } catch {
    // YouTube などは一時的に 404/500 を返すことがあるので、少し待って一度だけやり直す
    await new Promise((r) => setTimeout(r, 2000));
    ({ text } = await fetchText(feed.url));
  }
  return parseFeed(text).map((item) => {
    const url = absoluteUrl(item.url, feed.url);
    return { ...item, url, source: (feed.aggregator && siteName(url)) || feed.source };
  });
}

function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const m = tag.match(/content\s*=\s*("([^"]*)"|'([^']*)')/i);
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

// 記事ページを見て、RSS にない画像・概要を OGP から補い、有料・会員限定かを判定する。
// 前回の公開データで確認済みの記事は、その結果を使い回して配信元への負荷を抑える
async function inspectArticles(articles, previous) {
  const prev = new Map();
  for (const c of previous?.categories || []) for (const a of c.articles) if (a.checked) prev.set(a.id, a);

  const targets = [];
  let reused = 0;
  for (const a of articles) {
    const p = prev.get(a.id);
    if (p) {
      if (!a.image && p.image) a.image = p.image;
      if (a.summary.length < 20 && p.summary) a.summary = p.summary;
      if (p.access) a.access = p.access;
      a.checked = true;
      reused++;
    } else {
      targets.push(a);
    }
  }

  let ok = 0;
  const queue = targets.slice(0, MAX_PAGE_FETCH);
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      try {
        const { text, finalUrl } = await fetchText(a.url, { timeout: 8000, maxBytes: 600_000 });
        const head = text.split(/<\/head>/i)[0];
        if (!a.image) a.image = toHttps(metaContent(head, 'og:image') || metaContent(head, 'twitter:image'), finalUrl);
        if (a.summary.length < 20) {
          const desc = metaContent(head, 'og:description') || metaContent(head, 'description');
          if (desc) a.summary = truncate(stripHtml(desc), MAX_SUMMARY);
        }
        const access = detectAccess(text, finalUrl || a.url);
        if (access) a.access = access;
        a.checked = true;
        ok++;
      } catch {
        // 取れなければ次回また確認する
      }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  const restricted = articles.filter((a) => a.access).length;
  console.log(`記事ページ: 新しく ${ok}/${targets.length} 件を確認、${reused} 件は前回の結果を利用（有料・会員限定 ${restricted} 件）`);
  for (const a of articles.filter((x) => x.access).slice(0, 12)) console.log(`  [${a.access === 'paid' ? '有料' : '会員限定'}] ${a.source}「${a.title.slice(0, 40)}」`);
}

// 前回公開したデータ（1 日以内のもの）。GitHub Actions では PREVIOUS_DATA_URL に公開先の URL が入る
async function loadPrevious() {
  const url = process.env.PREVIOUS_DATA_URL;
  if (!url) return null;
  try {
    const data = JSON.parse((await fetchText(url, { timeout: 10000 })).text);
    if (Date.now() - Date.parse(data.generatedAt) > 24 * 3600_000 || data.sample) return null;
    return data;
  } catch (err) {
    console.warn(`前回のデータを読めませんでした: ${err.message}`);
    return null;
  }
}

function toArticle(item) {
  const url = normalizeUrl(item.url);
  return {
    id: articleId(url),
    title: cleanTitle(item.title),
    url,
    source: item.source,
    publishedAt: item.publishedAt,
    summary: truncate(item.summary, MAX_SUMMARY),
    image: toHttps(item.image, url),
    ...(item.score != null && { score: item.score }),
  };
}

async function main() {
  const config = JSON.parse(await readFile(FEEDS, 'utf8'));
  const failed = [];
  // 風刺サイトなど、ニュースとして扱わないサイト（feeds.json の excludeDomains）
  const excluded = (url) => {
    try {
      const host = new URL(url).hostname;
      return (config.excludeDomains || []).some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };
  // 1. 各カテゴリのフィードを取得
  const feedArticles = new Map();
  for (const cat of config.categories) {
    const results = await Promise.allSettled((cat.feeds || []).map(loadFeed));
    const items = [];
    results.forEach((r, i) => {
      const feed = cat.feeds[i];
      if (r.status === 'fulfilled') {
        console.log(`✓ [${cat.label}] ${feed.source}: ${r.value.length} 件`);
        items.push(...r.value.filter((item) => !excluded(item.url)));
      } else {
        console.warn(`✗ [${cat.label}] ${feed.source} (${feed.url}): ${r.reason?.message}`);
        failed.push(feed.url);
      }
    });
    feedArticles.set(cat.id, items.map(toArticle));
  }

  // 取得に失敗したフィードがあるカテゴリは、前回公開したデータの記事で補う（公開中の news.json を読む）
  const previous = await loadPrevious();
  for (const cat of config.categories) {
    const failedHere = (cat.feeds || []).filter((f) => failed.includes(f.url));
    const prev = previous?.categories.find((c) => c.id === cat.id);
    if (!failedHere.length || !prev) continue;
    const sources = new Set(failedHere.map((f) => f.source));
    const reused = prev.articles.filter((a) => sources.has(a.source)).map(({ topic, ...a }) => a);
    if (reused.length) {
      feedArticles.get(cat.id).push(...reused);
      console.log(`  [${cat.label}] 前回のデータから ${reused.length} 件を補完`);
    }
  }

  // 2. キーワードを指定したカテゴリは、取得した全記事から見出しが合うものも集める
  //    （「決算」「学生・就活」のように専用の RSS がない分野のため）
  const pool = [...feedArticles.values()].flat();
  const categories = [];
  for (const cat of config.categories) {
    const keywords = (cat.keywords || []).map((k) => k.toLowerCase());
    const matched = keywords.length ? pool.filter((a) => keywords.some((k) => a.title.toLowerCase().includes(k))) : [];
    if (keywords.length) console.log(`  [${cat.label}] キーワードに合う記事: ${matched.length} 件`);

    const seenUrl = new Set();
    const seenTitle = new Set();
    const articles = [];
    for (const a of [...feedArticles.get(cat.id), ...matched]) {
      const tkey = titleKey(a.title);
      if (seenUrl.has(a.url) || seenTitle.has(tkey)) continue;
      seenUrl.add(a.url);
      seenTitle.add(tkey);
      articles.push(a);
    }

    if (cat.sort === 'score') {
      articles.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else {
      // 日付のない記事は末尾へ（フィード内の順序は維持）
      articles.sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0));
    }

    categories.push({
      id: cat.id,
      label: cat.label,
      ...(cat.type && { type: cat.type }),
      ...(cat.visible === false && { visible: false }),
      articles: articles.slice(0, MAX_PER_CATEGORY),
    });
  }

  // 同じ記事が複数カテゴリにある場合も OGP 取得は一度だけにする
  const unique = new Map();
  for (const c of categories) for (const a of c.articles) if (!unique.has(a.id)) unique.set(a.id, a);
  await inspectArticles([...unique.values()], previous);
  for (const c of categories) c.articles = c.articles.map((a) => unique.get(a.id));

  const total = unique.size;
  if (total === 0) {
    console.error('記事を 1 件も取得できなかったため、出力を中止します');
    process.exit(1);
  }

  // 複数のメディアが報じている同じ話題をまとめる
  // 「ニュースライブ」のような番組全体の動画は、特定の出来事ではないのでまとめない
  const GENERIC = /ニュースライブ|ライブ配信|LIVE|ダイジェスト|【まとめ】/i;
  const topics = clusterArticles([...unique.values()].filter((a) => !GENERIC.test(a.title)));
  for (const t of topics) for (const id of t.articleIds) unique.get(id).topic = t.id;
  topics.sort((a, b) => b.sources.length - a.sources.length || Date.parse(b.latest || 0) - Date.parse(a.latest || 0));
  console.log(`\n話題: ${topics.length} 件（2 件以上の記事をまとめたもの）`);
  for (const t of topics.slice(0, 15)) {
    console.log(`  ${t.sources.length}社 ${t.articleIds.length}件  ${unique.get(t.articleIds[0]).title}  [${t.sources.join(' / ')}]`);
  }

  // 本タブの「今日の一冊」
  let books = null;
  if (config.bookSources?.length) {
    try {
      books = await buildBooks(pool, { sources: config.bookSources, fetchText, metaContent, previous });
    } catch (err) {
      console.warn(`今日の一冊を作れませんでした: ${err.message}`);
      books = previous?.books || null;
    }
  }

  const data = { generatedAt: new Date().toISOString(), categories, topics, ...(books && { books }) };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  console.log(`\n${total} 件の記事を書き出しました → ${OUT}` + (failed.length ? `（失敗したフィード: ${failed.length}）` : ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
