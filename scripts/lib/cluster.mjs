// 似た記事を「話題」にまとめる（文字 2-gram の TF-IDF ＋ コサイン類似度）
// 日本語は単語の区切りがないため、形態素解析の代わりに 2 文字ずつの組み合わせで比べる

const DEFAULTS = {
  // 同じメディアの記事同士は、別の出来事でも見出しの型が似やすい（「CSファイナルステージ 第1戦は…」など）。
  // そのため、主に「他のメディアの記事とどれだけ似ているか」で同じ話題かを判断する
  threshold: 0.26, // 他メディアの記事との平均類似度がこれ以上なら同じ話題（実データで調整）
  sameSourceThreshold: 0.75, // 同じメディアの記事しかない話題には、ほぼ同じ見出しのときだけ加える
  windowHours: 36, // これより時間が離れた記事はまとめない
  summaryChars: 80, // 概要は冒頭だけ使う（後半は話題が広がりやすい）
  summaryWeight: 0.5,
};

// 見出しの比較に邪魔な部分（【速報】やサイト名の後付けなど）を落とす
export function normalizeTitle(title) {
  let t = title.normalize('NFKC');
  t = t.replace(/【[^】]*】|\[[^\]]*\]|〔[^〕]*〕/g, ' ');
  // 「見出し | サイト名」「見出し - サイト名」の後ろ側を除く
  t = t.replace(/\s+[|｜\-–—]\s+[^|｜\-–—]{1,24}$/, '');
  t = t.replace(/[（(][^）)]{1,12}(新聞|通信|ニュース|NEWS|news)[）)]\s*$/, '');
  t = t.replace(/[：:][^：:]{1,14}(新聞|通信|ニュース|NEWS|オンライン)\s*$/, '');
  return t;
}

function compact(text) {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');
}

function bigrams(text) {
  const s = compact(text);
  const grams = [];
  for (let i = 0; i < s.length - 1; i++) grams.push(s.slice(i, i + 2));
  return grams;
}

function termCounts(article, opts) {
  const tf = new Map();
  const add = (g, w) => tf.set(g, (tf.get(g) || 0) + w);
  for (const g of bigrams(normalizeTitle(article.title))) add(g, 1);
  for (const g of bigrams((article.summary || '').slice(0, opts.summaryChars))) add(g, opts.summaryWeight);
  return tf;
}

function norm(vec) {
  let s = 0;
  for (const v of vec.values()) s += v * v;
  return Math.sqrt(s);
}

function cosine(a, aNorm, b, bNorm) {
  if (!aNorm || !bNorm) return 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [k, v] of small) {
    const w = large.get(k);
    if (w) dot += v * w;
  }
  return dot / (aNorm * bNorm);
}

/**
 * @param {Array<{id, title, summary, source, publishedAt}>} articles 重複のない記事一覧
 * @returns {Array<{id, articleIds: string[], sources: string[], latest: string|null}>} 2 件以上の記事を含む話題
 */
export function clusterArticles(articles, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const tfs = articles.map((a) => termCounts(a, opts));

  // IDF: どの記事にも出てくる「した」「する」のような組は重みを下げる
  const df = new Map();
  for (const tf of tfs) for (const g of tf.keys()) df.set(g, (df.get(g) || 0) + 1);
  const n = articles.length;
  const vecs = tfs.map((tf) => {
    const v = new Map();
    for (const [g, c] of tf) v.set(g, c * Math.log(1 + n / df.get(g)));
    return v;
  });

  const time = (a) => (a.publishedAt ? Date.parse(a.publishedAt) : null);
  const order = articles.map((_, i) => i).sort((i, j) => (time(articles[i]) ?? 0) - (time(articles[j]) ?? 0));
  const windowMs = opts.windowHours * 3600_000;

  const norms = vecs.map(norm);
  const sim = (i, j) => cosine(vecs[i], norms[i], vecs[j], norms[j]);

  const clusters = [];
  for (const i of order) {
    const t = time(articles[i]);
    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      if (t != null && c.latest != null && Math.abs(t - c.latest) > windowMs) continue;
      const others = c.members.filter((j) => articles[j].source !== articles[i].source);
      let score;
      if (others.length) {
        score = others.reduce((sum, j) => sum + sim(i, j), 0) / others.length;
        if (score < opts.threshold) continue;
      } else {
        score = Math.max(...c.members.map((j) => sim(i, j)));
        if (score < opts.sameSourceThreshold) continue;
      }
      if (score > bestScore) {
        best = c;
        bestScore = score;
      }
    }
    if (best) {
      best.members.push(i);
      if (t != null) best.latest = Math.max(best.latest ?? t, t);
    } else {
      clusters.push({ members: [i], latest: t });
    }
  }

  return clusters
    .filter((c) => c.members.length > 1)
    .map((c) => {
      const members = c.members.map((i) => articles[i]);
      return {
        id: `t-${members[0].id}`,
        articleIds: members.map((a) => a.id),
        sources: [...new Set(members.map((a) => a.source))],
        latest: c.latest != null ? new Date(c.latest).toISOString() : null,
      };
    });
}
