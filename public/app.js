// 凪（Nagi）— 広告のない個人用ニュースリーダー
const DATA_URL = 'data/news.json';
const PREFIX = 'mynews:';
const AUTO_REFRESH_MS = 10 * 60 * 1000;
const TOP_LIMIT = 15;
const TOP_TOPICS = 8;
const MAX_READ_HISTORY = 2000;

/* ---------- 保存領域 ---------- */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
  },
};

// tabs: 表示するタブの id（並び順）。null のときは feeds.json の既定の並び
// tabsHidden: 利用者が非表示にしたタブの id（新しく追加されたタブと区別するため）
// openWith: 記事を開く方法（ask: 毎回選ぶ / nagi: 凪の中で開く / comet: Comet で開く）
const DEFAULT_SETTINGS = {
  theme: 'auto', fontSize: 'medium', images: true, dimRead: true, tabs: null, tabsHidden: [],
  openWith: 'ask', cometShortcut: 'Cometで開く', showPaid: true,
};
const FIXED_TAB = 'top'; // トップは非表示にできない

const state = {
  data: null,
  index: new Map(), // id -> { article, category }
  topics: new Map(), // id -> { id, articles, sources, latest }
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  saved: store.get('saved', {}), // id -> { article, category, savedAt, memo }
  read: new Set(store.get('read', [])),
  current: 0,
  view: 'news',
  lastFetch: 0,
  readerId: null,
  settingsPage: 'main',
};

/* ---------- DOM ---------- */
const $ = (sel) => document.querySelector(sel);
const el = {
  app: $('.app'),
  tabs: $('#tabs'),
  pager: $('#pager'),
  today: $('#today'),
  updated: $('#updated'),
  searchInput: $('#search-input'),
  searchResults: $('#search-results'),
  savedList: $('#saved-list'),
  settings: $('#settings'),
  reader: $('#reader'),
  readerBody: $('#reader-body'),
  readerSave: $('#reader-save'),
  toast: $('#toast'),
};

const ICON_EXTERNAL = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4.5h5.5V10M19.5 4.5 11 13"/><path d="M17 14v5.5H4.5V7H10"/></svg>';
const ICON_BOOKMARK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 4h11v16l-5.5-4-5.5 4z"/></svg>';
const ICON_SEARCH = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
const ICON_CLOUD = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 9.5a4.5 4.5 0 0 0 0 9z"/></svg>';

/* ---------- ユーティリティ ---------- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function safeUrl(url) {
  return /^https?:\/\//i.test(url || '') ? url : '#';
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

function relTime(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  const diff = (Date.now() - t.getTime()) / 1000;
  if (diff < 60) return 'たった今';
  if (diff < 3600) return `${Math.floor(diff / 60)}分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}時間前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}日前`;
  return `${t.getMonth() + 1}/${t.getDate()}`;
}

function fullDate(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  const hm = `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
  return `${t.getFullYear()}年${t.getMonth() + 1}月${t.getDate()}日（${WEEK[t.getDay()]}）${hm}`;
}

function hhmm(iso) {
  const t = new Date(iso);
  return `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}`;
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('is-show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('is-show'), 2000);
}

// 表示するタブと、非表示のタブ
function tabLayout() {
  const cats = state.data?.categories || [];
  const byId = new Map(cats.map((c) => [c.id, c]));
  const { tabs, tabsHidden } = state.settings;
  let visible;
  if (!tabs) {
    visible = cats.filter((c) => c.visible !== false);
  } else {
    visible = tabs.map((id) => byId.get(id)).filter(Boolean);
    // 後から増えたタブは、既定で表示するものなら末尾に足す
    for (const c of cats) {
      if (!tabs.includes(c.id) && !tabsHidden.includes(c.id) && c.visible !== false) visible.push(c);
    }
  }
  if (byId.has(FIXED_TAB) && !visible.some((c) => c.id === FIXED_TAB)) visible.unshift(byId.get(FIXED_TAB));
  if (!visible.length && cats.length) visible = [cats[0]];
  return { visible, hidden: cats.filter((c) => !visible.includes(c)) };
}

function visibleCategories() {
  return tabLayout().visible;
}

function applyTabs(ids) {
  const currentId = visibleCategories()[state.current]?.id;
  const all = (state.data?.categories || []).map((c) => c.id);
  state.settings.tabs = ids;
  state.settings.tabsHidden = all.filter((id) => !ids.includes(id));
  saveSettings();
  const i = ids.indexOf(currentId);
  state.current = i >= 0 ? i : 0;
  renderNews();
}

function lookup(id) {
  return state.index.get(id) || state.saved[id] || null;
}

/* ---------- 話題（複数メディアが報じた同じニュース） ---------- */
function topicOf(a) {
  const t = a?.topic ? state.topics.get(a.topic) : null;
  return t && t.sources.length > 1 ? t : null;
}

function sourcesText(t, max = 3) {
  const rest = t.sources.length - max;
  return t.sources.slice(0, max).join('・') + (rest > 0 ? ` ほか${rest}社` : '');
}

// 話題の代表記事：画像があり、概要が詳しいものを優先
function leadOf(t) {
  return [...t.articles].sort((a, b) =>
    (a.access ? 1 : 0) - (b.access ? 1 : 0) ||
    (b.image ? 1 : 0) - (a.image ? 1 : 0) || (b.summary?.length || 0) - (a.summary?.length || 0))[0];
}

// 同じ話題の記事は一覧に 1 回だけ出す
function collapseTopics(list, shownTopics = new Set()) {
  return list.filter((a) => {
    const t = topicOf(a);
    if (!t) return true;
    if (shownTopics.has(t.id)) return false;
    shownTopics.add(t.id);
    return true;
  });
}

// 報じたメディアが多く、新しい話題ほど上に
function rankedTopics() {
  const base = Date.parse(state.data?.generatedAt) || Date.now();
  const score = (t) => t.sources.length - (base - (Date.parse(t.latest) || base)) / 3600_000 / 8;
  return [...state.topics.values()]
    .filter((t) => t.sources.length > 1)
    .sort((a, b) => score(b) - score(a));
}

/* ---------- 記事の HTML ---------- */
// 有料・会員限定の記事（取得時に記事ページから判定した結果）
const ACCESS_LABEL = { paid: '有料', members: '会員限定' };

