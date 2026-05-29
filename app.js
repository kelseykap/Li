/* Library - book tracker
   Single-page hash-routed app. Books stored in books.json (in repo),
   working copy in localStorage. Sync to GitHub via PAT.
*/
(() => {
'use strict';

// ---------- helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const attr = (s) => esc(s);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const nowIso = () => new Date().toISOString();
const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const RATING_LABELS = { 1: 'Ok', 2: 'Good', 3: 'Loved', 4: 'Favourite' };
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const toast = (msg, ms = 1800) => {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
};

// ---------- state ----------
const STORE_KEY = 'lib.books.v1';
const CFG_KEY = 'lib.cfg.v1';
const PAT_KEY = 'lib.pat.v1'; // separated so it can be wiped independently

const State = {
  books: [],
  challenges: [],
  filter: 'all', // all | read | tbr | bookmarked
  sort: 'recent',
  sortDir: 'desc', // 'asc' | 'desc'
  view: 'list', // 'list' | 'grid'
  search: '',
  loaded: false,
  dirty: false, // true if local changes not pushed to GitHub
  config: { owner: '', repo: '', branch: 'main', path: 'books.json' },
};

const DEFAULT_CHALLENGES = [
  { id: 'ch_alphabet', type: 'alphabet', name: 'Read the alphabet', description: 'A book starting with each letter A–Z. Articles ("The", "A") stripped.' },
  { id: 'ch_countries', type: 'country', name: 'One book per country', description: 'Unique countries discovered through reading.' },
  { id: 'ch_atwood', type: 'author', name: 'Complete Margaret Atwood', target: 'Margaret Atwood', description: 'Every book by Margaret Atwood — read or TBR.' },
  { id: 'ch_time', type: 'genre', name: 'Genre: Time-travel', target: 'Time-travel', description: 'Books exploring time travel.' },
];

// Persist UI preferences across sessions
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('lib.prefs.v1') || '{}');
    if (p.view) State.view = p.view;
    if (p.sort) State.sort = p.sort;
    if (p.sortDir) State.sortDir = p.sortDir;
    if (p.filter) State.filter = p.filter;
  } catch {}
}
function savePrefs() {
  localStorage.setItem('lib.prefs.v1', JSON.stringify({
    view: State.view, sort: State.sort, sortDir: State.sortDir, filter: State.filter,
  }));
}

function loadConfig() {
  try { State.config = Object.assign(State.config, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); } catch {}
}
function saveConfig() { localStorage.setItem(CFG_KEY, JSON.stringify(State.config)); }
function getPat() { return localStorage.getItem(PAT_KEY) || ''; }
function setPat(v) { v ? localStorage.setItem(PAT_KEY, v) : localStorage.removeItem(PAT_KEY); }

// ---------- storage ----------
async function loadBooks() {
  loadConfig();
  loadPrefs();

  // Read working copy from localStorage
  let local = null;
  try {
    const s = localStorage.getItem(STORE_KEY);
    if (s) local = JSON.parse(s);
  } catch {}

  // Always try to fetch the source-of-truth from the repo too, so we can
  // pick up edits made on another device. If we're offline, we just use local.
  let remote = null;
  try {
    const r = await fetch('books.json', { cache: 'no-store' });
    if (r.ok) remote = await r.json();
  } catch {}

  let chosen;
  if (local && remote) {
    if (local.dirty) {
      // local has unpushed edits — keep them, don't blow them away with remote
      chosen = local;
    } else {
      // both clean: prefer whichever updatedAt is newer
      const lt = local.updatedAt || '';
      const rt = remote.updatedAt || '';
      chosen = lt >= rt ? local : remote;
    }
  } else {
    chosen = local || remote || { books: [], challenges: DEFAULT_CHALLENGES.slice() };
  }

  State.books = chosen.books || [];
  State.challenges = chosen.challenges;
  State.dirty = !!(local && local.dirty && chosen === local);
  seedDefaultsIfNeeded();
  persist();
  State.loaded = true;

  // If we replaced local with a newer remote, no further action needed.
  // If local was dirty and an auto-sync is possible, kick one off so unpushed
  // edits from a previous session get pushed now that we're back online.
  if (State.dirty) scheduleAutoSync(500);
}

function seedDefaultsIfNeeded() {
  if (State.challenges === undefined || State.challenges === null) {
    State.challenges = DEFAULT_CHALLENGES.slice();
    State.dirty = true;
  }
}

function persist() {
  const doc = { version: 2, updatedAt: nowIso(), dirty: State.dirty, books: State.books, challenges: State.challenges };
  localStorage.setItem(STORE_KEY, JSON.stringify(doc));
}

function upsertBook(book) {
  book.updatedAt = nowIso();
  if (!book.id) book.id = uid();
  if (!book.createdAt) book.createdAt = nowIso();
  const i = State.books.findIndex(b => b.id === book.id);
  if (i >= 0) State.books[i] = book; else State.books.unshift(book);
  State.dirty = true;
  persist();
  scheduleAutoSync();
}
function deleteBook(id) {
  State.books = State.books.filter(b => b.id !== id);
  State.dirty = true;
  persist();
  scheduleAutoSync();
}
function getBook(id) { return State.books.find(b => b.id === id); }

// ---------- header ----------
function setHeader({ title = 'Library', back = false, right = '' } = {}) {
  $('#header').innerHTML = `
    ${back ? `<button class="icon-btn" onclick="history.back()" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>` : `<span style="width:36px"></span>`}
    <h1>${esc(title)}</h1>
    ${right || `<span style="width:36px"></span>`}
  `;
}
function updateNav() {
  const route = location.hash || '#/';
  $$('.nav a').forEach(a => {
    const target = a.getAttribute('href');
    a.classList.toggle('active', target === route || (target === '#/' && route === '#/'));
  });
}

