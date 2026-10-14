// My News — 広告のない個人用ニュースリーダー
const DATA_URL = 'data/news.json';
const PREFIX = 'mynews:';
const AUTO_REFRESH_MS = 10 * 60 * 1000;
const TOP_LIMIT = 15;
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

const DEFAULT_SETTINGS = { theme: 'auto', fontSize: 'medium', images: true, dimRead: true, hidden: [] };

const state = {
  data: null,
  index: new Map(), // id -> { article, category }
  settings: { ...DEFAULT_SETTINGS, ...store.get('settings', {}) },
  saved: store.get('saved', {}), // id -> { article, category, savedAt, memo }
  read: new Set(store.get('read', [])),
  current: 0,
  view: 'news',
  lastFetch: 0,
  readerId: null,
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

function visibleCategories() {
  if (!state.data) return [];
  const cats = state.data.categories.filter((c) => !state.settings.hidden.includes(c.id));
  return cats.length ? cats : state.data.categories.slice(0, 1);
}

function lookup(id) {
  return state.index.get(id) || state.saved[id] || null;
}

/* ---------- 記事の HTML ---------- */
function metaHtml(a) {
  const parts = [`<span class="source">${esc(a.source)}</span>`];
  if (a.publishedAt) parts.push(`<time datetime="${esc(a.publishedAt)}">${relTime(a.publishedAt)}</time>`);
  if (a.score) parts.push(`<span class="pick">${a.score.toLocaleString()} users</span>`);
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

/* ---------- カテゴリページ ---------- */
function categoryHtml(cat, isTop) {
  let html = '';
  if (isTop && state.data.sample) {
    html += `<p class="notice">サンプルデータを表示しています。GitHub Actions で公開すると、実際のニュースが自動で届くようになります。</p>`;
  }
  if (!cat.articles.length) {
    return html + emptyHtml(ICON_CLOUD, 'このカテゴリの記事を取得できませんでした。<br>しばらくしてから更新してください。');
  }

  const list = isTop ? cat.articles.slice(0, TOP_LIMIT) : cat.articles;
  const [first, ...rest] = list;
  html += heroHtml(first);
  rest.forEach((a, i) => {
    html += a.image && (i + 1) % 7 === 0 ? featureHtml(a) : rowHtml(a);
  });

  if (isTop) {
    // 日経のトップ面のように、各カテゴリの主な見出しを並べる
    const shown = new Set(list.map((a) => a.id));
    for (const other of visibleCategories()) {
      if (other.id === cat.id) continue;
      const picks = other.articles.filter((a) => !shown.has(a.id)).slice(0, 3);
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

function renderNews() {
  const cats = visibleCategories();
  if (state.current >= cats.length) state.current = 0;

  el.tabs.innerHTML = cats
    .map((c, i) => `<button class="tab" role="tab" data-index="${i}" aria-selected="${i === state.current}">${esc(c.label)}</button>`)
    .join('');

  el.pager.innerHTML = cats
    .map((c, i) => `<div class="page scroll" data-cat="${c.id}" role="tabpanel">
      <div class="ptr"><span></span></div>
      <div class="page-inner">${categoryHtml(c, i === 0)}</div>
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
  return cat ? cat.articles.filter((a) => a.id !== id).slice(0, 5) : [];
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
        <span>${esc(a.source)}</span>
        ${a.publishedAt ? `<time>${fullDate(a.publishedAt)}</time>` : ''}
        ${a.score ? `<span class="pick">${a.score.toLocaleString()} users</span>` : ''}
      </div>
      ${imgHtml(a.image, 'reader-img')}
      ${a.summary
        ? `<p class="reader-summary">${esc(a.summary)}</p>`
        : '<p class="reader-summary is-empty">この記事の概要はありません。元の記事でお読みください。</p>'}
      <a class="btn-primary" href="${esc(safeUrl(a.url))}" target="_blank" rel="noopener noreferrer">${esc(a.source)}で続きを読む ${ICON_EXTERNAL}</a>
      <p class="reader-note">配信元のサイトが開きます</p>
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

function openReader(id, { push = true } = {}) {
  if (!renderReader(id)) return;
  markRead(id);
  el.reader.classList.add('is-open');
  el.reader.setAttribute('aria-hidden', 'false');
  if (push) history.pushState({ reader: id }, '');
}

function closeReader() {
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
  if (history.state?.reader) history.back();
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
(() => {
  let sx = null, sy = 0, dx = 0, dragging = false;
  el.reader.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    sx = t.clientX < 32 ? t.clientX : null;
    sy = t.clientY;
    dx = 0;
    dragging = false;
  }, { passive: true });
  el.reader.addEventListener('touchmove', (e) => {
    if (sx == null) return;
    const t = e.touches[0];
    dx = t.clientX - sx;
    if (!dragging) {
      if (Math.abs(t.clientY - sy) > Math.abs(dx)) { sx = null; return; }
      if (dx < 8) return;
      dragging = true;
      el.reader.classList.add('is-dragging');
    }
    el.reader.style.transform = `translateX(${Math.max(0, dx)}px)`;
  }, { passive: true });
  el.reader.addEventListener('touchend', () => {
    if (!dragging) return;
    el.reader.classList.remove('is-dragging');
    el.reader.style.transform = '';
    if (dx > 90) $('#reader-back').click();
    sx = null;
  });
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
    history.replaceState({ reader: card.dataset.article }, '');
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
  if (name === 'settings') renderSettings();
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

function renderSettings() {
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
      </div>
    </div>
    <div class="settings-group">
      <h3>カテゴリ</h3>
      <div class="settings-list">
        ${cats.map((c) => `<div class="setting"><span>${esc(c.label)}</span>${switchHtml(`data-category="${c.id}"`, !s.hidden.includes(c.id), c.label)}</div>`).join('')}
      </div>
      <p class="setting-note">オフにしたカテゴリはタブに表示されません。</p>
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

el.settings.addEventListener('click', (e) => {
  const seg = e.target.closest('[data-setting]');
  const toggle = e.target.closest('[data-toggle]');
  const cat = e.target.closest('[data-category]');
  const action = e.target.closest('[data-action]');
  const s = state.settings;

  if (seg) {
    s[seg.dataset.setting] = seg.dataset.value;
    saveSettings();
    renderNews();
  } else if (toggle) {
    s[toggle.dataset.toggle] = !s[toggle.dataset.toggle];
    saveSettings();
    renderNews();
  } else if (cat) {
    const id = cat.dataset.category;
    const hidden = new Set(s.hidden);
    if (hidden.has(id)) hidden.delete(id);
    else hidden.add(id);
    if (hidden.size >= (state.data?.categories.length || 0)) {
      toast('少なくとも 1 つのカテゴリを表示してください');
      return;
    }
    s.hidden = [...hidden];
    state.current = 0;
    saveSettings();
    renderNews();
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

/* ---------- 起動 ---------- */
async function init() {
  applySettings();
  renderHeader();
  history.replaceState(history.state?.reader ? {} : history.state, '');

  await refresh();
  const lastCat = store.get('lastCat', null);
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