function visibleArticles(list) {
  return state.settings.showPaid ? list : list.filter((a) => !a.access);
}

function metaHtml(a) {
  const parts = [];
  if (a.access) parts.push(`<span class="paywall">${ACCESS_LABEL[a.access]}</span>`);
  parts.push(`<span class="source">${esc(a.source)}</span>`);
  if (a.publishedAt) parts.push(`<time datetime="${esc(a.publishedAt)}">${relTime(a.publishedAt)}</time>`);
  if (a.score) parts.push(`<span class="pick">${a.score.toLocaleString()} users</span>`);
  const t = topicOf(a);
  if (t) parts.push(`<span class="coverage">${t.sources.length}社が報道</span>`);
  if (state.saved[a.id]) parts.push('<span class="saved-mark">保存済み</span>');
  return `<div class="meta">${parts.join('')}</div>`;
}

function readClass(a) {
  return state.settings.dimRead && state.read.has(a.id) ? ' is-read' : '';
}

function imgHtml(src, cls) {
  if (!src) return '';
  return `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
}

function heroHtml(a) {
  return `<a class="hero tap${readClass(a)}" href="${esc(safeUrl(a.url))}" data-article="${a.id}">
    ${imgHtml(a.image, 'hero-img')}
    <h2 class="hero-title">${esc(a.title)}</h2>
    ${a.summary ? `<p class="hero-summary">${esc(a.summary)}</p>` : ''}
    ${metaHtml(a)}
    ${topicOf(a) ? `<p class="coverage-line">${esc(sourcesText(topicOf(a)))}が報じています</p>` : ''}
  </a>`;
}

function featureHtml(a) {
  return `<a class="feature tap${readClass(a)}" href="${esc(safeUrl(a.url))}" data-article="${a.id}">
    ${imgHtml(a.image, 'hero-img')}
    <h3 class="row-title">${esc(a.title)}</h3>
    ${metaHtml(a)}
  </a>`;
}

function rowHtml(a, { titleHtml, extra = '' } = {}) {
  return `<a class="row tap${readClass(a)}" href="${esc(safeUrl(a.url))}" data-article="${a.id}">
    <div class="row-text">
      <h3 class="row-title">${titleHtml ?? esc(a.title)}</h3>
      ${metaHtml(a)}
      ${extra}
    </div>
    ${imgHtml(a.image, 'row-thumb')}
  </a>`;
}

function headlineHtml(a) {
  return `<a class="headline tap${readClass(a)}" href="${esc(safeUrl(a.url))}" data-article="${a.id}">
    <h4 class="row-title">${esc(a.title)}</h4>
    ${metaHtml(a)}
  </a>`;
}

function emptyHtml(icon, text) {
  return `<div class="empty">${icon}<div>${text}</div></div>`;
}

/* ---------- 本：今日の一冊 ---------- */
function bookList() {
  const books = state.data?.books;
  if (!books?.today) return [];
  return [books.today, ...(books.shelf || [])];
}

function bookMeta(b) {
  return [b.book.author, b.book.pubdate].filter(Boolean).map(esc).join('・');
}

function bookTodayHtml() {
  const [today, ...shelf] = bookList();
  if (!today) return '';
  return `<section class="book-today">
    <h2 class="book-today-head">
      <svg viewBox="0 0 48 24" aria-hidden="true"><path d="M2 21 24 6l22 15M10 21l14-9 14 9M18 21l6-4 6 4"/></svg>
      今日の一冊
    </h2>
    <a class="book-today-main tap" href="${esc(safeUrl(today.url))}" data-article="${today.id}">
      ${today.image ? `<img class="book-cover" src="${esc(today.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="book-cover is-blank"></div>'}
      <div class="book-info">
        <h3 class="book-title">${esc(today.title)}</h3>
        <p class="book-meta">${bookMeta(today)}</p>
        ${today.book.publisher ? `<p class="book-meta">${esc(today.book.publisher)}</p>` : ''}
      </div>
    </a>
    ${today.summary ? `<p class="book-desc">${esc(today.summary)}</p>` : ''}
    ${today.book.from ? `<a class="book-from tap" href="${esc(safeUrl(today.book.from.url))}" data-article="${today.book.from.id}">
      <span class="cov-source">紹介記事・${esc(today.book.from.source)}</span>
      <span class="cov-head">${esc(today.book.from.title)}</span>
    </a>` : ''}
  </section>
  ${shelf.length ? `<section class="book-shelf">
    <h3 class="book-shelf-head">記事で紹介された本</h3>
    <div class="book-shelf-row">
      ${shelf.map((b) => `<a class="book-shelf-item tap" href="${esc(safeUrl(b.url))}" data-article="${b.id}">
        ${b.image ? `<img class="book-cover" src="${esc(b.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<div class="book-cover is-blank"></div>'}
        <span class="book-shelf-title">${esc(b.title)}</span>
      </a>`).join('')}
    </div>
  </section>` : ''}`;
}

/* ---------- カテゴリページ ---------- */
function categoryHtml(cat, isTop) {
  let html = cat.id === 'books' ? bookTodayHtml() : '';
  if (isTop && state.data.sample) {
    html += `<p class="notice">サンプルデータを表示しています。GitHub Actions で公開すると、実際のニュースが自動で届くようになります。</p>`;
  }
  if (!cat.articles.length) {
    return html + emptyHtml(ICON_CLOUD, 'このカテゴリの記事を取得できませんでした。<br>しばらくしてから更新してください。');
  }

  const shownTopics = new Set();
  let list;
  if (isTop) {
    list = [];
    // いちばん多くのメディアが報じている話題をトップに、続けて主な話題を並べる
    const topics = rankedTopics().slice(0, TOP_TOPICS + 1);
    if (topics.length) {
      topics.forEach((t) => shownTopics.add(t.id));
      const leads = topics.map(leadOf);
      list.push(...leads);
      html += heroHtml(leads[0]);
      if (leads.length > 1) {
        html += `<div class="section"><div class="section-head"><h3>多くのメディアが報じている話題</h3></div>
          ${leads.slice(1).map((a) => rowHtml(a)).join('')}</div>`;
      }
    }
    const latest = collapseTopics(visibleArticles(cat.articles), shownTopics).slice(0, TOP_LIMIT);
    list.push(...latest);
    if (latest.length) {
      if (topics.length) html += `<div class="section"><div class="section-head"><h3>最新のニュース</h3></div>`;
      else html += heroHtml(latest.shift());
      html += latest.map((a) => rowHtml(a)).join('');
      if (topics.length) html += '</div>';
    }
  } else {
    list = collapseTopics(visibleArticles(cat.articles), shownTopics);
    if (!list.length) return html + emptyHtml(ICON_CLOUD, '無料で読める記事はありませんでした。<br>設定で「有料・会員限定の記事も表示」をオンにすると表示されます。');
    const [first, ...rest] = list;
    html += heroHtml(first);
    rest.forEach((a, i) => {
      html += a.image && (i + 1) % 7 === 0 ? featureHtml(a) : rowHtml(a);
    });
  }

  if (isTop) {
    // 日経のトップ面のように、各カテゴリの主な見出しを並べる
    const shown = new Set(list.map((a) => a.id));
    for (const other of visibleCategories()) {
      if (other.id === cat.id || other.type === 'topics') continue;
      const picks = collapseTopics(visibleArticles(other.articles).filter((a) => !shown.has(a.id)), shownTopics).slice(0, 3);
      if (!picks.length) continue;
      picks.forEach((a) => shown.add(a.id));
      html += `<div class="section">
        <button class="section-head" data-goto="${other.id}"><h3>${esc(other.label)}</h3><span class="more">もっと見る ›</span></button>
        ${picks.map(headlineHtml).join('')}
      </div>`;
    }
  }

  html += `<p class="page-foot">${esc(cat.label)}の記事 ${cat.articles.length} 件<br>${state.data.generatedAt ? `${fullDate(state.data.generatedAt)} 時点` : ''}</p>`;
  return html;
}

// 「トピックス」タブ：複数のメディアが報じている話題を、報道の多い順に並べる
function topicsPageHtml() {
  const topics = rankedTopics();
  if (!topics.length) {
    return emptyHtml(ICON_CLOUD, '複数のメディアが報じている話題は<br>まだありません');
  }
  const cards = topics.map((t) => {
    const lead = leadOf(t);
    const others = t.articles
      .filter((a) => a.id !== lead.id)
      .sort((x, y) => (Date.parse(y.publishedAt) || 0) - (Date.parse(x.publishedAt) || 0))
      .slice(0, 3);
    return `<article class="topic-card">
      <a class="topic-lead tap${readClass(lead)}" href="${esc(safeUrl(lead.url))}" data-article="${lead.id}">
        ${imgHtml(lead.image, 'row-thumb')}
        <div class="row-text">
          <div class="topic-count">${t.sources.length}社が報道</div>
          <h3 class="row-title">${esc(lead.title)}</h3>
          ${metaHtml(lead)}
        </div>
      </a>
      ${others.map((o) => `<a class="topic-other tap${readClass(o)}" href="${esc(safeUrl(o.url))}" data-article="${o.id}">
        <span class="cov-source">${esc(o.source)}</span>
        <span class="cov-head">${esc(o.title)}</span>
      </a>`).join('')}
    </article>`;
  });
  return `<p class="page-lead">複数のメディアが報じている話題を、報道の多い順に並べています。</p>${cards.join('')}
    <p class="page-foot">話題 ${topics.length} 件</p>`;
}

function renderNews() {
  const cats = visibleCategories();
  if (state.current >= cats.length) state.current = 0;

  el.tabs.innerHTML = cats
    .map((c, i) => `<button class="tab" role="tab" data-index="${i}" aria-selected="${i === state.current}">${esc(c.label)}</button>`)
    .join('');

  el.pager.innerHTML = cats
    .map((c, i) => `<div class="page scroll" data-cat="${c.id}" role="tabpanel">
      <div class="ptr"><span></span></div>
      <div class="page-inner">${c.type === 'topics' ? topicsPageHtml() : categoryHtml(c, c.id === FIXED_TAB)}</div>
    </div>`)
    .join('');

  el.pager.querySelectorAll('.page').forEach(setupPullToRefresh);
  requestAnimationFrame(() => {
    el.pager.scrollLeft = state.current * el.pager.clientWidth;
    centerTab(state.current, false);
  });
}

function renderHeader() {
  const now = new Date();
  el.today.textContent = `${now.getMonth() + 1}月${now.getDate()}日（${WEEK[now.getDay()]}）`;
  el.updated.textContent = state.data?.generatedAt ? `${hhmm(state.data.generatedAt)} 更新` : '';
}

/* ---------- タブとページャー ---------- */
let programmaticTarget = null;
let programmaticTimer;

function centerTab(i, smooth = true) {
  const tab = el.tabs.children[i];
  if (!tab) return;
  const left = tab.offsetLeft - (el.tabs.clientWidth - tab.offsetWidth) / 2;
  el.tabs.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
}

function setActive(i) {
  if (i === state.current) return;
  state.current = i;
  [...el.tabs.children].forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
  centerTab(i);
  const cat = visibleCategories()[i];
  if (cat) store.set('lastCat', cat.id);
}

function goToCategory(i) {
  const page = el.pager.children[i];
  if (!page) return;
  if (i === state.current) {
    page.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  setActive(i);
  programmaticTarget = i;
  clearTimeout(programmaticTimer);
  programmaticTimer = setTimeout(() => (programmaticTarget = null), 800);
  el.pager.scrollTo({ left: i * el.pager.clientWidth, behavior: 'smooth' });
}

let scrollRaf = 0;
el.pager.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRaf);
  scrollRaf = requestAnimationFrame(() => {
    const w = el.pager.clientWidth || 1;
    const i = Math.round(el.pager.scrollLeft / w);
    if (programmaticTarget != null) {
      if (Math.abs(el.pager.scrollLeft - programmaticTarget * w) < 2) programmaticTarget = null;
      return;
    }
    setActive(i);
  });
}, { passive: true });

el.tabs.addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) goToCategory(Number(tab.dataset.index));
});

window.addEventListener('resize', () => {
  el.pager.scrollLeft = state.current * el.pager.clientWidth;
});

/* ---------- 引っ張って更新 ---------- */
const PTR_THRESHOLD = 60;

function setupPullToRefresh(page) {
  const ptr = page.querySelector('.ptr');
  const label = ptr.firstElementChild;
  let startX = 0, startY = null, pulling = false, dist = 0, busy = false;

  page.addEventListener('touchstart', (e) => {
    startY = !busy && page.scrollTop <= 0 ? e.touches[0].clientY : null;
    startX = e.touches[0].clientX;
    pulling = false;
    dist = 0;
  }, { passive: true });

  page.addEventListener('touchmove', (e) => {
    if (startY == null) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    if (!pulling) {
      if (dy > 10 && dy > Math.abs(dx) * 1.5 && page.scrollTop <= 0) {
        pulling = true;
        page.classList.add('is-pulling');
      } else if (Math.abs(dx) > 10 || dy < -4) {
        startY = null;
        return;
      } else {
        return;
      }
    }
    dist = Math.max(0, Math.min((dy - 10) * 0.45, 90));
    ptr.style.height = `${dist}px`;
    label.textContent = dist >= PTR_THRESHOLD ? '離して更新' : '引っ張って更新';
  }, { passive: true });

  page.addEventListener('touchend', async () => {
    if (!pulling) return;
    pulling = false;
    startY = null;
    page.classList.remove('is-pulling');
    if (dist >= PTR_THRESHOLD) {
      busy = true;
      ptr.style.height = '40px';
      label.textContent = '更新しています…';
      await refresh({ manual: true });
      busy = false;
    }
    ptr.style.height = '0';
  });
}

/* ---------- データ取得 ---------- */
function buildIndex() {
  state.index.clear();
  for (const cat of state.data.categories) {
    for (const a of cat.articles) {
      if (!state.index.has(a.id)) state.index.set(a.id, { article: a, category: cat.label });
    }
  }
  // 本（今日の一冊・記事で紹介された本）も、記事と同じように開いたり保存したりできるようにする
  for (const b of bookList()) {
    if (!state.index.has(b.id)) state.index.set(b.id, { article: b, category: '本' });
  }
  state.topics.clear();
  for (const t of state.data.topics || []) {
    const articles = t.articleIds.map((id) => state.index.get(id)?.article).filter(Boolean);
    if (articles.length > 1) state.topics.set(t.id, { ...t, articles, sources: [...new Set(articles.map((a) => a.source))] });
  }
}

async function fetchData() {
  const res = await fetch(DATA_URL, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function refresh({ manual = false } = {}) {
  try {
    const data = await fetchData();
    state.lastFetch = Date.now();
    const changed = !state.data || data.generatedAt !== state.data.generatedAt;
    if (changed) {
      state.data = data;
      buildIndex();
      renderHeader();
      renderNews();
      if (manual) toast('ニュースを更新しました');
    } else if (manual) {
      toast('最新の状態です');
    }
  } catch (err) {
    console.error(err);
    if (manual || !state.data) toast('ニュースを取得できませんでした');
    if (!state.data) {
      el.pager.innerHTML = `<div class="page scroll">${emptyHtml(ICON_CLOUD, 'ニュースを読み込めませんでした。<br>通信状況を確認して、もう一度お試しください。')}</div>`;
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderHeader();
    if (Date.now() - state.lastFetch > AUTO_REFRESH_MS) refresh();
  }
});

/* ---------- 既読・保存 ---------- */
function markRead(id) {
  if (state.read.has(id)) return;
  state.read.add(id);
  const ids = [...state.read].slice(-MAX_READ_HISTORY);
  state.read = new Set(ids);
  store.set('read', ids);
  if (state.settings.dimRead) {
    document.querySelectorAll(`[data-article="${id}"]`).forEach((n) => n.classList.add('is-read'));
  }
}

function persistSaved() {
  store.set('saved', state.saved);
}

function setSaved(id, on) {
  const entry = lookup(id);
  if (!entry) return;
  if (on) {
    state.saved[id] = { article: entry.article, category: entry.category, savedAt: Date.now(), memo: state.saved[id]?.memo || '' };
  } else {
    delete state.saved[id];
  }
  persistSaved();
  refreshMetaFor(id);
}

// 一覧に表示中の同じ記事の「保存済み」表示を更新する
function refreshMetaFor(id) {
  const entry = lookup(id);
  const article = entry?.article || state.index.get(id)?.article;
  if (!article) return;
  document.querySelectorAll(`.views [data-article="${id}"] .meta`).forEach((m) => {
    m.outerHTML = metaHtml(article);
  });
}

/* ---------- 記事詳細 ---------- */
function relatedFor(id) {
  if (!state.data) return [];
  const cat = state.data.categories.find((c) => c.articles.some((a) => a.id === id));
  if (!cat) return [];
  const own = topicOf(state.index.get(id)?.article);
  // 同じ話題の記事は「この話題を報じたメディア」に出すので除く
  const shown = new Set(own ? [own.id] : []);
  return collapseTopics(visibleArticles(cat.articles).filter((a) => a.id !== id), shown).slice(0, 5);
}

// 同じ話題を報じた他のメディアの記事（Google ニュースの「すべての記事」のように）
function coverageHtml(a) {
  const t = topicOf(a);
  if (!t) return '';
  const others = t.articles
    .filter((o) => o.id !== a.id)
    .sort((x, y) => (Date.parse(y.publishedAt) || 0) - (Date.parse(x.publishedAt) || 0));
  return `<section class="cov">
    <h2 class="cov-title">この話題を報じたメディア<span>${t.sources.length}社・${t.articles.length}件</span></h2>
    ${others.map((o) => `<a class="cov-item tap${readClass(o)}" href="${esc(safeUrl(o.url))}" data-article="${o.id}">
      <div class="cov-source">${esc(o.source)}${o.publishedAt ? `<time>${relTime(o.publishedAt)}</time>` : ''}</div>
      <div class="cov-head">${esc(o.title)}</div>
    </a>`).join('')}
  </section>`;
}

function renderReader(id) {
  const entry = lookup(id);
  if (!entry) return false;
  const a = entry.article;
  const saved = state.saved[id];
  const related = relatedFor(id);

  el.readerBody.innerHTML = `
    <div class="reader-content">
      <div class="reader-kicker">${esc(entry.category || '')}</div>
      <h1 class="reader-title">${esc(a.title)}</h1>
      <div class="reader-meta">
        ${a.book ? `<span>${bookMeta(a)}</span>` : ''}
        <span>${esc(a.source)}</span>
        ${a.publishedAt ? `<time>${fullDate(a.publishedAt)}</time>` : ''}
        ${a.score ? `<span class="pick">${a.score.toLocaleString()} users</span>` : ''}
      </div>
      ${a.book ? (a.image ? `<img class="book-cover reader-cover" src="${esc(a.image)}" alt="" referrerpolicy="no-referrer">` : '') : imgHtml(a.image, 'reader-img')}
      ${a.summary
        ? `<p class="reader-summary">${esc(a.summary)}</p>`
        : '<p class="reader-summary is-empty">この記事の概要はありません。元の記事でお読みください。</p>'}
      <a class="btn-primary" href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer" data-open-external>${a.book ? '本の詳しい情報を見る' : `${esc(a.source)}で続きを読む`} ${ICON_EXTERNAL}</a>
      ${a.access ? `<p class="reader-paywall">${a.access === 'paid' ? 'この記事は有料記事です。続きを読むには配信元の購読（有料会員）が必要な場合があります。' : 'この記事は会員限定です。続きを読むには配信元への会員登録やログインが必要な場合があります。'}</p>` : ''}
      <p class="reader-note">${{ ask: '凪の中か Comet かを選んで開きます', nagi: '凪の中で配信元のサイトが開きます', comet: 'Comet で配信元のサイトが開きます' }[state.settings.openWith] || ''}</p>
      ${coverageHtml(a)}
      <div class="memo">
        <label for="memo">メモ</label>
        <textarea id="memo" placeholder="気づいたこと・考えたことを残せます（書くと自動で保存されます）">${esc(saved?.memo || '')}</textarea>
      </div>
    </div>
    ${related.length ? `<div class="related section">
      <div class="section-head"><h3>${esc(entry.category || '')}の他の記事</h3></div>
      ${related.map((r) => rowHtml(r)).join('')}
    </div>` : ''}`;

  el.readerSave.setAttribute('aria-pressed', String(Boolean(saved)));
  el.readerSave.setAttribute('aria-label', saved ? '保存を解除' : '保存');
  el.readerBody.scrollTop = 0;
  state.readerId = id;
  return true;
}

// iPhone / iPad では記事を開くときに履歴を足さない。足すと、端からのスワイプで
// iOS 自身の「戻る」と凪の「スワイプで閉じる」が同時に動き、画面が2枚に重なって見える
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let readerPushed = false;
function openReader(id, { push = true } = {}) {
  if (!renderReader(id)) return;
  markRead(id);
  el.reader.classList.add('is-open');
  el.reader.setAttribute('aria-hidden', 'false');
  if (push && !IOS) { history.pushState({ reader: id }, ''); readerPushed = true; }
}

function closeReader() {
  readerPushed = false;
  el.reader.classList.remove('is-open');
  el.reader.setAttribute('aria-hidden', 'true');
  el.reader.style.transform = '';
  state.readerId = null;
  if (state.view === 'saved') renderSaved();
}

window.addEventListener('popstate', (e) => {
  const id = e.state?.reader;
  if (id && lookup(id)) openReader(id, { push: false });
  else if (state.readerId) closeReader();
});

$('#reader-back').addEventListener('click', () => {
  if (readerPushed && history.state?.reader) history.back();
  else closeReader();
});

el.readerSave.addEventListener('click', () => {
  const id = state.readerId;
  if (!id) return;
  const on = !state.saved[id];
  if (!on && state.saved[id]?.memo && !confirm('保存を解除すると、メモも削除されます。よろしいですか？')) return;
  clearTimeout(memoTimer);
  setSaved(id, on);
  if (!on) $('#memo').value = '';
  el.readerSave.setAttribute('aria-pressed', String(on));
  el.readerSave.setAttribute('aria-label', on ? '保存を解除' : '保存');
  toast(on ? '保存しました' : '保存を解除しました');
});

$('#reader-share').addEventListener('click', async () => {
  const a = lookup(state.readerId)?.article;
  if (!a) return;
  if (navigator.share) {
    try { await navigator.share({ title: a.title, url: a.url }); } catch {}
    return;
  }
  try {
    await navigator.clipboard.writeText(`${a.title}\n${a.url}`);
    toast('リンクをコピーしました');
  } catch {
    toast('共有できませんでした');
  }
});

let memoTimer;
/* ---------- 記事を開く（凪の中 / Comet） ---------- */
// Comet は URL スキームを公開していないため、iOS の「ショートカット」経由で開く。
// 利用者が作ったショートカット（既定名「Cometで開く」）に記事の URL を渡して実行する
function cometUrl(url) {
  const name = state.settings.cometShortcut || DEFAULT_SETTINGS.cometShortcut;
  return `shortcuts://run-shortcut?name=${encodeURIComponent(name)}&input=text&text=${encodeURIComponent(url)}`;
}

function openInNagi(url) {
  // ホーム画面のアプリでは、凪の上に重なるブラウザ画面で開く（閉じると凪に戻る）
  window.open(url, '_blank', 'noopener');
}

function openInComet(url) {
  const target = cometUrl(url);
  // ひび手帳などの中（iframe）で開かれているときは、iframe の中からはショートカットを起動できない（iOS が止める）。
  // 同じサイトならいちばん外の画面で開き、別のサイトなら外の画面に頼む
  if (window.top !== window) {
    try { window.top.location.href = target; return; } catch (e) { /* 別のサイトの中 */ }
    try { window.parent.postMessage({ type: 'nagi:open-url', url: target }, '*'); return; } catch (e) { /* 親がいない */ }
  }
  location.href = target;
}

const sheet = $('#open-sheet');
let sheetUrl = null;

function showOpenSheet(url) {
  sheetUrl = url;
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('is-open'));
}

function hideOpenSheet() {
  sheet.classList.remove('is-open');
  setTimeout(() => (sheet.hidden = true), 250);
}

sheet.addEventListener('click', (e) => {
  const action = e.target.closest('[data-sheet]')?.dataset.sheet;
  if (!action) return;
  const url = sheetUrl;
  hideOpenSheet();
  if (action === 'nagi') openInNagi(url);
  if (action === 'comet') openInComet(url);
});

el.readerBody.addEventListener('click', (e) => {
  const link = e.target.closest('[data-open-external]');
  if (!link || !/^https?:/.test(link.href)) return;
  const mode = state.settings.openWith;
  if (mode === 'nagi') return; // 通常のリンクとして開く
  e.preventDefault();
  if (mode === 'comet') openInComet(link.href);
  else showOpenSheet(link.href);
});

el.readerBody.addEventListener('input', (e) => {
  if (e.target.id !== 'memo') return;
  const id = state.readerId;
  const memo = e.target.value;
  clearTimeout(memoTimer);
  memoTimer = setTimeout(() => {
    if (!state.saved[id]) {
      if (!memo.trim()) return;
      setSaved(id, true);
      el.readerSave.setAttribute('aria-pressed', 'true');
      toast('メモと一緒に保存しました');
    }
    state.saved[id].memo = memo;
    persistSaved();
  }, 400);
});

// 端から右へスワイプして閉じる（ホーム画面アプリには戻るジェスチャーがないため）
// 指を離したら、その位置からそのまま右へ流して閉じる（いったん戻ってから閉じると、がくっと見える）
(() => {
  let sx = null, sy = 0, dx = 0, t0 = 0, dragging = false, raf = 0;
  const R = el.reader;
  const paint = () => { raf = 0; R.style.transform = `translate3d(${Math.max(0, dx)}px,0,0)`; };
  R.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX < 32 ? t.clientX : null;
    sy = t.clientY; dx = 0; t0 = Date.now();
    dragging = false;
  }, { passive: true });
  R.addEventListener('touchmove', (e) => {
    if (sx == null) return;
    const t = e.touches[0];
    dx = t.clientX - sx;
    if (!dragging) {
      if (Math.abs(t.clientY - sy) > Math.abs(dx)) { sx = null; return; }
      if (dx < 8) return;
      dragging = true;
      R.classList.add('is-dragging');
    }
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: true });
  const end = () => {
    sx = null;
    if (!dragging) return;
    dragging = false; cancelAnimationFrame(raf); raf = 0;
    const w = R.offsetWidth || innerWidth, fast = dx > 30 && dx / Math.max(1, Date.now() - t0) > 0.45;
    if (dx > Math.min(110, w * .3) || fast) {
      const left = Math.max(0, (w - dx) / w);
      R.style.transition = `transform ${(0.12 + left * 0.2).toFixed(2)}s cubic-bezier(.25,.8,.3,1)`;
      R.style.transform = `translate3d(${w}px,0,0)`;
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        // the page is already off screen: close without another slide
        R.style.transition = 'none';
        if (readerPushed && history.state?.reader) history.back(); else closeReader();
        requestAnimationFrame(() => requestAnimationFrame(() => { R.style.transition = ''; R.classList.remove('is-dragging'); }));
      };
      R.addEventListener('transitionend', finish, { once: true });
      setTimeout(finish, 450);
    } else {
      R.classList.remove('is-dragging');
      R.style.transition = 'transform .3s cubic-bezier(.25,.8,.3,1)';
      R.style.transform = '';
      setTimeout(() => { if (!dragging) R.style.transition = ''; }, 320);
    }
  };
  R.addEventListener('touchend', end);
  R.addEventListener('touchcancel', end);
})();

