// 本タブの「今日の一冊」を作る
// 1. ビジネス系メディアの記事ページから ISBN を拾う（書籍の抜粋・紹介記事が多いため）
// 2. openBD で書名・著者・出版社を、版元ドットコムの書誌ページで表紙と内容紹介を取る
// 3. 日付ごとに 1 冊を選ぶ（同じ日のうちは前回と同じ本を表示し続ける）

const MAX_ARTICLES = 60;
const MAX_CANDIDATES = 16;

function isbn10to13(s) {
  const base = '978' + s.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +base[i] * (i % 2 ? 3 : 1);
  return base + ((10 - (sum % 10)) % 10);
}

function validIsbn13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +s[i] * (i % 2 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +s[12];
}

export function findIsbns(html) {
  const set = new Set();
  for (const m of html.matchAll(/97[89][-‐]?\d[-‐\d]{9,13}/g)) {
    const d = m[0].replace(/\D/g, '');
    if (validIsbn13(d)) set.add(d);
  }
  for (const m of html.matchAll(/amazon\.co\.jp\/(?:[^"'\s<>]*\/)?(?:dp|gp\/product|ASIN)\/(4\d{8}[\dX])/gi)) {
    set.add(isbn10to13(m[1]));
  }
  return set;
}

// 図書館式の「木下,勝寿,1968-」を「木下勝寿」のように読みやすくする
export function cleanAuthor(author = '') {
  return author
    .split(/\s+/)
    .map((name) => name.replace(/,\s*\d{4}-(\d{4})?/g, '').replace(/,/g, ''))
    .filter(Boolean)
    .join('、');
}

function jstDate(d = new Date()) {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function hashString(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * @param {Array} articles 取得済みの記事（source で絞り込む）
 * @param {{ sources: string[], fetchText: Function, metaContent: Function, previous: object|null }} opts
 */
export async function buildBooks(articles, { sources, fetchText, metaContent, previous }) {
  const targets = articles.filter((a) => sources.includes(a.source)).slice(0, MAX_ARTICLES);

  // 記事ごとに ISBN を集める
  const perArticle = [];
  const queue = [...targets];
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const a = queue.shift();
      try {
        const { text } = await fetchText(a.url, { timeout: 10000, maxBytes: 600_000 });
        perArticle.push({ article: a, isbns: findIsbns(text) });
      } catch {}
    }
  }));

  // 同じサイトの多くの記事に出てくる ISBN はサイドバーの広告とみなし、後回しにする
  const bySource = new Map();
  for (const { article, isbns } of perArticle) {
    const s = bySource.get(article.source) || { pages: 0, count: new Map() };
    s.pages++;
    for (const i of isbns) s.count.set(i, (s.count.get(i) || 0) + 1);
    bySource.set(article.source, s);
  }
  const candidates = new Map(); // isbn -> { from, specific }
  for (const { article, isbns } of perArticle) {
    const s = bySource.get(article.source);
    for (const i of isbns) {
      const specific = s.count.get(i) <= Math.max(2, s.pages * 0.2);
      const cur = candidates.get(i);
      if (!cur || (specific && !cur.specific)) candidates.set(i, { from: specific ? article : null, specific });
    }
  }
  const ordered = [...candidates.entries()].sort((a, b) => b[1].specific - a[1].specific).slice(0, 80);
  if (!ordered.length) return previous?.books || null;

  // openBD で書誌情報（書名・著者・出版社）
  const isbns = ordered.map(([i]) => i);
  let openbd = [];
  try {
    openbd = JSON.parse((await fetchText(`https://api.openbd.jp/v1/get?isbn=${isbns.join(',')}`, { timeout: 15000 })).text);
  } catch (err) {
    console.warn(`openBD を読めませんでした: ${err.message}`);
  }

  const books = [];
  for (let k = 0; k < isbns.length && books.length < MAX_CANDIDATES; k++) {
    const summary = openbd[k]?.summary;
    if (!summary?.title || /コミック|COMIC/i.test(summary.title)) continue;
    const isbn = isbns[k];
    const url = `https://www.hanmoto.com/bd/isbn/${isbn}`;
    let cover = null;
    let description = '';
    try {
      const { text } = await fetchText(url, { timeout: 10000, maxBytes: 300_000 });
      cover = metaContent(text, 'og:image');
      description = (metaContent(text, 'og:description') || '').replace(/\s*-\s*引用：版元ドットコム\s*$/, '').trim();
    } catch {}
    if (!cover) continue;
    const { from } = candidates.get(isbn);
    books.push({
      id: `book-${isbn}`,
      title: summary.title.replace(/\s+/g, ' ').replace(/\s*:\s*/g, '　').trim(),
      url,
      source: '版元ドットコム',
      publishedAt: null,
      summary: description.length > 200 ? description.slice(0, 199) + '…' : description,
      image: cover,
      book: {
        isbn,
        author: cleanAuthor(summary.author),
        publisher: summary.publisher || '',
        pubdate: summary.pubdate ? summary.pubdate.replace(/^(\d{4})-?(\d{2}).*/, '$1/$2') : '',
        ...(from && { from: { id: from.id, title: from.title, url: from.url, source: from.source } }),
      },
    });
  }
  console.log(`本: 記事 ${perArticle.length} 件から ISBN ${candidates.size} 件 → 表紙付きの本 ${books.length} 冊`);
  if (!books.length) return previous?.books || null;

  // 今日の一冊：同じ日のうちは前回と同じ本。日付が変わったら、紹介記事のある本から日付で選ぶ
  const today = jstDate();
  let pick = previous?.books?.date === today ? previous.books.today : null;
  if (!pick) {
    const pool = books.filter((b) => b.book.from && b.summary);
    const from = pool.length ? pool : books;
    pick = from[hashString(today) % from.length];
  }
  const shelf = books.filter((b) => b.id !== pick.id).slice(0, 12);
  console.log(`  今日の一冊: ${pick.title}（${pick.book.author}）${pick.book.from ? ` ← ${pick.book.from.source}「${pick.book.from.title}」` : ''}`);
  for (const b of shelf) console.log(`  本棚: ${b.title}（${b.book.author} / ${b.book.publisher}）${b.book.from ? ' ※紹介記事あり' : ''}`);
  return { date: today, today: pick, shelf };
}
