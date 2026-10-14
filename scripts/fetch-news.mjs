#!/usr/bin/env node
// feeds.json に書かれた RSS を取得し、public/data/news.json を生成する
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed, decodeEntities, stripHtml } from './lib/feed-parser.mjs';
import { clusterArticles } from './lib/cluster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(process.env.NEWS_OUT || resolve(ROOT, 'public/data/news.json'));
const FEEDS = resolve(process.env.FEEDS_FILE || resolve(ROOT, 'feeds.json'));

const MAX_PER_CATEGORY = 40;
const MAX_SUMMARY = 160;
const MAX_OG_FETCH = 150;
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

async function loadFeed(feed) {
  const { text } = await fetchText(feed.url);
  return parseFeed(text).map((item) => ({ ...item, source: feed.source }));
}

function metaContent(html, prop) {
  const re = new RegExp(
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${prop}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const m = tag.match(/content\s*=\s*("([^"]*)"|'([^']*)')/i);
  return m ? decodeEntities(m[2] ?? m[3]) : null;
}

// RSS に画像や概要がない記事は、記事ページの OGP から補う
async function enrichWithOgp(articles) {
  const targets = articles.filter((a) => !a.image || a.summary.length < 20).slice(0, MAX_OG_FETCH);
  let ok = 0;
  const queue = [...targets];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      try {
        const { text, finalUrl } = await fetchText(a.url, { timeout: 8000, maxBytes: 300_000 });
        const head = text.split(/<\/head>/i)[0];
        if (!a.image) a.image = toHttps(metaContent(head, 'og:image') || metaContent(head, 'twitter:image'), finalUrl);
        if (a.summary.length < 20) {
          const desc = metaContent(head, 'og:description') || metaContent(head, 'description');
          if (desc) a.summary = truncate(stripHtml(desc), MAX_SUMMARY);
        }
        ok++;
      } catch {
        // 取れなければそのまま
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`OGP: ${ok}/${targets.length} 件を補完`);
}

async function main() {
  const config = JSON.parse(await readFile(FEEDS, 'utf8'));
  const failed = [];
  const categories = [];

  for (const cat of config.categories) {
    const results = await Promise.allSettled(cat.feeds.map(loadFeed));
    const items = [];
    results.forEach((r, i) => {
      const feed = cat.feeds[i];
      if (r.status === 'fulfilled') {
        console.log(`✓ [${cat.label}] ${feed.source}: ${r.value.length} 件`);
        items.push(...r.value);
      } else {
        console.warn(`✗ [${cat.label}] ${feed.source} (${feed.url}): ${r.reason?.message}`);
        failed.push(feed.url);
      }
    });

    const seenUrl = new Set();
    const seenTitle = new Set();
    const articles = [];
    for (const item of items) {
      const url = normalizeUrl(item.url);
      const tkey = titleKey(item.title);
      if (seenUrl.has(url) || seenTitle.has(tkey)) continue;
      seenUrl.add(url);
      seenTitle.add(tkey);
      articles.push({
        id: articleId(url),
        title: item.title,
        url,
        source: item.source,
        publishedAt: item.publishedAt,
        summary: truncate(item.summary, MAX_SUMMARY),
        image: toHttps(item.image, url),
        ...(item.score != null && { score: item.score }),
      });
    }

    if (cat.sort === 'score') {
      articles.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else {
      // 日付のない記事は末尾へ（フィード内の順序は維持）
      articles.sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0));
    }

    categories.push({ id: cat.id, label: cat.label, articles: articles.slice(0, MAX_PER_CATEGORY) });
  }

  // 同じ記事が複数カテゴリにある場合も OGP 取得は一度だけにする
  const unique = new Map();
  for (const c of categories) for (const a of c.articles) if (!unique.has(a.id)) unique.set(a.id, a);
  await enrichWithOgp([...unique.values()]);
  for (const c of categories) c.articles = c.articles.map((a) => unique.get(a.id));

  const total = unique.size;
  if (total === 0) {
    console.error('記事を 1 件も取得できなかったため、出力を中止します');
    process.exit(1);
  }

  // 複数のメディアが報じている同じ話題をまとめる
  const topics = clusterArticles([...unique.values()]);
  for (const t of topics) for (const id of t.articleIds) unique.get(id).topic = t.id;
  topics.sort((a, b) => b.sources.length - a.sources.length || Date.parse(b.latest || 0) - Date.parse(a.latest || 0));
  console.log(`\n話題: ${topics.length} 件（2 件以上の記事をまとめたもの）`);
  for (const t of topics.slice(0, 15)) {
    console.log(`  ${t.sources.length}社 ${t.articleIds.length}件  ${unique.get(t.articleIds[0]).title}  [${t.sources.join(' / ')}]`);
  }

  const data = { generatedAt: new Date().toISOString(), categories, topics };
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(data));
  console.log(`\n${total} 件の記事を書き出しました → ${OUT}` + (failed.length ? `（失敗したフィード: ${failed.length}）` : ''));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
