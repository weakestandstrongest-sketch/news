// 依存ライブラリなしの軽量フィードパーサー（RSS 2.0 / RSS 1.0(RDF) / Atom 対応）

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', middot: '·', bull: '•', yen: '¥', copy: '©',
};

export function decodeEntities(str) {
  return str.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// タグの中身（CDATA は展開、エンティティは未デコード）を返す
function rawTag(block, name) {
  const re = new RegExp(`<${escapeRe(name)}(?:\\s[^>]*?)?(?<!/)>([\\s\\S]*?)</${escapeRe(name)}>`, 'i');
  const m = block.match(re);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function firstTag(block, names) {
  for (const name of names) {
    const v = rawTag(block, name);
    if (v != null && v.trim() !== '') return v;
  }
  return null;
}

// <tag ... attr="value"> を探す。cond で属性の条件を絞れる
function tagAttr(block, name, attr, cond) {
  const re = new RegExp(`<${escapeRe(name)}\\s([^>]*)>`, 'gi');
  for (const m of block.matchAll(re)) {
    const attrs = parseAttrs(m[1]);
    if (cond && !cond(attrs)) continue;
    if (attrs[attr]) return decodeEntities(attrs[attr]);
  }
  return null;
}

function parseAttrs(src) {
  const attrs = {};
  for (const m of src.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[m[1].toLowerCase()] = m[3] ?? m[4];
  }
  return attrs;
}

export function stripHtml(html) {
  if (!html) return '';
  // エンティティ化された HTML（&lt;p&gt; など）にも対応するため、先に一度デコードする
  let s = decodeEntities(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>|<\/p>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // 全角スペースは見出しの区切りとして使われるので残す
  return s.replace(/[^\S\u3000]+/g, ' ').trim();
}

function cleanText(raw) {
  return raw == null ? '' : stripHtml(raw);
}

function parseDate(raw) {
  if (!raw) return null;
  const d = new Date(raw.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function findImage(block, htmlBodies) {
  const isImage = (a) => !a.type || a.type.startsWith('image');
  const candidates = [
    tagAttr(block, 'media:thumbnail', 'url'),
    tagAttr(block, 'media:content', 'url', (a) => a.medium === 'image' || (a.type || '').startsWith('image')),
    tagAttr(block, 'enclosure', 'url', isImage),
    cleanText(rawTag(block, 'hatena:imageurl')),
  ];
  for (const body of htmlBodies) {
    if (!body) continue;
    const html = decodeEntities(body);
    const m = html.match(/<img[^>]+src\s*=\s*["']([^"']+)["']/i);
    if (m) candidates.push(decodeEntities(m[1]));
  }
  return candidates.find((c) => c && /^(https?:)?\/\//.test(c)) || null;
}

function parseItem(block, isAtom) {
  const title = cleanText(firstTag(block, ['title']));

  let link = null;
  if (isAtom) {
    link = tagAttr(block, 'link', 'href', (a) => !a.rel || a.rel === 'alternate');
  } else {
    link = cleanText(firstTag(block, ['link'])) || null;
    if (!link) {
      const guid = cleanText(firstTag(block, ['guid']));
      if (/^https?:\/\//.test(guid)) link = guid;
    }
    if (!link) {
      // RSS 1.0 の rdf:about
      const m = block.match(/^<item\s[^>]*rdf:about\s*=\s*["']([^"']+)["']/i);
      if (m) link = decodeEntities(m[1]);
    }
  }

  const contentHtml = firstTag(block, ['content:encoded', 'content']);
  const descHtml = firstTag(block, ['description', 'summary']);
  const summary = cleanText(descHtml) || cleanText(contentHtml);

  const date = parseDate(firstTag(block, ['pubDate', 'dc:date', 'published', 'updated', 'issued']));
  const bookmarks = parseInt(cleanText(rawTag(block, 'hatena:bookmarkcount')), 10);

  return {
    title,
    url: link ? link.trim() : null,
    summary,
    publishedAt: date,
    image: findImage(block, [contentHtml, descHtml]),
    score: Number.isFinite(bookmarks) ? bookmarks : null,
  };
}

export function parseFeed(xml) {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const tag = isAtom ? 'entry' : 'item';
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi');
  const items = [];
  for (const m of xml.matchAll(re)) {
    const item = parseItem(m[0], isAtom);
    if (item.title && item.url) items.push(item);
  }
  return items;
}

// 見出しの後ろに付いたサイト名（「 | 東洋経済オンライン」「：朝日新聞」「 - 日本経済新聞」など）を表示用に取り除く
const SITE_WORD = /(新聞|通信|ニュース|NEWS|News|オンライン|Online|ONLINE|Watch|ITmedia|日経|Yahoo|BBC|CNN|GIZMODO|Impress)/;

export function cleanTitle(title) {
  let t = title.trim();
  const parts = t.split(/\s+[|｜]\s+/);
  if (parts.length > 1 && parts[0].length >= 8 && SITE_WORD.test(parts[parts.length - 1])) t = parts[0];
  t = t.replace(/\s+[-–—]\s+([^-–—]{1,20})$/, (m, tail) => (SITE_WORD.test(tail) ? '' : m));
  t = t.replace(/[：:]\s*([^：:]{1,14})$/, (m, tail) => (SITE_WORD.test(tail) && t.length - m.length >= 8 ? '' : m));
  return t.trim();
}