/* ---------- 記事タップ（全画面共通） ---------- */
document.addEventListener('click', (e) => {
  const goto = e.target.closest('[data-goto]');
  if (goto) {
    const i = visibleCategories().findIndex((c) => c.id === goto.dataset.goto);
    if (i >= 0) goToCategory(i);
    return;
  }
  const card = e.target.closest('[data-article]');
  if (!card || e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  if (state.readerId) {
    // 詳細画面内の関連記事は同じ画面で切り替える
    if (readerPushed) history.replaceState({ reader: card.dataset.article }, '');
    renderReader(card.dataset.article);
    markRead(card.dataset.article);
  } else {
    openReader(card.dataset.article);
  }
});

// 読み込めない画像は取り除いて、文字だけのレイアウトにする
document.addEventListener('error', (e) => {
  if (e.target.tagName === 'IMG') e.target.remove();
}, true);

/* ---------- 画面切り替え ---------- */
function showView(name) {
  if (name === state.view) {
    if (name === 'settings' && state.settingsPage !== 'main') {
      state.settingsPage = 'main';
      renderSettings();
    }
    if (name === 'news') el.pager.children[state.current]?.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  state.view = name;
  document.querySelectorAll('.view').forEach((v) => {
    const on = v.dataset.view === name;
    v.hidden = !on;
    v.classList.toggle('is-active', on);
  });
  document.querySelectorAll('.tabbar-item').forEach((b) => b.classList.toggle('is-active', b.dataset.target === name));
  el.app.classList.toggle('is-sub', name !== 'news');

  if (name === 'news') {
    requestAnimationFrame(() => (el.pager.scrollLeft = state.current * el.pager.clientWidth));
  }
  if (name === 'saved') renderSaved();
  if (name === 'settings') {
    state.settingsPage = 'main';
    renderSettings();
  }
  if (name === 'search') {
    renderSearch();
    if (!el.searchInput.value) el.searchInput.focus();
  }
}

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tabbar-item');
  if (btn) showView(btn.dataset.target);
});