// ---------- router ----------
const routes = [
  { re: /^#\/?$/, view: viewLibrary },
  { re: /^#\/book\/([^/]+)\/edit$/, view: (m) => viewEdit(m[1]) },
  { re: /^#\/book\/([^/]+)$/, view: (m) => viewDetail(m[1]) },
  { re: /^#\/add$/, view: () => viewEdit(null) },
  { re: /^#\/stats$/, view: viewStats },
  { re: /^#\/challenges$/, view: viewChallenges },
  { re: /^#\/challenge\/new$/, view: () => viewChallengeEdit(null) },
  { re: /^#\/challenge\/([^/]+)\/edit$/, view: (m) => viewChallengeEdit(m[1]) },
  { re: /^#\/map$/, view: viewMap },
  { re: /^#\/settings$/, view: viewSettings },
];
function route() {
  const hash = location.hash || '#/';
  // clean up any map instance
  if (window._map) { window._map.remove(); window._map = null; }
  for (const r of routes) {
    const m = hash.match(r.re);
    if (m) { r.view(m); updateNav(); window.scrollTo(0, 0); return; }
  }
  $('#app').innerHTML = `<div class="empty">Not found. <a href="#/">Go home</a></div>`;
}
window.addEventListener('hashchange', route);

// Force re-render when tapping the active nav tab (hashchange won't fire if hash is unchanged).
// This makes sure Stats etc. always reflect the latest State.books after edits.
document.addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('.nav a');
  if (!a) return;
  const target = a.getAttribute('href');
  const current = location.hash || '#/';
  if (target === current) {
    // Same tab tap: explicitly re-render after the click resolves
    requestAnimationFrame(() => route());
  }
});

// ---------- views ----------
function renderRating(r, big = false) {
  let html = `<span class="rating-dots ${big ? 'accent' : ''}">`;
  for (let i = 1; i <= 4; i++) html += `<span class="d ${r >= i ? 'on' : ''}"></span>`;
  html += `</span>`;
  return html;
}
function coverHtml(b, size = 'small') {
  if (b.coverUrl) {
    return `<img class="cover" loading="lazy" src="${attr(b.coverUrl)}" alt="" onerror="this.outerHTML='<div class=\\'cover-placeholder ${size==='big'?'big':''}\\'>${esc((b.title||'?')[0]||'?')}</div>'">`;
  }
  return `<div class="cover-placeholder ${size==='big'?'big':''}">${esc((b.title || '?')[0] || '?')}</div>`;
}

// Library toolbar state: idle | search | sort (collapses by default to reduce clutter)
State.tool = State.tool || 'idle';

function viewLibrary() {
  setHeader({
    title: 'Library',
    right: `<a href="#/add" class="icon-btn" aria-label="Add book"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></a>`
  });
  $('#app').innerHTML = `
    <div class="filters" id="filtersRow"></div>
    <div class="search-row" id="toolbar"></div>
    <div id="bookListWrap"></div>
    <div id="dirtyNote"></div>
  `;
  renderFilters();
  renderToolbar();
  renderBookList();
  renderDirtyNote();
}

function renderFilters() {
  const counts = {
    all: State.books.length,
    read: State.books.filter(b => b.status === 'read').length,
    tbr: State.books.filter(b => b.status === 'tbr').length,
    dnf: State.books.filter(b => b.status === 'dnf').length,
    bookmarked: State.books.filter(b => b.bookmarked).length,
  };
  const labels = { all: 'All', read: 'Read', tbr: 'TBR', dnf: 'DNF', bookmarked: 'Bookmarked' };
  $('#filtersRow').innerHTML = ['all','read','tbr','bookmarked','dnf'].map(f => `
    <button class="pill ${State.filter===f?'on':''}" data-f="${f}">
      ${labels[f]}
      <span style="opacity:0.55"> ${counts[f]}</span>
    </button>`).join('');
  $$('#filtersRow .pill').forEach(p => p.onclick = () => {
    State.filter = p.dataset.f; savePrefs(); renderFilters(); renderBookList();
  });
}

function renderToolbar() {
  const isGrid = State.view === 'grid';
  const searchActive = !!State.search;
  const sortActive = State.sort !== 'recent' || State.sortDir !== 'desc';
  const tool = State.tool;
  let html = '';

  if (tool === 'search') {
    html = `
      <input type="search" id="search" placeholder="Search title, author, genre" value="${attr(State.search)}" autocomplete="off">
      <button class="icon-btn" id="closeTool" aria-label="Close search">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>`;
  } else if (tool === 'sort') {
    html = `
      <select id="sort" style="flex:1">
        ${[
          ['recent','Recent'],
          ['title','Title'],
          ['author','Author'],
          ['rating','Rating'],
          ['date','Date read'],
        ].map(([v,l]) => `<option value="${v}" ${State.sort===v?'selected':''}>${l}</option>`).join('')}
      </select>
      <button class="icon-btn" id="dirBtn" aria-label="Sort direction">
        ${State.sortDir==='desc'
          ? '<svg viewBox="0 0 24 24"><path d="M12 5v14M6 13l6 6 6-6"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>'}
      </button>
      <button class="icon-btn" id="closeTool" aria-label="Close sort">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>`;
  } else {
    // idle — small icon buttons
    html = `
      <button class="icon-btn ${searchActive?'active-state':''}" id="openSearch" aria-label="Search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      </button>
      <button class="icon-btn ${sortActive?'active-state':''}" id="openSort" aria-label="Sort">
        <svg viewBox="0 0 24 24"><path d="M3 7h18M6 12h12M10 17h4"/></svg>
      </button>
      <span class="spacer"></span>
      <button class="icon-btn ${isGrid?'on':''}" id="viewBtn" aria-label="${isGrid?'List view':'Grid view'}">
        ${isGrid
          ? '<svg viewBox="0 0 24 24"><path d="M3 6h18M3 12h18M3 18h18"/></svg>'
          : '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>'}
      </button>`;
  }
  $('#toolbar').innerHTML = html;

  // bindings
  if (tool === 'search') {
    const input = $('#search');
    input.focus();
    // place cursor at end without blur
    const v = input.value;
    input.setSelectionRange(v.length, v.length);
    input.oninput = debounce(e => {
      State.search = e.target.value;
      renderBookList();
    }, 150);
    $('#closeTool').onclick = () => {
      State.search = '';
      State.tool = 'idle';
      renderToolbar();
      renderBookList();
    };
  } else if (tool === 'sort') {
    $('#sort').onchange = e => {
      State.sort = e.target.value;
      // Rating + Date Read only make sense for read books — auto-switch the filter
      if ((State.sort === 'rating' || State.sort === 'date') && State.filter !== 'read') {
        State.filter = 'read';
        renderFilters();
      }
      savePrefs();
      renderBookList();
    };
    $('#dirBtn').onclick = () => {
      State.sortDir = State.sortDir === 'desc' ? 'asc' : 'desc';
      savePrefs();
      renderToolbar();
      renderBookList();
    };
    $('#closeTool').onclick = () => { State.tool = 'idle'; renderToolbar(); };
  } else {
    $('#openSearch').onclick = () => { State.tool = 'search'; renderToolbar(); };
    $('#openSort').onclick = () => { State.tool = 'sort'; renderToolbar(); };
    $('#viewBtn').onclick = () => { State.view = isGrid ? 'list' : 'grid'; savePrefs(); renderToolbar(); renderBookList(); };
  }
}

function renderBookList() {
  const filtered = applyFilter(State.books);
  const isGrid = State.view === 'grid';
  const html = filtered.length === 0
    ? `<div class="empty">${State.search ? 'No matches.' : 'No books yet. Tap + to add one.'}</div>`
    : isGrid
      ? `<div class="book-grid">${filtered.map(bookCard).join('')}</div>`
      : `<ul class="book-list">${filtered.map(bookRow).join('')}</ul>`;
  $('#bookListWrap').innerHTML = html;
}

function renderDirtyNote() {
  $('#dirtyNote').innerHTML = State.dirty
    ? `<div class="empty" style="font-size:12px;padding:24px 0 0">Unsaved changes · <a href="#/settings" style="text-decoration:underline">sync to GitHub</a></div>`
    : '';
}

function bookCard(b) {
  const showCorner = b.bookmarked || (b.status === 'read' && b.rating) || b.status === 'dnf';
  return `
    <div class="book-card" onclick="location.hash='#/book/${attr(b.id)}'">
      ${coverHtml(b)}
      ${showCorner
        ? `<span class="corner">
            ${b.bookmarked ? '★' : ''}
            ${b.status === 'read' && b.rating ? renderRating(b.rating) : ''}
            ${b.status === 'dnf' ? 'DNF' : ''}
          </span>`
        : ''}
      <div class="title">${esc(b.title || '(untitled)')}</div>
      ${b.author ? `<div class="author">${esc(b.author)}</div>` : ''}
    </div>`;
}

function bookRow(b) {
  const metaBits = [];
  if (b.status === 'read' && b.dateRead) metaBits.push(fmtDate(b.dateRead));
  if (b.medium === 'audio') metaBits.push('audio');
  if (b.genre) metaBits.push(esc(b.genre));
  return `
    <li class="book-row" onclick="location.hash='#/book/${attr(b.id)}'">
      ${coverHtml(b)}
      <div>
        <div class="title">${esc(b.title || '(untitled)')}</div>
        <div class="author">${esc(b.author || '')}</div>
        <div class="meta">${metaBits.join(' · ')}</div>
      </div>
      <div class="right">
        ${b.bookmarked ? `<span class="bookmark-on" title="Bookmarked">★</span>` : ''}
        ${b.status === 'read' && b.rating
          ? renderRating(b.rating)
          : `<span class="badge">${b.status === 'tbr' ? 'TBR' : b.status === 'dnf' ? 'DNF' : ''}</span>`}
      </div>
    </li>`;
}

function applyFilter(books) {
  let out = books.slice();
  if (State.filter === 'read') out = out.filter(b => b.status === 'read');
  else if (State.filter === 'tbr') out = out.filter(b => b.status === 'tbr');
  else if (State.filter === 'dnf') out = out.filter(b => b.status === 'dnf');
  else if (State.filter === 'bookmarked') out = out.filter(b => b.bookmarked);
  const q = State.search.trim().toLowerCase();
  if (q) {
    out = out.filter(b =>
      (b.title || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q) ||
      (b.genre || '').toLowerCase().includes(q)
    );
  }
  // Base sorts produce a "natural" order. sortDir then reverses if 'asc'.
  // Natural = the order that makes intuitive sense for the field:
  //   title/author: A→Z (asc)
  //   rating/date/recent: highest/newest first (desc)
  let natural = 'desc';
  switch (State.sort) {
    case 'title':
      out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      natural = 'asc';
      break;
    case 'author':
      out.sort((a, b) => (a.author || '').localeCompare(b.author || ''));
      natural = 'asc';
      break;
    case 'rating':
      out.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      break;
    case 'date':
      out.sort((a, b) => (b.dateRead || '').localeCompare(a.dateRead || ''));
      break;
    case 'recent':
    default:
      out.sort((a, b) => {
        if (State.filter === 'tbr' || State.filter === 'bookmarked') {
          if (!!b.bookmarked - !!a.bookmarked) return (b.bookmarked?1:0) - (a.bookmarked?1:0);
        }
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
      });
  }
  if (State.sortDir !== natural) out.reverse();
  return out;
}

function viewDetail(id) {
  const b = getBook(id);
  if (!b) { $('#app').innerHTML = `<div class="empty">Not found</div>`; return; }
  setHeader({
    title: '',
    back: true,
    right: `
      <button class="icon-btn" onclick="window._toggleBookmark('${attr(b.id)}')" aria-label="${b.bookmarked?'Remove bookmark':'Bookmark'}">
        ${b.bookmarked
          ? '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-3.5L6 21z"/></svg>'
          : '<svg viewBox="0 0 24 24"><path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-3.5L6 21z"/></svg>'}
      </button>
      <button class="icon-btn" onclick="location.hash='#/book/${attr(b.id)}/edit'" aria-label="Edit"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
    `
  });
  const meta = [];
  if (b.dateRead) meta.push(['Date read', fmtDate(b.dateRead)]);
  if (b.medium) meta.push(['Medium', b.medium === 'audio' ? 'Audiobook' : 'Book']);
  if (b.pageCount) meta.push(['Pages', String(b.pageCount)]);
  if (b.publicationDate) meta.push(['Published', fmtDate(b.publicationDate)]);
  if (b.location) meta.push(['Location', esc(b.location)]);
  if (b.genre) meta.push(['Genre', esc(b.genre)]);
  if (b.status === 'read' && b.rating) meta.push(['Rating', renderRating(b.rating, true)]);
  if (b.status === 'tbr') meta.push(['Status', b.bookmarked ? 'TBR · bookmarked' : 'TBR']);
  if (b.status === 'dnf') meta.push(['Status', 'Did not finish']);

  $('#app').innerHTML = `
    <div class="detail">
      <div class="cover-hero">${coverHtml(b, 'big')}</div>
      <h2>${esc(b.title || '(untitled)')}</h2>
      <div class="author">${esc(b.author || '')}</div>
      <div class="meta-grid">
        ${meta.map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join('')}
      </div>
      ${b.notes ? `<div class="section-h">Notes</div><div class="notes">${esc(b.notes)}</div>` : ''}
      ${b.quotes && b.quotes.length ? `<div class="section-h">Quotes</div><ul class="quotes">${b.quotes.map(q => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
    </div>`;
}
window._del = (id) => { deleteBook(id); toast('Deleted'); location.hash = '#/'; };
window._toggleBookmark = (id) => {
  const b = getBook(id);
  if (!b) return;
  b.bookmarked = !b.bookmarked;
  upsertBook(b);
  toast(b.bookmarked ? 'Bookmarked' : 'Bookmark removed');
  route();
};

function viewEdit(id) {
  const isNew = !id;
  const b = isNew
    ? { id: uid(), title: '', author: '', status: 'tbr', medium: 'book', quotes: [], bookmarked: false, rating: null }
    : Object.assign({ quotes: [] }, getBook(id));
  if (!b.id && !isNew) { $('#app').innerHTML = `<div class="empty">Not found</div>`; return; }
  setHeader({
    title: isNew ? 'Add book' : 'Edit',
    back: true,
    right: `<button class="icon-btn" onclick="window._saveBook()" aria-label="Save"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></button>`
  });
  $('#app').innerHTML = `
    <form class="form" onsubmit="event.preventDefault();window._saveBook();" id="bookForm">
      <div class="field">
        <label>Title</label>
        <input name="title" value="${attr(b.title)}" autocomplete="off" required>
      </div>
      <div class="field">
        <label>Author</label>
        <input name="author" value="${attr(b.author)}" autocomplete="off">
      </div>
      <div class="row">
        <div class="field" style="flex:3">
          <label>Status</label>
          <div class="seg">
            <button type="button" data-status="tbr" class="${b.status==='tbr'?'on':''}">TBR</button>
            <button type="button" data-status="read" class="${b.status==='read'?'on':''}">Read</button>
            <button type="button" data-status="dnf" class="${b.status==='dnf'?'on':''}">DNF</button>
          </div>
        </div>
        <div class="field" style="flex:2">
          <label>Medium</label>
          <div class="seg">
            <button type="button" data-medium="book" class="${b.medium!=='audio'?'on':''}">Book</button>
            <button type="button" data-medium="audio" class="${b.medium==='audio'?'on':''}">Audio</button>
          </div>
        </div>
      </div>
      <div class="field">
        <label>Cover</label>
        <div class="cover-preview">
          <div id="coverPrev">${coverHtml(b)}</div>
          <div class="col">
            <input name="coverUrl" id="coverUrl" value="${attr(b.coverUrl||'')}" placeholder="https://...">
            <button type="button" onclick="window._findCovers()" id="fetchBtn">Find covers</button>
            <div class="helper">Or paste any image URL above.</div>
          </div>
        </div>
        <div id="coverPicker" style="display:none;margin-top:12px"></div>
      </div>
      <div id="readFields" style="${b.status==='read'?'':'display:none'}">
        <div class="field">
          <label>Date read</label>
          <input type="date" name="dateRead" value="${attr(b.dateRead||'')}">
        </div>
        <div class="field">
          <label>Rating</label>
          <div class="rating-pick" id="ratingPick">
            ${[1,2,3,4].map(n => `<button type="button" class="dot ${(b.rating||0)>=n?'on':''}" data-r="${n}" aria-label="${n}"></button>`).join('')}
            <span class="label" id="ratingLabel">${b.rating ? RATING_LABELS[b.rating] : ''}</span>
          </div>
        </div>
      </div>
      <div class="row">
        <div class="field">
          <label>Pages</label>
          <input type="number" name="pageCount" value="${attr(b.pageCount||'')}" min="1">
        </div>
        <div class="field">
          <label>Published</label>
          <input type="date" name="publicationDate" value="${attr(b.publicationDate||'')}">
        </div>
      </div>
      <div class="field has-suggest">
        <label>Location <span style="text-transform:none;color:var(--text-mute)">(setting of the book)</span></label>
        <input name="location" id="locationInput" value="${attr(b.location||'')}" placeholder="e.g. Dublin, Ireland" autocomplete="off">
        <div class="suggest-list" id="locSuggest"></div>
        <div class="helper">Geocoded for the map on save.</div>
      </div>
      <div class="field">
        <label>Genre</label>
        <input name="genre" value="${attr(b.genre||'')}" autocomplete="off" placeholder="e.g. Love, Time-travel, Non-fiction">
      </div>
      <div class="field">
        <label>Notes</label>
        <textarea name="notes">${esc(b.notes||'')}</textarea>
      </div>
      <div class="field">
        <label>Quotes</label>
        <div id="quotes"></div>
        <button type="button" onclick="window._addQuote('')" style="margin-top:4px">+ Add quote</button>
      </div>
      <div class="action-row" style="margin-bottom:32px">
        <button type="submit" class="save-btn">Save</button>
        ${!isNew ? `<button type="button" class="danger" onclick="if(confirm('Delete this book?')){ window._del('${attr(b.id)}'); }">Delete</button>` : ''}
      </div>
    </form>
  `;
  // segments
  $$('[data-status]').forEach(btn => btn.onclick = () => {
    $$('[data-status]').forEach(x => x.classList.remove('on'));
    btn.classList.add('on');
    const isRead = btn.dataset.status === 'read';
    $('#readFields').style.display = isRead ? '' : 'none';
  });
  $$('[data-medium]').forEach(btn => btn.onclick = () => {
    $$('[data-medium]').forEach(x => x.classList.remove('on'));
    btn.classList.add('on');
  });
  // rating dots
  $$('#ratingPick .dot').forEach(d => {
    d.onclick = () => {
      const v = +d.dataset.r;
      const cur = +(getRating() || 0);
      const next = cur === v ? null : v;
      $$('#ratingPick .dot').forEach(x => x.classList.toggle('on', next ? +x.dataset.r <= next : false));
      $('#ratingLabel').textContent = next ? RATING_LABELS[next] : '';
      $('#ratingPick').dataset.value = next || '';
    };
  });
  if (b.rating) $('#ratingPick').dataset.value = b.rating;

  // quotes
  const qWrap = $('#quotes');
  const renderQuotes = (qs) => {
    qWrap.innerHTML = qs.map((q, i) => `
      <div class="quote-edit">
        <textarea data-qi="${i}">${esc(q)}</textarea>
        <button type="button" onclick="window._rmQuote(${i})">×</button>
      </div>`).join('');
    qWrap._quotes = qs;
  };
  window._addQuote = (txt) => {
    const qs = (qWrap._quotes || []).concat([txt || '']);
    renderQuotes(qs);
  };
  window._rmQuote = (i) => {
    const qs = (qWrap._quotes || []).slice();
    qs.splice(i, 1);
    renderQuotes(qs);
  };
  renderQuotes(b.quotes || []);

  // cover preview live-update on URL change
  $('#coverUrl').oninput = (e) => {
    const url = e.target.value.trim();
    $('#coverPrev').innerHTML = url
      ? `<img class="cover" src="${attr(url)}" alt="">`
      : `<div class="cover-placeholder">?</div>`;
  };

  // location autocomplete via Nominatim
  bindLocationAutocomplete();

  // helpers reachable globally
  function getRating() { return $('#ratingPick').dataset.value || null; }
  window._getRating = getRating;

  window._findCovers = async () => {
    const t = $('[name="title"]').value.trim();
    const a = $('[name="author"]').value.trim();
    if (!t) { toast('Add a title first'); return; }
    const btn = $('#fetchBtn');
    btn.innerHTML = '<span class="spin"></span> Searching…';
    btn.disabled = true;
    try {
      const results = await searchCovers(t, a);
      const picker = $('#coverPicker');
      if (!results.length) {
        picker.style.display = '';
        picker.innerHTML = `<div class="helper">No covers found. Try refining the title or author.</div>`;
        toast('No covers found');
        return;
      }
      picker.style.display = '';
      picker.innerHTML = `
        <div class="picker-hd">
          <span>Tap a cover to use it · ${results.length} results</span>
          <button type="button" onclick="document.getElementById('coverPicker').style.display='none'">Hide</button>
        </div>
        <div class="cover-picker-grid">
          ${results.map((r, i) => `
            <button type="button" class="cover-pick" data-i="${i}" title="${attr((r.title||'') + (r.author ? ' — ' + r.author : ''))}">
              <img loading="lazy" src="${attr(r.thumbUrl)}" alt="" onerror="this.style.opacity=0.2">
              <span class="meta">${attr(r.sourceShort)}${r.year ? ' · ' + r.year : ''}</span>
            </button>`).join('')}
        </div>
      `;
      // make the picker findable by the click handler
      window._coverResults = results;
      $$('.cover-pick').forEach(btn2 => btn2.onclick = () => {
        const r = window._coverResults[+btn2.dataset.i];
        $('#coverUrl').value = r.coverUrl;
        $('#coverUrl').dispatchEvent(new Event('input'));
        const fillIfBlank = (sel, val) => { if (val && !$(sel).value) $(sel).value = val; };
        fillIfBlank('[name="author"]', r.author);
        if (r.year && !$('[name="publicationDate"]').value) {
          $('[name="publicationDate"]').value = `${r.year}-01-01`;
        }
        if (r.pages && !$('[name="pageCount"]').value) {
          $('[name="pageCount"]').value = r.pages;
        }
        $$('.cover-pick').forEach(x => x.classList.remove('on'));
        btn2.classList.add('on');
        toast('Cover applied');
      });
    } catch (e) {
      toast('Lookup failed');
    } finally {
      btn.innerHTML = 'Find covers';
      btn.disabled = false;
    }
  };

  window._saveBook = async () => {
    const form = $('#bookForm');
    if (!form.reportValidity()) return;
    const fd = new FormData(form);
    const status = $('[data-status].on').dataset.status;
    const medium = $('[data-medium].on').dataset.medium;
    const updated = Object.assign({}, b, {
      title: (fd.get('title') || '').trim(),
      author: (fd.get('author') || '').trim(),
      coverUrl: (fd.get('coverUrl') || '').trim() || null,
      status,
      medium,
      dateRead: status === 'read' ? (fd.get('dateRead') || null) : null,
      rating: status === 'read' ? (+window._getRating() || null) : null,
      // DNF: no date read, no rating (per spec). Existing values cleared above.
      // bookmarked is preserved from existing book via Object.assign; toggled from detail header
      pageCount: +(fd.get('pageCount') || 0) || null,
      publicationDate: (fd.get('publicationDate') || null) || null,
      location: (fd.get('location') || '').trim() || null,
      genre: (fd.get('genre') || '').trim() || null,
      notes: (fd.get('notes') || '').trim() || null,
      quotes: ((qWrap._quotes) || []).map(q => q.trim()).filter(Boolean),
    });
    // geocode if location changed
    const prev = getBook(b.id);
    if (updated.location && (!prev || prev.location !== updated.location || prev.lat == null)) {
      try {
        const g = await geocode(updated.location);
        if (g) { updated.lat = g.lat; updated.lng = g.lng; }
      } catch {}
    } else if (!updated.location) {
      updated.lat = null; updated.lng = null;
    }
    upsertBook(updated);
    toast('Saved');
    location.hash = `#/book/${updated.id}`;
  };
}

// ---------- cover search ----------
async function searchCovers(title, author) {
  const [ol, gb] = await Promise.all([
    searchOpenLibrary(title, author).catch(() => []),
    searchGoogleBooks(title, author).catch(() => []),
  ]);
  // Interleave so the picker shows a mix at the top instead of one source first
  const merged = [];
  const maxLen = Math.max(ol.length, gb.length);
  for (let i = 0; i < maxLen; i++) {
    if (ol[i]) merged.push(ol[i]);
    if (gb[i]) merged.push(gb[i]);
  }
  return merged;
}

async function searchOpenLibrary(title, author) {
  const url = `https://openlibrary.org/search.json?title=${encodeURIComponent(title)}${author ? '&author=' + encodeURIComponent(author) : ''}&limit=8`;
  const j = await fetch(url).then(r => r.json());
  return (j.docs || [])
    .filter(d => d.cover_i)
    .map(d => ({
      source: 'Open Library',
      sourceShort: 'OL',
      coverUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      thumbUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
      title: d.title,
      author: (d.author_name || [])[0] || null,
      year: d.first_publish_year || null,
      pages: d.number_of_pages_median || null,
    }))
    .slice(0, 8);
}

async function searchGoogleBooks(title, author) {
  const q = `intitle:${title}${author ? ' inauthor:' + author : ''}`;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8&printType=books`;
  const j = await fetch(url).then(r => r.json());
  return (j.items || [])
    .filter(it => it.volumeInfo && it.volumeInfo.imageLinks)
    .map(it => {
      const vi = it.volumeInfo;
      const raw = (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail || '').replace(/^http:/, 'https:');
      // request a larger image: drop edge=curl, set zoom=0
      const big = raw.replace(/&edge=curl/, '').replace(/zoom=\d/, 'zoom=0');
      return {
        source: 'Google Books',
        sourceShort: 'GB',
        coverUrl: big,
        thumbUrl: raw,
        title: vi.title,
        author: (vi.authors || [])[0] || null,
        year: vi.publishedDate ? parseInt(vi.publishedDate.slice(0, 4), 10) || null : null,
        pages: vi.pageCount || null,
      };
    });
}

// ---------- location autocomplete (Nominatim) ----------
function nominatimDisplay(item) {
  // Build a clean "City, Region, Country" string from address parts when possible.
  const a = item.address || {};
  const place = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || a.state_district;
  const region = a.state;
  const country = a.country;
  const parts = [place, region, country].filter(Boolean);
  // Deduplicate consecutive identical parts (e.g. country == state for city-states)
  const dedup = parts.filter((p, i) => p !== parts[i - 1]);
  return dedup.length ? dedup.join(', ') : item.display_name;
}

let _locDebounce = null;
function bindLocationAutocomplete() {
  const input = $('#locationInput');
  const list = $('#locSuggest');
  if (!input || !list) return;
  let hover = -1; // keyboard index

  const closeList = () => { list.classList.remove('show'); hover = -1; };

  const fetchSuggestions = async (q) => {
    if (q.length < 3) { closeList(); return; }
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`;
      const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const j = await r.json();
      if (!Array.isArray(j) || !j.length) { closeList(); return; }
      list.innerHTML = j.map((it, i) => {
        const display = nominatimDisplay(it);
        return `<div class="suggest-item" data-i="${i}" data-display="${attr(display)}" data-lat="${attr(it.lat)}" data-lon="${attr(it.lon)}">${esc(display)}</div>`;
      }).join('');
      list.classList.add('show');
      list.querySelectorAll('.suggest-item').forEach(el => {
        // Use mousedown so we beat the input's blur event
        el.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          input.value = el.dataset.display;
          // Pre-cache the geocode so save doesn't re-query
          try {
            geocode._cache = geocode._cache || JSON.parse(localStorage.getItem('lib.geo.v1') || '{}');
            geocode._cache[el.dataset.display] = { lat: +el.dataset.lat, lng: +el.dataset.lon };
            localStorage.setItem('lib.geo.v1', JSON.stringify(geocode._cache));
          } catch {}
          closeList();
        });
      });
    } catch {
      closeList();
    }
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clearTimeout(_locDebounce);
    _locDebounce = setTimeout(() => fetchSuggestions(q), 450);
  });
  input.addEventListener('focus', () => {
    if (list.innerHTML && input.value.trim().length >= 3) list.classList.add('show');
  });
  input.addEventListener('blur', () => {
    // delay so mousedown on suggestion runs first
    setTimeout(closeList, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (!list.classList.contains('show')) return;
    const items = list.querySelectorAll('.suggest-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); hover = Math.min(hover + 1, items.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hover = Math.max(hover - 1, 0); }
    else if (e.key === 'Enter' && hover >= 0) {
      e.preventDefault();
      items[hover].dispatchEvent(new MouseEvent('mousedown'));
      return;
    } else if (e.key === 'Escape') { closeList(); return; }
    items.forEach((el, i) => el.classList.toggle('hover', i === hover));
  });
}

// ---------- geocoding (Nominatim) ----------
async function geocode(q) {
  if (!q) return null;
  // small in-memory cache
  geocode._cache = geocode._cache || JSON.parse(localStorage.getItem('lib.geo.v1') || '{}');
  if (geocode._cache[q]) return geocode._cache[q];
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  const j = await r.json();
  if (!j || !j[0]) return null;
  const out = { lat: +j[0].lat, lng: +j[0].lon };
  geocode._cache[q] = out;
  localStorage.setItem('lib.geo.v1', JSON.stringify(geocode._cache));
  return out;
}

// ---------- stats ----------
function viewStats() {
  setHeader({ title: 'Stats' });
  const read = State.books.filter(b => b.status === 'read' && b.dateRead).slice().sort((a, b) => a.dateRead.localeCompare(b.dateRead));
  const thisYear = new Date().getFullYear();

  const physicalAll = read.filter(b => b.medium !== 'audio');
  const audioAll = read.filter(b => b.medium === 'audio');
  const physicalThisYear = physicalAll.filter(b => b.dateRead.startsWith(String(thisYear)));
  const audioThisYear = audioAll.filter(b => b.dateRead.startsWith(String(thisYear)));

  // books per year — physical only
  const perYearBook = {};
  physicalAll.forEach(b => { const y = b.dateRead.slice(0, 4); perYearBook[y] = (perYearBook[y] || 0) + 1; });
  const bookYears = Object.keys(perYearBook).sort();
  const maxBook = Math.max(0, ...Object.values(perYearBook));

  // audiobooks per year
  const perYearAudio = {};
  audioAll.forEach(b => { const y = b.dateRead.slice(0, 4); perYearAudio[y] = (perYearAudio[y] || 0) + 1; });
  const audioYears = Object.keys(perYearAudio).sort();
  const maxAudio = Math.max(0, ...Object.values(perYearAudio));

  // reading pace — physical, consecutive
  const times = [];
  for (let i = 1; i < physicalAll.length; i++) {
    const a = new Date(physicalAll[i - 1].dateRead);
    const c = new Date(physicalAll[i].dateRead);
    const days = Math.max(1, Math.round((c - a) / 86400000));
    times.push({ book: physicalAll[i], days });
  }
  const withPages = times.filter(t => t.book.pageCount);
  const avgDaysPerBook = times.length ? Math.round(times.reduce((s, t) => s + t.days, 0) / times.length) : null;
  const avgPagesPerDay = withPages.length
    ? Math.round(withPages.reduce((s, t) => s + t.book.pageCount / t.days, 0) / withPages.length)
    : null;

  $('#app').innerHTML = `
    <div class="stat-hero" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:24px 0 20px">
      <div>
        <div class="n">${physicalThisYear.length}</div>
        <div class="l">books in ${thisYear}</div>
      </div>
      <div>
        <div class="n">${audioThisYear.length}</div>
        <div class="l">audiobooks in ${thisYear}</div>
      </div>
    </div>

    <div class="section-h">Books per year <span style="text-transform:none;color:var(--text-mute)">· physical</span></div>
    ${bookYears.length ? `<div class="bar-chart">
      ${bookYears.map(y => `
        <div class="bar-row">
          <div>${y}</div>
          <div class="bar"><div style="width:${(perYearBook[y]/maxBook)*100}%"></div></div>
          <div class="n">${perYearBook[y]}</div>
        </div>`).join('')}
    </div>` : `<div class="empty">No data yet.</div>`}

    <div class="section-h">Audiobooks per year</div>
    ${audioYears.length ? `<div class="bar-chart">
      ${audioYears.map(y => `
        <div class="bar-row">
          <div>${y}</div>
          <div class="bar"><div style="width:${(perYearAudio[y]/maxAudio)*100}%;background:var(--text-soft)"></div></div>
          <div class="n">${perYearAudio[y]}</div>
        </div>`).join('')}
    </div>
    <div class="meta-grid" style="margin-top:14px">
      <div><div class="k">Total audiobooks</div><div class="v">${audioAll.length}</div></div>
      <div><div class="k">This year</div><div class="v">${audioThisYear.length}</div></div>
    </div>` : `<div class="empty">No audiobooks logged yet.</div>`}

    <div class="section-h">Reading pace</div>
    <div class="meta-grid">
      <div><div class="k">Avg days / book</div><div class="v">${avgDaysPerBook ?? '—'}</div></div>
      <div><div class="k">Avg pages / day</div><div class="v">${avgPagesPerDay ?? '—'}</div></div>
    </div>
    <div style="height:32px"></div>
  `;
}

// ---------- map ----------
function viewMap() {
  setHeader({ title: 'Map' });
  $('#app').innerHTML = `<div id="map"></div>`;
  if (typeof L === 'undefined') {
    $('#app').innerHTML = `<div class="empty">Map library failed to load.</div>`;
    return;
  }
  const map = L.map('map', {
    zoomControl: true,
    scrollWheelZoom: true,
    worldCopyJump: true,
    minZoom: 2,
    maxBounds: [[-85, -200], [85, 200]],
    maxBoundsViscosity: 1.0,
  }).setView([30, 10], 3);
  window._map = map;
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    minZoom: 2,
    attribution: '&copy; OpenStreetMap',
    noWrap: false,
  }).addTo(map);
  const pts = State.books.filter(b => b.lat != null && b.lng != null);
  const ungeocoded = State.books.filter(b => b.location && b.lat == null);
  const group = L.featureGroup();
  pts.forEach(b => {
    const m = L.marker([b.lat, b.lng]);
    m.bindPopup(`<strong>${esc(b.title)}</strong><br>${esc(b.author||'')}<br><a href="#/book/${attr(b.id)}">View →</a>`);
    m.addTo(group);
  });
  group.addTo(map);
  if (pts.length) {
    // tight padding + maxZoom cap so a single cluster doesn't zoom to street level
    map.fitBounds(group.getBounds(), { padding: [24, 24], maxZoom: 6 });
  }
  // ensure tiles are sized correctly once the container is visible
  setTimeout(() => map.invalidateSize(), 60);

  if (ungeocoded.length) {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:absolute;top:8px;left:8px;right:8px;z-index:1000;background:var(--surface);padding:8px 12px;border:1px solid var(--line-strong);border-radius:6px;font-size:12px;display:flex;gap:8px;align-items:center;';
    banner.innerHTML = `<span>${ungeocoded.length} book${ungeocoded.length>1?'s':''} need geocoding</span><button style="width:auto;padding:4px 10px;font-size:12px" id="geoAll">Geocode all</button>`;
    $('#map').appendChild(banner);
    $('#geoAll').onclick = async () => {
      $('#geoAll').textContent = 'Working…';
      $('#geoAll').disabled = true;
      let ok = 0;
      for (const b of ungeocoded) {
        try {
          const g = await geocode(b.location);
          if (g) {
            b.lat = g.lat; b.lng = g.lng; b.updatedAt = nowIso();
            State.dirty = true;
            ok++;
          }
        } catch {}
        await new Promise(r => setTimeout(r, 1100)); // respect Nominatim rate limit
      }
      persist();
      scheduleAutoSync();
      toast(`Geocoded ${ok}`);
      route(); // re-render map
    };
  }
}

// ---------- challenges ----------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

function stripArticle(s) {
  return String(s || '').replace(/^(the|a|an)\s+/i, '').trim();
}
function firstLetter(s) {
  const t = stripArticle(s);
  const m = t.match(/[A-Za-z]/);
  return m ? m[0].toUpperCase() : null;
}
function extractCountry(loc) {
  if (!loc) return null;
  // take last comma-separated chunk as country (handles "Dublin, Ireland" → "Ireland")
  const parts = String(loc).split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function challengeProgress(ch) {
  const books = State.books;
  switch (ch.type) {
    case 'checklist': {
      const items = (ch.items || []).map(it => {
        const match = books.find(b => normTitle(b.title) === normTitle(it.text));
        const done = match ? match.status === 'read' : !!it.done;
        return { text: it.text || '', done, match };
      });
      const done = items.filter(it => it.done).length;
      return { done, total: items.length, items };
    }
    case 'alphabet': {
      const read = books.filter(b => b.status === 'read');
      const letters = {};
      ALPHABET.forEach(L => letters[L] = null);
      // sort by date read so the earliest match for each letter wins
      read.slice().sort((a, b) => (a.dateRead || '').localeCompare(b.dateRead || '')).forEach(b => {
        const L = firstLetter(b.title);
        if (L && letters[L] == null) letters[L] = b;
      });
      const done = ALPHABET.filter(L => letters[L]).length;
      return { done, total: 26, letters };
    }
    case 'country': {
      const countries = new Map(); // country -> {books:[], read:0}
      books.forEach(b => {
        const c = extractCountry(b.location);
        if (!c) return;
        if (!countries.has(c)) countries.set(c, { books: [], read: 0 });
        const e = countries.get(c);
        e.books.push(b);
        if (b.status === 'read') e.read++;
      });
      // only count countries with at least one read book toward "done"
      const done = [...countries.values()].filter(e => e.read > 0).length;
      const list = [...countries.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, e]) => ({ name, books: e.books, read: e.read }));
      return { done, total: list.length, list };
    }
    case 'author': {
      const target = (ch.target || '').toLowerCase().trim();
      const matches = books.filter(b => (b.author || '').toLowerCase().trim() === target);
      const read = matches.filter(b => b.status === 'read').length;
      return { done: read, total: matches.length, list: matches };
    }
    case 'genre': {
      const target = (ch.target || '').toLowerCase().trim();
      const matches = books.filter(b => (b.genre || '').toLowerCase().includes(target));
      const read = matches.filter(b => b.status === 'read').length;
      return { done: read, total: matches.length, list: matches };
    }
    default:
      return { done: 0, total: 0 };
  }
}

function viewChallenges() {
  setHeader({
    title: 'Challenges',
    right: `<a href="#/challenge/new" class="icon-btn" aria-label="New challenge"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></a>`
  });
  const list = State.challenges || [];
  if (!list.length) {
    $('#app').innerHTML = `<div class="empty">No challenges yet. Tap + to create one.</div>`;
    return;
  }
  $('#app').innerHTML = `<div>${list.map(challengeCard).join('')}</div>`;
}

function challengeCard(ch) {
  const p = challengeProgress(ch);
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  let body = '';
  switch (ch.type) {
    case 'checklist':
      body = p.items.length
        ? `<ul class="ch-list">
            ${p.items.map((it, i) => `
              <li>
                <span class="mark" onclick="event.stopPropagation();window._toggleChecklistItem('${attr(ch.id)}', ${i})" style="cursor:pointer">${it.done ? '✓' : '○'}</span>
                <span class="title ${it.done?'done':''}" ${it.match ? `onclick="event.stopPropagation();location.hash='#/book/${attr(it.match.id)}'" style="cursor:pointer"` : ''}>${esc(it.text)}</span>
                ${it.match ? `<span class="ch-status-pill ${it.match.status==='read'?'read':''}">${it.match.status==='read'?'read':'tbr'}</span>` : '<span></span>'}
              </li>`).join('')}
          </ul>`
        : `<div class="helper">Tap ⋯ to add items.</div>`;
      break;
    case 'alphabet':
      body = `
        <div class="alpha-grid">
          ${ALPHABET.map(L => `
            <div class="alpha-cell ${p.letters[L] ? 'on' : ''}"
                 ${p.letters[L] ? `onclick="event.stopPropagation();location.hash='#/book/${attr(p.letters[L].id)}'"` : ''}
                 title="${p.letters[L] ? attr(p.letters[L].title) : ''}">${L}</div>`).join('')}
        </div>`;
      break;
    case 'country':
      body = `
        <ul class="ch-list">
          ${p.list.slice(0, 50).map(c => `
            <li>
              <span class="mark">${c.read ? '✓' : '·'}</span>
              <span class="title">${esc(c.name)}</span>
              <span class="sub">${c.read}${c.books.length > c.read ? '+'+(c.books.length-c.read)+' TBR' : ''}</span>
            </li>`).join('')}
        </ul>`;
      break;
    case 'author':
    case 'genre':
      body = p.list.length
        ? `<ul class="ch-list">
            ${p.list.slice(0, 20).map(b => `
              <li onclick="event.stopPropagation();location.hash='#/book/${attr(b.id)}'">
                <span class="mark">${b.status==='read'?'✓':'·'}</span>
                <span class="title">${esc(b.title)}</span>
                <span class="ch-status-pill ${b.status==='read'?'read':b.status==='dnf'?'dnf':''}">${b.status==='read'?'read':b.status==='dnf'?'dnf':'tbr'}</span>
              </li>`).join('')}
          </ul>`
        : `<div class="helper">No matching books in your library yet.</div>`;
      break;
  }
  const progressText = ch.type === 'country' || ch.type === 'author' || ch.type === 'genre'
    ? `${p.done}${p.total ? ' / ' + p.total : ''}`
    : p.total === 0 ? '0' : `${p.done} / ${p.total}`;
  return `
    <div class="ch-card">
      <button class="ch-menu-btn" onclick="location.hash='#/challenge/${attr(ch.id)}/edit'" aria-label="Edit challenge" title="Edit or delete">
        <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="1.6" fill="none"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
      <div class="ch-hd ch-hd-link" onclick="location.hash='#/challenge/${attr(ch.id)}/edit'">
        <div class="ch-name">${esc(ch.name)}</div>
        <div class="ch-progress">${progressText}</div>
      </div>
      ${ch.description ? `<div class="ch-desc">${esc(ch.description)}</div>` : ''}
      ${p.total ? `<div class="ch-bar"><div style="width:${pct}%"></div></div>` : ''}
      ${body}
    </div>`;
}

function viewChallengeEdit(id) {
  const isNew = !id;
  const ch = isNew
    ? { id: 'ch_' + uid(), type: 'checklist', name: '', description: '', target: '', items: [] }
    : Object.assign({ items: [] }, (State.challenges || []).find(c => c.id === id));
  if (!isNew && !ch.id) { $('#app').innerHTML = `<div class="empty">Not found</div>`; return; }
  setHeader({
    title: isNew ? 'New challenge' : 'Edit challenge',
    back: true,
    right: `<button class="icon-btn" onclick="window._saveChallenge()" aria-label="Save"><svg viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" fill="none"><path d="M5 13l4 4L19 7"/></svg></button>`
  });
  $('#app').innerHTML = `
    <form class="form" onsubmit="event.preventDefault();window._saveChallenge();" id="chForm">
      <div class="field">
        <label>Type</label>
        <select name="type" id="chType">
          <option value="checklist" ${ch.type==='checklist'?'selected':''}>Checklist — your own items, tick off manually</option>
          <option value="alphabet" ${ch.type==='alphabet'?'selected':''}>Alphabet — one book per letter</option>
          <option value="country" ${ch.type==='country'?'selected':''}>Country — books by country</option>
          <option value="author" ${ch.type==='author'?'selected':''}>Author — all books by an author</option>
          <option value="genre" ${ch.type==='genre'?'selected':''}>Genre — books in a genre</option>
        </select>
      </div>
      <div class="field">
        <label>Name</label>
        <input name="name" value="${attr(ch.name)}" placeholder="e.g. Booker shortlist 2024" required>
      </div>
      <div class="field" id="targetField" style="${(ch.type==='author'||ch.type==='genre')?'':'display:none'}">
        <label>Target <span style="text-transform:none;color:var(--text-mute)" id="targetHint">(author name)</span></label>
        <input name="target" value="${attr(ch.target||'')}" placeholder="e.g. Margaret Atwood">
      </div>
      <div class="field" id="itemsField" style="${ch.type==='checklist'?'':'display:none'}">
        <label>Items <span style="text-transform:none;color:var(--text-mute)">(one per line — titles auto-link to your library)</span></label>
        <textarea name="items" id="itemsTa" rows="8" placeholder="e.g.&#10;The Safekeep&#10;Orbital&#10;James">${esc((ch.items||[]).map(it => it.text).join('\n'))}</textarea>
      </div>
      <div class="field">
        <label>Description</label>
        <textarea name="description" rows="2">${esc(ch.description||'')}</textarea>
      </div>
      <div class="action-row" style="margin-bottom:32px">
        <button type="submit" class="save-btn">Save</button>
        ${!isNew ? `<button type="button" class="danger" onclick="if(confirm('Delete this challenge?')){ window._delChallenge('${attr(ch.id)}'); }">Delete</button>` : ''}
      </div>
    </form>
  `;
  $('#chType').onchange = e => {
    const t = e.target.value;
    $('#targetField').style.display = (t === 'author' || t === 'genre') ? '' : 'none';
    $('#itemsField').style.display = t === 'checklist' ? '' : 'none';
    $('#targetHint').textContent = t === 'author' ? '(author name)' : '(genre name — substring match)';
  };
}

window._saveChallenge = () => {
  const form = $('#chForm');
  if (!form.reportValidity()) return;
  const fd = new FormData(form);
  // figure out id from URL hash if editing
  const m = location.hash.match(/^#\/challenge\/([^/]+)\/edit$/);
  const editId = m ? m[1] : null;
  const finalId = editId || 'ch_' + uid();
  const type = fd.get('type');
  const updated = {
    id: finalId,
    type,
    name: (fd.get('name') || '').trim(),
    description: (fd.get('description') || '').trim() || null,
  };
  const target = (fd.get('target') || '').trim();
  if (target) updated.target = target;
  if (type === 'checklist') {
    // Preserve done state for items that still exist (match by text)
    const existing = (State.challenges || []).find(c => c.id === finalId);
    const oldItems = existing && existing.items ? existing.items : [];
    const newTexts = (fd.get('items') || '').split('\n').map(s => s.trim()).filter(Boolean);
    updated.items = newTexts.map(text => {
      const prior = oldItems.find(it => (it.text || '').trim() === text);
      return { text, done: prior ? !!prior.done : false };
    });
  }
  if (!State.challenges) State.challenges = [];
  const i = State.challenges.findIndex(c => c.id === finalId);
  if (i >= 0) State.challenges[i] = updated; else State.challenges.push(updated);
  State.dirty = true;
  persist();
  scheduleAutoSync();
  toast('Saved');
  location.hash = '#/challenges';
};

window._toggleChecklistItem = (chId, idx) => {
  const ch = (State.challenges || []).find(c => c.id === chId);
  if (!ch || !ch.items || !ch.items[idx]) return;
  const item = ch.items[idx];
  // If this item is auto-linked to a book in the library, don't override — show toast
  const match = State.books.find(b => normTitle(b.title) === normTitle(item.text));
  if (match) {
    toast(`"${item.text}" auto-tracks your library — change the book's status to mark complete`);
    return;
  }
  item.done = !item.done;
  State.dirty = true;
  persist();
  scheduleAutoSync();
  if (location.hash === '#/challenges') route();
};

window._delChallenge = (id) => {
  State.challenges = (State.challenges || []).filter(c => c.id !== id);
  State.dirty = true;
  persist();
  scheduleAutoSync();
  toast('Deleted');
  location.hash = '#/challenges';
};

// ---------- settings ----------
function viewSettings() {
  setHeader({ title: 'Settings' });
  const cfg = State.config;
  const pat = getPat();
  const masked = pat ? '•'.repeat(Math.min(20, pat.length)) : '';
  $('#app').innerHTML = `
    <div class="group">
      <h3>GitHub Sync</h3>
      <p>Push your books.json to a repo so it syncs across devices and lives in version control.</p>
      <div class="row">
        <div class="field"><label>Owner</label><input id="cfgOwner" value="${attr(cfg.owner||'')}" placeholder="your-username"></div>
        <div class="field"><label>Repo</label><input id="cfgRepo" value="${attr(cfg.repo||'')}" placeholder="library"></div>
      </div>
      <div class="row">
        <div class="field"><label>Branch</label><input id="cfgBranch" value="${attr(cfg.branch||'main')}"></div>
        <div class="field"><label>Path</label><input id="cfgPath" value="${attr(cfg.path||'books.json')}"></div>
      </div>
      <div class="field">
        <label>Personal access token <span style="text-transform:none;color:var(--text-mute)">(fine-grained, with Contents: read & write on this repo)</span></label>
        <input id="cfgPat" type="password" placeholder="${pat ? masked : 'ghp_...'}" autocomplete="off">
        <div class="helper">Stored locally on this device only. Leave blank to keep existing.</div>
      </div>
      <div class="action-row">
        <button onclick="window._saveCfg()">Save settings</button>
        <button class="save-btn" onclick="window._sync()" id="syncBtn">
          ${State.dirty ? 'Sync to GitHub (unsaved)' : 'Sync to GitHub'}
        </button>
      </div>
    </div>

    <div class="group">
      <h3>Import / Export</h3>
      <p>Download your library as JSON, or restore from a JSON file.</p>
      <div class="action-row">
        <button onclick="window._exportJson()">Export books.json</button>
        <button onclick="document.getElementById('importFile').click()">Import JSON</button>
        <input type="file" id="importFile" accept=".json,application/json" hidden onchange="window._importJson(event)">
      </div>
    </div>

    <div class="group">
      <h3>Kindle highlights</h3>
      <p>Upload your <code>My Clippings.txt</code> from a Kindle. Highlights are matched to books by title and added as quotes.</p>
      <input type="file" id="kindleFile" class="file-input" accept=".txt,text/plain">
      <div class="helper">To export: plug your Kindle into a computer, open the device drive, copy <code>documents/My Clippings.txt</code>.</div>
      <div id="kindlePreview" style="margin-top:10px"></div>
    </div>

    <div class="group">
      <h3>Reset</h3>
      <p>Reload books from the repo's books.json, discarding any local-only edits.</p>
      <div class="action-row">
        <button class="danger" onclick="window._resetLocal()">Discard local edits</button>
      </div>
    </div>

    <div style="text-align:center;color:var(--text-mute);font-size:12px;padding:24px 0">
      ${State.books.length} books · ${State.dirty ? 'unsaved changes' : 'in sync'}
    </div>
  `;
  $('#kindleFile').onchange = window._kindleImport;
}

window._saveCfg = () => {
  State.config.owner = $('#cfgOwner').value.trim();
  State.config.repo = $('#cfgRepo').value.trim();
  State.config.branch = $('#cfgBranch').value.trim() || 'main';
  State.config.path = $('#cfgPath').value.trim() || 'books.json';
  const newPat = $('#cfgPat').value.trim();
  if (newPat) setPat(newPat);
  saveConfig();
  toast('Settings saved');
};

window._exportJson = () => {
  const doc = { version: 2, updatedAt: nowIso(), books: State.books, challenges: State.challenges };
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'books.json'; a.click();
  URL.revokeObjectURL(url);
};

window._importJson = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const doc = JSON.parse(r.result);
      const incoming = doc.books || (Array.isArray(doc) ? doc : null);
      if (!Array.isArray(incoming)) throw new Error('Invalid file');
      if (!confirm(`Replace ${State.books.length} books with ${incoming.length} from file?`)) return;
      State.books = incoming;
      if (Array.isArray(doc.challenges)) State.challenges = doc.challenges;
      State.dirty = true;
      persist();
      toast('Imported');
      route();
    } catch (err) {
      toast('Bad JSON');
    }
  };
  r.readAsText(file);
};

window._resetLocal = async () => {
  if (!confirm('Discard all local edits and reload from repo books.json?')) return;
  localStorage.removeItem(STORE_KEY);
  await loadBooks();
  toast('Reloaded');
  route();
};

// GitHub sync core (reusable for manual + auto)
async function pushToGitHub() {
  const cfg = State.config;
  const pat = getPat();
  if (!cfg.owner || !cfg.repo) throw new Error('Repo not configured');
  if (!pat) throw new Error('No PAT configured');
  const api = `https://api.github.com/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${encodeURIComponent(cfg.path)}`;
  let sha = null;
  const head = await fetch(`${api}?ref=${encodeURIComponent(cfg.branch)}`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' }
  });
  if (head.status === 200) {
    sha = (await head.json()).sha;
  } else if (head.status !== 404) {
    throw new Error(`HEAD ${head.status}`);
  }
  const doc = { version: 2, updatedAt: nowIso(), books: State.books, challenges: State.challenges };
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(doc, null, 2))));
  const put = await fetch(api, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Update books.json (${State.books.length} books)`,
      content,
      branch: cfg.branch,
      sha: sha || undefined,
    }),
  });
  if (!put.ok) {
    const t = await put.text();
    throw new Error(`PUT ${put.status}: ${t.slice(0, 120)}`);
  }
  State.dirty = false;
  persist();
}

// Auto-sync: debounced, single-flight, silent on success
let _syncTimer = null;
let _syncing = false;
let _syncAgain = false;
function scheduleAutoSync(delayMs = 2500) {
  if (!getPat()) return;                // not configured
  if (!State.config.owner || !State.config.repo) return;
  if (!navigator.onLine) return;
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(autoSync, delayMs);
}
async function autoSync() {
  if (!State.dirty) return;
  if (_syncing) { _syncAgain = true; return; }
  _syncing = true;
  try {
    await pushToGitHub();
    // re-render any visible sync indicator (library footer, settings)
    const hash = location.hash || '#/';
    if (hash === '#/' || hash === '#/settings') route();
  } catch (e) {
    console.warn('Auto-sync failed', e);
    toast('Auto-sync failed: ' + e.message, 3000);
  } finally {
    _syncing = false;
    if (_syncAgain) { _syncAgain = false; setTimeout(autoSync, 800); }
  }
}
// Retry queued sync when the device comes back online
window.addEventListener('online', () => { if (State.dirty) scheduleAutoSync(500); });

// Manual sync button — same core, with UI feedback
window._sync = async () => {
  const cfg = State.config;
  const pat = getPat();
  if (!cfg.owner || !cfg.repo) { toast('Set owner & repo first'); return; }
  if (!pat) { toast('Add a personal access token first'); return; }
  const btn = $('#syncBtn');
  btn.innerHTML = '<span class="spin"></span> Syncing…';
  btn.disabled = true;
  try {
    await pushToGitHub();
    toast('Synced to GitHub');
    route();
  } catch (e) {
    console.error(e);
    toast('Sync failed: ' + e.message, 3000);
  } finally {
    btn.disabled = false;
  }
};

// Kindle My Clippings.txt parser
// Format: each clipping is 5 lines, separated by ==========
//   Title (Author)
//   - Your Highlight on page X | Location ... | Added on ...
//   <blank>
//   Highlighted text
//   ==========
window._kindleImport = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    const items = parseClippings(r.result);
    const grouped = {};
    items.forEach(it => {
      const key = normTitle(it.title);
      if (!grouped[key]) grouped[key] = { title: it.title, author: it.author, quotes: [] };
      if (it.kind === 'highlight' && it.text) grouped[key].quotes.push(it.text);
    });
    // match
    const norm = s => normTitle(s);
    const matches = Object.values(grouped).map(g => {
      const match = State.books.find(b => norm(b.title) === norm(g.title));
      return { ...g, match };
    });
    const preview = $('#kindlePreview');
    preview.innerHTML = `
      <div class="helper">Parsed ${items.length} clippings · ${matches.length} books · ${matches.filter(m=>m.match).length} matched in your library.</div>
      <ul style="list-style:none;padding:0;margin:8px 0;max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:var(--radius)">
        ${matches.map((m, i) => `
          <li style="padding:8px 10px;border-bottom:1px solid var(--line);display:flex;gap:8px;align-items:center">
            <input type="checkbox" data-i="${i}" ${m.match ? 'checked' : ''} ${m.match ? '' : 'disabled'} style="width:auto">
            <div style="flex:1;font-size:13px">
              <div>${esc(m.title)} <span style="color:var(--text-mute)">${esc(m.author||'')}</span></div>
              <div style="color:var(--text-mute);font-size:11px">${m.quotes.length} quote${m.quotes.length===1?'':'s'} · ${m.match ? 'matched' : 'no match'}</div>
            </div>
          </li>`).join('')}
      </ul>
      <button id="applyKindle">Add ${matches.filter(m=>m.match).length} matched as quotes</button>
    `;
    $('#applyKindle').onclick = () => {
      let added = 0;
      $$('#kindlePreview input:checked').forEach(cb => {
        const m = matches[+cb.dataset.i];
        if (!m.match) return;
        const b = getBook(m.match.id);
        const existing = new Set((b.quotes || []).map(q => q.trim()));
        m.quotes.forEach(q => { if (!existing.has(q.trim())) { b.quotes = (b.quotes || []).concat([q]); existing.add(q.trim()); added++; } });
        upsertBook(b);
      });
      toast(`Added ${added} quotes`);
      route();
    };
  };
  r.readAsText(file);
};

function parseClippings(txt) {
  // Strip BOM
  if (txt.charCodeAt(0) === 0xFEFF) txt = txt.slice(1);
  const blocks = txt.split(/\r?\n=+\r?\n/);
  const out = [];
  for (const raw of blocks) {
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const header = lines[0];
    const meta = lines[1];
    const text = lines.slice(2).join('\n').trim();
    // Title (Author) — author in trailing parens
    let title = header, author = '';
    const am = header.match(/^(.*)\s+\(([^)]+)\)\s*$/);
    if (am) { title = am[1].trim(); author = am[2].trim(); }
    let kind = 'highlight';
    if (/Bookmark/i.test(meta)) kind = 'bookmark';
    else if (/Note/i.test(meta)) kind = 'note';
    out.push({ title, author, kind, text });
  }
  return out;
}
function normTitle(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').trim();
}

// ---------- bootstrap ----------
(async () => {
  await loadBooks();
  if (!location.hash) location.hash = '#/';
  route();
})();

})();