/* ---------- 検索 ---------- */
function highlight(text, terms) {
  let html = esc(text);
  for (const term of terms) {
    const re = new RegExp(esc(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    html = html.replace(re, (m) => `<mark>${m}</mark>`);
  }
  return html;
}

function renderSearch() {
  const q = el.searchInput.value.trim();
  if (!q) {
    el.searchResults.innerHTML = emptyHtml(ICON_SEARCH, '見出しや概要に含まれる言葉で<br>今日の記事と保存した記事を探せます');
    return;
  }
  const terms = q.toLowerCase().split(/[\s　]+/).filter(Boolean);
  const pool = new Map();
  for (const { article } of state.index.values()) pool.set(article.id, article);
  for (const { article } of Object.values(state.saved)) if (!pool.has(article.id)) pool.set(article.id, article);

  const hits = [...pool.values()]
    .filter((a) => {
      const hay = `${a.title} ${a.summary} ${a.source}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    })
    .sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0))
    .slice(0, 100);

  el.searchResults.innerHTML = hits.length
    ? `<p class="result-count">${hits.length} 件</p>` + hits.map((a) => rowHtml(a, { titleHtml: highlight(a.title, terms) })).join('')
    : emptyHtml(ICON_SEARCH, `「${esc(q)}」に一致する記事はありませんでした`);
}

let searchTimer;
el.searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderSearch, 150);
});

el.searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.searchInput.blur();
});

/* ---------- 保存一覧 ---------- */
function renderSaved() {
  const items = Object.values(state.saved).sort((a, b) => b.savedAt - a.savedAt);
  if (!items.length) {
    el.savedList.innerHTML = emptyHtml(ICON_BOOKMARK, 'あとで読みたい記事は、記事画面の<br>しおりボタンで保存できます');
    return;
  }
  el.savedList.innerHTML = `<p class="result-count">${items.length} 件</p>` + items
    .map((s) => rowHtml(s.article, { extra: s.memo ? `<p class="memo-preview">${esc(s.memo)}</p>` : '' }))
    .join('');
}

/* ---------- 設定 ---------- */
function applySettings() {
  const root = document.documentElement;
  const s = state.settings;
  if (s.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = s.theme;
  if (s.fontSize === 'medium') delete root.dataset.fontSize;
  else root.dataset.fontSize = s.fontSize;
  document.body.classList.toggle('hide-images', !s.images);
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]').setAttribute('content', bg);
}

function saveSettings() {
  store.set('settings', state.settings);
  applySettings();
}

function segmented(key, options) {
  return `<div class="segmented" role="group">${options
    .map(([value, label]) => `<button data-setting="${key}" data-value="${value}" aria-pressed="${state.settings[key] === value}">${label}</button>`)
    .join('')}</div>`;
}

function switchHtml(attrs, on, label) {
  return `<button class="switch" role="switch" ${attrs} aria-checked="${on}" aria-label="${esc(label)}"></button>`;
}

const ICON_BACK = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 5-7 7 7 7"/></svg>';
const ICON_MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12h10"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 12h10M12 7v10"/></svg>';
const ICON_GRIP = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9h14M5 12h14M5 15h14"/></svg>';

function setSettingsTitle(text, back) {
  document.querySelector('.view-settings .view-head').innerHTML = `<h2 class="view-title">${
    back ? `<button class="icon-btn view-back" data-action="settings-back" aria-label="戻る">${ICON_BACK}</button>` : ''
  }${esc(text)}</h2>`;
}

// NewsPicks の「タブの並び替えと選択」と同じ操作：−で非表示、＋で表示、≡ をドラッグして並び替え
function renderTabSettings() {
  setSettingsTitle('タブの並び替えと選択', true);
  const { visible, hidden } = tabLayout();
  el.settings.innerHTML = `
    <p class="setting-note">−で非表示、＋で表示、右の ≡ を上下にドラッグすると並び替えができます。</p>
    <div class="reset-wrap"><button class="btn-outline" data-action="reset-tabs">並び替えと選択をデフォルトに戻す</button></div>
    <div class="settings-group">
      <h3>表示されているタブ</h3>
      <div class="settings-list" id="tab-visible">
        ${visible.map((c) => `<div class="tab-row" data-id="${c.id}">
          ${c.id === FIXED_TAB
            ? '<span class="tab-btn-space"></span>'
            : `<button class="tab-btn is-remove" data-remove="${c.id}" aria-label="${esc(c.label)}を非表示にする">${ICON_MINUS}</button>`}
          <span class="tab-row-label">${esc(c.label)}</span>
          <span class="drag-handle" aria-label="ドラッグして並び替え">${ICON_GRIP}</span>
        </div>`).join('')}
      </div>
    </div>
    <div class="settings-group">
      <h3>タブを表示</h3>
      ${hidden.length
        ? `<div class="settings-list">${hidden.map((c) => `<div class="tab-row">
            <button class="tab-btn is-add" data-add="${c.id}" aria-label="${esc(c.label)}を表示する">${ICON_PLUS}</button>
            <span class="tab-row-label">${esc(c.label)}</span>
          </div>`).join('')}</div>`
        : '<p class="setting-note">すべてのタブを表示しています。</p>'}
    </div>
    <div style="height:32px"></div>`;
}

function renderSettings() {
  if (state.settingsPage === 'tabs') return renderTabSettings();
  setSettingsTitle('設定', false);
  const s = state.settings;
  const cats = state.data?.categories || [];
  const sources = [...new Set(cats.flatMap((c) => c.articles.map((a) => a.source)))];

  el.settings.innerHTML = `
    <div class="settings-group">
      <h3>表示</h3>
      <div class="settings-list">
        <div class="setting"><span>文字の大きさ</span>${segmented('fontSize', [['small', '小'], ['medium', '標準'], ['large', '大'], ['xlarge', '特大']])}</div>
        <div class="setting"><span>テーマ</span>${segmented('theme', [['auto', '自動'], ['light', 'ライト'], ['dark', 'ダーク']])}</div>
        <div class="setting"><span>画像を表示</span>${switchHtml('data-toggle="images"', s.images, '画像を表示')}</div>
        <div class="setting"><span>既読の記事を薄くする</span>${switchHtml('data-toggle="dimRead"', s.dimRead, '既読の記事を薄くする')}</div>
        <div class="setting"><span>有料・会員限定の記事も表示</span>${switchHtml('data-toggle="showPaid"', s.showPaid, '有料・会員限定の記事も表示')}</div>
      </div>
    </div>
    <div class="settings-group">
      <h3>タブ</h3>
      <div class="settings-list">
        <button class="setting is-button" data-action="edit-tabs"><span>タブの並び替えと選択</span><span class="chev">${visibleCategories().length}個表示 ›</span></button>
      </div>
    </div>
    <div class="settings-group">
      <h3>記事を開く</h3>
      <div class="settings-list">
        <div class="setting"><span>開き方</span>${segmented('openWith', [['ask', '毎回選ぶ'], ['nagi', '凪'], ['comet', 'Comet']])}</div>
        <label class="setting"><span>ショートカット名</span><input class="setting-input" data-input="cometShortcut" value="${esc(s.cometShortcut)}" enterkeyhint="done" autocomplete="off"></label>
      </div>
      <details class="setting-help">
        <summary>Comet で開くための準備（最初に 1 回だけ）</summary>
        <ol>
          <li>iPhone の「ショートカット」アプリを開き、右上の「＋」で新しいショートカットを作る</li>
          <li>「アクションを追加」で <b>Comet</b> を検索し、<b>Open URL（URL を開く）</b> を追加する</li>
          <li>URL の欄をタップして「<b>ショートカットの入力</b>」を選ぶ</li>
          <li>ショートカットの名前を「<b>${esc(s.cometShortcut)}</b>」にして保存する</li>
        </ol>
        <p>以後「Cometで開く」を選ぶと、ショートカットが一瞬開いてから Comet で記事が表示されます。名前を変えたときは上の「ショートカット名」も同じにしてください。</p>
      </details>
    </div>
    <div class="settings-group">
      <h3>データ</h3>
      <div class="settings-list">
        <button class="setting is-button" data-action="clear-read">既読の履歴を消去</button>
        <button class="setting is-button danger" data-action="clear-saved">保存した記事をすべて削除</button>
      </div>
      <p class="setting-note">保存した記事やメモは、この端末のブラウザ内にだけ保存されます。</p>
    </div>
    <div class="settings-group">
      <h3>このアプリについて</h3>
      <div class="settings-list">
        <div class="setting"><span>最終更新</span><span style="color:var(--ink-3)">${state.data?.generatedAt ? fullDate(state.data.generatedAt) : '—'}</span></div>
      </div>
      <p class="setting-note">記事の提供元：${esc(sources.join('、') || '—')}<br>各記事の著作権は配信元に帰属します。見出しと概要は各社の RSS から取得しています。</p>
    </div>
    <div style="height:32px"></div>`;
}

el.settings.addEventListener('change', (e) => {
  const input = e.target.closest('[data-input]');
  if (!input) return;
  state.settings[input.dataset.input] = input.value.trim() || DEFAULT_SETTINGS[input.dataset.input];
  saveSettings();
  renderSettings();
  toast('保存しました');
});

el.settings.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-setting]');
  const toggle = e.target.closest('[data-toggle]');
  const action = e.target.closest('[data-action]');
  const add = e.target.closest('[data-add]');
  const remove = e.target.closest('[data-remove]');
  const s = state.settings;

  if (seg) {
    s[seg.dataset.setting] = seg.dataset.value;
    saveSettings();
    renderNews();
  } else if (toggle) {
    s[toggle.dataset.toggle] = !s[toggle.dataset.toggle];
    saveSettings();
    renderNews();
  } else if (add) {
    applyTabs([...visibleCategories().map((c) => c.id), add.dataset.add]);
  } else if (remove) {
    applyTabs(visibleCategories().map((c) => c.id).filter((id) => id !== remove.dataset.remove));
  } else if (action?.dataset.action === 'edit-tabs') {
    state.settingsPage = 'tabs';
    el.settings.scrollTop = 0;
  } else if (action?.dataset.action === 'settings-back') {
    state.settingsPage = 'main';
  } else if (action?.dataset.action === 'reset-tabs') {
    if (!confirm('タブの並び順と表示をデフォルトに戻しますか？')) return;
    const currentId = visibleCategories()[state.current]?.id;
    s.tabs = null;
    s.tabsHidden = [];
    saveSettings();
    state.current = Math.max(0, visibleCategories().findIndex((c) => c.id === currentId));
    renderNews();
    toast('デフォルトに戻しました');
  } else if (action?.dataset.action === 'clear-read') {
    if (!confirm('既読の履歴を消去しますか？')) return;
    state.read = new Set();
    store.set('read', []);
    renderNews();
    toast('既読の履歴を消去しました');
  } else if (action?.dataset.action === 'clear-saved') {
    if (!Object.keys(state.saved).length) return toast('保存した記事はありません');
    if (!confirm('保存した記事とメモをすべて削除しますか？')) return;
    state.saved = {};
    persistSaved();
    renderNews();
    toast('保存した記事を削除しました');
  } else {
    return;
  }
  renderSettings();
});

document.querySelector('.view-settings .view-head').addEventListener('click', (e) => {
  if (!e.target.closest('[data-action="settings-back"]')) return;
  state.settingsPage = 'main';
  renderSettings();
});

// ≡ をドラッグしてタブを並び替える（指を離した位置に移動）
el.settings.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  e.preventDefault();
  const row = handle.closest('.tab-row');
  const rows = [...row.parentElement.children];
  const from = rows.indexOf(row);
  const h = row.getBoundingClientRect().height;
  const startY = e.clientY;
  let to = from;
  row.classList.add('is-dragging');
  handle.setPointerCapture(e.pointerId);

  const move = (ev) => {
    const dy = Math.max(-from * h - h / 2, Math.min((rows.length - 1 - from) * h + h / 2, ev.clientY - startY));
    to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / h)));
    row.style.transform = `translateY(${dy}px)`;
    rows.forEach((r, i) => {
      if (r === row) return;
      const shift = from < to && i > from && i <= to ? -h : from > to && i < from && i >= to ? h : 0;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const end = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', end);
    handle.removeEventListener('pointercancel', end);
    const ids = rows.map((r) => r.dataset.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    if (to !== from) applyTabs(ids);
    renderSettings();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
});

/* ---------- 起動 ---------- */
async function init() {
  applySettings();
  renderHeader();
  history.replaceState(history.state?.reader ? {} : history.state, '');

  await refresh();
  // 前回見ていたタブ（初回はトップ）から始める
  const lastCat = store.get('lastCat', FIXED_TAB);
  const i = visibleCategories().findIndex((c) => c.id === lastCat);
  if (i > 0) {
    state.current = i;
    [...el.tabs.children].forEach((t, j) => t.setAttribute('aria-selected', String(j === i)));
    requestAnimationFrame(() => {
      el.pager.scrollLeft = i * el.pager.clientWidth;
      centerTab(i, false);
    });
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
