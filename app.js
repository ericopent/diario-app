'use strict';

// Diário: SPA estática. As entradas vivem num repo privado do GitHub e são lidas e gravadas
// pela API REST com um token fine-grained guardado só neste navegador. Uma Action do repo gera
// index.json (título, tags, área, humor…) e graph.json (afinidade semântica e constelações).

const CFG_KEY = 'diario.cfg';
const DRAFT_KEY = 'diario.draft';
const DEFAULT_CFG = { token: '', repo: 'ericopent/diario', branch: 'main' };
const CACHE_TTL_MS = 30_000;
const POLL_MS = 20_000;
const POLL_MAX = 15;
const AREA_LABEL = { trabalho: 'Trabalho', pessoal: 'Pessoal' };
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

let cfg = { ...DEFAULT_CFG, ...store.get(CFG_KEY, {}) };
let cache = null;      // { entries, byPath, graph, hasGraph, loadedAt }
const areaChosen = new Map();  // área corrigida nesta sessão, até a Action refletir no index.json
let pollTimer = null;
let cleanup = null;    // a tela atual pode registrar uma função de saída (parar animação etc.)
let viewSeq = 0;       // muda a cada navegação; telas assíncronas checam antes de escrever

const $view = document.getElementById('view');
const $ = sel => $view.querySelector(sel);

// ---------- utilidades ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fold = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const wordCount = s => (s.trim().match(/\S+/g) || []).length;
const plural = (n, one, many) => `${n.toLocaleString('pt-BR')} ${n === 1 ? one : many}`;
const fmtNum = (n, digits = 1) => n.toFixed(digits).replace('.', ',');

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

const entryId = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
  `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const entryPath = d => `entries/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${entryId(d)}.md`;

function dateFromPath(path) {
  const m = path.match(/(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.md$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

const fmtFull = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'full', timeStyle: 'short' });
const fmtShort = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDayMonth = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtMonthName = new Intl.DateTimeFormat('pt-BR', { month: 'long' });
const shortWhen = d => `${fmtShort.format(d).replace(/\./g, '')} · ${fmtTime.format(d)}`;
const dayMonth = d => fmtDayMonth.format(d).replace(/\./g, '');

function b64encode(text) {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}
const b64decode = b64 =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

function parseEntry(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function serializeEntry(meta, body) {
  const head = Object.entries(meta).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${head}\n---\n\n${body.trim()}\n`;
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

let toastTimer;
function toast(msg, { href, error } = {}) {
  const el = document.getElementById('toast');
  el.innerHTML = esc(msg) + (href ? ` <a href="${esc(href)}">ver</a>` : '');
  el.className = `show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, error ? 7000 : 4000);
}

// ---------- ícones (traço único 1.6) ----------

const ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  back: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  sky: '<circle cx="5" cy="17" r="1.6"/><circle cx="10" cy="7" r="1.6"/><circle cx="18" cy="5" r="1.6"/>' +
    '<circle cx="16" cy="16" r="1.6"/><path d="m5.8 15.5 3.4-7M11.6 6.6l4.8-1.2M17.7 6.6l-1.4 7.8M6.6 16.8l7.8-.6"/>',
};
const icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
  `stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

// ---------- GitHub API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const gh = (path, opts) => api(`/repos/${cfg.repo}${path}`, opts);

async function api(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    cache: 'no-cache',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch {}
    throw new ApiError(res.status, msg);
  }
  return res;
}

function errMsg(e) {
  if (!(e instanceof ApiError)) return 'Sem conexão com o GitHub. O rascunho continua salvo neste aparelho.';
  switch (e.status) {
    case 401: return 'Token inválido ou expirado. Atualize em Configuração.';
    case 403: return 'Sem permissão: o token precisa de Contents: Read and write neste repo.';
    case 404: return 'Repo ou arquivo não encontrado (ou o token não tem acesso a ele).';
    case 409: case 422: return 'Conflito: o arquivo mudou no GitHub. Recarregue e tente de novo.';
    default: return `Erro do GitHub (${e.status}): ${e.message}`;
  }
}

const ref = () => `ref=${encodeURIComponent(cfg.branch)}`;
const encPath = p => p.split('/').map(encodeURIComponent).join('/');

async function loadAll() {
  const optional = p => p.catch(e => { if (e.status === 404) return null; throw e; });
  const [tree, index, graph] = await Promise.all([
    gh(`/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`).then(r => r.json()),
    optional(gh(`/contents/index.json?${ref()}`, { raw: true }).then(r => r.json())),
    optional(gh(`/contents/graph.json?${ref()}`, { raw: true }).then(r => r.json())),
  ]);
  const meta = index?.entries || {};
  const g = { links: [], neighbors: {}, clusters: [], ...(graph || {}) };
  const clusterOf = new Map();
  for (const c of g.clusters) for (const m of c.members) clusterOf.set(m, c);
  const entries = tree.tree
    .filter(n => n.type === 'blob' && n.path.startsWith('entries/') && n.path.endsWith('.md'))
    .map(n => ({
      ...(meta[n.path] || {}),
      path: n.path,
      date: dateFromPath(n.path),
      enriched: !!meta[n.path],
      cluster: clusterOf.get(n.path) || null,
      ...(areaChosen.has(n.path) ? { area: areaChosen.get(n.path) } : {}),
    }))
    .filter(e => e.date)
    .sort((a, b) => b.date - a.date);
  cache = { entries, byPath: new Map(entries.map(e => [e.path, e])), graph: g, hasGraph: !!graph, loadedAt: Date.now() };
  return cache;
}

const getData = () => (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS ? Promise.resolve(cache) : loadAll());

async function getEntry(path) {
  const json = await gh(`/contents/${encPath(path)}?${ref()}`).then(r => r.json());
  return { sha: json.sha, ...parseEntry(b64decode(json.content)) };
}

function putEntry(path, text, sha, message) {
  cache = null;
  return gh(`/contents/${encPath(path)}`, {
    method: 'PUT',
    body: { message, content: b64encode(text), branch: cfg.branch, ...(sha ? { sha } : {}) },
  });
}

function deleteEntry(path, sha) {
  cache = null;
  return gh(`/contents/${encPath(path)}`, {
    method: 'DELETE',
    body: { message: `apaga ${path.split('/').pop()}`, sha, branch: cfg.branch },
  });
}

// ---------- pedaços de UI ----------

const errorBox = e => `<p class="error-box">${esc(e instanceof ApiError || !e?.message ? errMsg(e) : e.message)}</p>`;

function segHtml(opts, active) {
  return opts.map(o => `<button type="button" role="tab" aria-selected="${o.v === active}" data-v="${esc(o.v)}">` +
    `${o.dot ? `<i class="dot dot-${o.dot}"></i>` : ''}${esc(o.label)}` +
    `${o.n != null ? `<span class="n">${o.n}</span>` : ''}</button>`).join('');
}

function moodMeter(v, mood) {
  if (typeof v !== 'number') return '';
  const lvl = v + 3;
  const label = `humor: ${mood || ''} (${v > 0 ? '+' : ''}${v})`;
  return `<span class="meter" title="${esc(label)}" aria-label="${esc(label)}">` +
    `${[1, 2, 3, 4, 5].map(i => `<i${i <= lvl ? ' class="on"' : ''}></i>`).join('')}</span>`;
}

function cardHtml(e, i) {
  const href = `#/e/${encodeURIComponent(e.path)}`;
  const style = `style="--i:${Math.min(i, 14)}"`;
  if (!e.enriched) {
    return `<a class="card is-pending" href="${href}" ${style}>
        <div class="card-top"><span class="when">${esc(shortWhen(e.date))}</span></div>
        <p class="pending-label">a IA está lendo…</p><span class="sk"></span><span class="sk short"></span>
      </a>`;
  }
  return `<a class="card" href="${href}" ${style}>
      <div class="card-top">
        <span class="when"><i class="dot dot-${esc(e.area || 'none')}"></i>${esc(shortWhen(e.date))}</span>
        <span class="kind">${esc(e.kind || '')}</span>
      </div>
      <h3>${esc(e.title)}</h3>
      ${e.summary ? `<p class="summary">${esc(e.summary)}</p>` : ''}
      <div class="card-foot">
        <div class="tags">${(e.tags || []).slice(0, 4).map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        ${moodMeter(e.valence, e.mood)}
      </div>
    </a>`;
}

const skeletonCards = n => `<div class="masonry" style="--cols:1">${'<div class="card is-skeleton"><span class="sk"></span><span class="sk tall"></span><span class="sk short"></span></div>'.repeat(n)}</div>`;

function masonry(cards) {
  const w = $view.clientWidth;
  const n = w >= 1080 ? 3 : w >= 700 ? 2 : 1;
  const cols = Array.from({ length: n }, () => []);
  cards.forEach((c, i) => cols[i % n].push(c));  // round-robin: a ordem cronológica lê da esquerda p/ direita
  return `<div class="masonry" style="--cols:${n}">${cols.map(c => `<div class="col">${c.join('')}</div>`).join('')}</div>`;
}

function spotlight(container) {
  container.addEventListener('pointermove', ev => {
    const card = ev.target.closest('.card, .near-card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${ev.clientX - r.left}px`);
    card.style.setProperty('--my', `${ev.clientY - r.top}px`);
  });
}

function bindCtrlEnter(ta, btn) {
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });
}

// ---------- Escrever: a página do dia ----------

// Data escrita como num caderno: "Terça-feira, 13 de outubro".
const fmtDayTitle = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const dayTitle = d => { const s = fmtDayTitle.format(d); return s[0].toUpperCase() + s.slice(1); };
const saveKey = `${isMac ? '⌘' : 'Ctrl'} ↵`;

// Escrever e editar são telas calmas: sem aura nem poeira; enquanto se digita, o cabeçalho some
// e volta quando o mouse se mexe (ou com Esc).
function quietMode(ta) {
  document.body.classList.add('quiet');
  ambient.pause();
  const wake = () => document.body.classList.remove('typing');
  let last = null;
  const onMove = ev => {
    if (last && Math.hypot(ev.clientX - last[0], ev.clientY - last[1]) > 6) wake();
    last = [ev.clientX, ev.clientY];
  };
  window.addEventListener('pointermove', onMove);
  ta.addEventListener('input', () => document.body.classList.add('typing'));
  ta.addEventListener('keydown', e => { if (e.key === 'Escape') wake(); });
  return { wake, stop() { window.removeEventListener('pointermove', onMove); document.body.classList.remove('quiet', 'typing'); ambient.resume(); } };
}

function dayPage({ date, stamp, text, placeholder, aria, saveLabel, leftSlot }) {
  return `
    <section class="page day">
      <header class="day-head">
        <span class="day-year">${date.getFullYear()}</span>
        <h1 class="day-title">${esc(dayTitle(date))}</h1>
      </header>
      <ol class="day-log" id="log" aria-label="Pensamentos deste dia"></ol>
      <div class="day-now">
        <time class="stamp now" id="clock">${esc(stamp)}</time>
        <textarea id="body" class="paper" placeholder="${esc(placeholder)}" aria-label="${esc(aria)}">${esc(text)}</textarea>
      </div>
      <footer class="day-bar">
        ${leftSlot}
        <button id="save" class="save" type="button">${esc(saveLabel)} <kbd>${saveKey}</kbd></button>
      </footer>
    </section>`;
}

function viewWrite() {
  const seq = viewSeq;
  const today = new Date();
  $view.innerHTML = dayPage({
    date: today, stamp: fmtTime.format(today), text: store.get(DRAFT_KEY, ''),
    placeholder: 'Escreva aqui.', aria: 'Novo pensamento', saveLabel: 'Guardar',
    leftSlot: '<span class="day-status" id="status"></span>',
  });
  const ta = $('#body'), status = $('#status'), btn = $('#save'), clock = $('#clock'), log = $('#log');
  const quiet = quietMode(ta);
  const clockTimer = setInterval(() => { clock.textContent = fmtTime.format(new Date()); }, 20_000);
  cleanup = () => { clearInterval(clockTimer); quiet.stop(); };

  // O registro do dia: o que já foi escrito hoje, em ordem, com a hora na margem.
  const items = new Map();
  const renderLog = () => {
    log.innerHTML = [...items.values()].sort((a, b) => a.date - b.date).map(e => `
      <li${e.fresh ? ' class="fresh"' : ''}><a href="#/e/${encodeURIComponent(e.path)}">
        <time class="stamp">${e.area ? `<i class="dot dot-${esc(e.area)}"></i>` : ''}${esc(fmtTime.format(e.date))}</time>
        <p>${e.excerpt ? esc(e.excerpt) : '<em>a IA ainda está lendo este.</em>'}</p>
      </a></li>`).join('');
  };
  const addItems = list => {
    for (const e of list) items.set(e.path, { ...e, excerpt: e.excerpt || items.get(e.path)?.excerpt, fresh: items.get(e.path)?.fresh });
    renderLog();
  };

  let note = '';  // mensagem depois de guardar, até voltar a digitar
  const update = () => {
    const n = wordCount(ta.value);
    btn.disabled = n === 0;
    btn.classList.toggle('ready', n > 0);
    status.textContent = note || (n
      ? `rascunho salvo · ${plural(n, 'palavra', 'palavras')}`
      : 'o rascunho fica salvo neste aparelho');
    autosize(ta);
  };
  ta.addEventListener('input', () => { note = ''; store.set(DRAFT_KEY, ta.value); update(); });
  bindCtrlEnter(ta, btn);
  btn.addEventListener('click', async () => {
    const body = ta.value.trim();
    if (!body) return;
    btn.disabled = true;
    status.textContent = 'guardando…';
    const now = new Date();
    const path = entryPath(now);
    try {
      await putEntry(path, serializeEntry({ created: isoLocal(now) }, body), null, `entrada ${entryId(now)}`);
      store.del(DRAFT_KEY);
      ta.value = '';
      addItems([{ path, date: now, excerpt: body.slice(0, 600), fresh: true }]);
      note = `guardado às ${fmtTime.format(now)} · a IA organiza em ~1 min`;
      quiet.wake();
    } catch (e) {
      toast(errMsg(e), { error: true });
    } finally {
      update();
      ta.focus();
    }
  });
  update();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  getData().then(data => {
    if (seq !== viewSeq) return;
    const day = today.toDateString();
    addItems(data.entries.filter(e => e.date.toDateString() === day));
  }).catch(() => {});
}

// ---------- Pensamentos ----------

function parseFilters(qs) {
  const p = new URLSearchParams(qs || '');
  return {
    area: AREA_LABEL[p.get('area')] ? p.get('area') : '',
    tags: (p.get('tags') || p.get('tag') || '').split(',').filter(Boolean),
    pessoa: p.get('pessoa') || '',
    lugar: p.get('lugar') || '',
    tipo: p.get('tipo') || '',
    q: p.get('q') || '',
  };
}

function filtersQs(f) {
  const p = new URLSearchParams();
  for (const k of ['area', 'pessoa', 'lugar', 'tipo', 'q']) if (f[k]) p.set(k, f[k]);
  if (f.tags.length) p.set('tags', f.tags.join(','));
  const s = p.toString();
  return s ? `?${s}` : '';
}

function matches(e, f, { ignoreArea = false } = {}) {
  if (!ignoreArea && f.area && e.area !== f.area) return false;
  if (f.tags.length && !f.tags.every(t => e.tags?.includes(t))) return false;
  if (f.pessoa && !e.people?.includes(f.pessoa)) return false;
  if (f.lugar && !e.places?.includes(f.lugar)) return false;
  if (f.tipo && e.kind !== f.tipo) return false;
  const q = fold(f.q.trim());
  if (!q) return true;
  const hay = fold([e.title, e.summary, e.excerpt, e.mood, e.kind, ...(e.tags || []),
    ...(e.people || []), ...(e.places || [])].join(' '));
  return q.split(/\s+/).every(w => hay.includes(w));
}

async function viewList(qs) {
  const seq = viewSeq;
  const f = parseFilters(qs);
  $view.innerHTML = `
    <section class="page wide">
      <header class="page-head">
        <p class="eyebrow" id="stats">&nbsp;</p>
        <h1 class="display">Seus <em>pensamentos</em></h1>
      </header>
      <div class="toolbar">
        <div class="seg" id="seg" role="tablist" aria-label="Área"></div>
        <label class="search">${icon('search')}<input id="q" type="search" placeholder="Buscar em títulos, resumos, pessoas…" value="${esc(f.q)}" autocomplete="off" aria-label="Buscar"></label>
      </div>
      <div class="suggest" id="chips"></div>
      <div id="feed" class="feed">${skeletonCards(3)}</div>
    </section>`;
  let data;
  try { data = await getData(); } catch (e) { if (seq === viewSeq) $('#feed').innerHTML = errorBox(e); return; }
  if (seq !== viewSeq) return;
  const feed = $('#feed'), qInput = $('#q');
  let animate = true;

  const sync = () => history.replaceState(null, '', `#/pensamentos${filtersQs(f)}`);

  const renderControls = () => {
    const base = data.entries.filter(e => matches(e, f, { ignoreArea: true }));
    const n = a => base.filter(e => !a || e.area === a).length;
    $('#seg').innerHTML = segHtml([
      { v: '', label: 'Tudo', n: n('') },
      { v: 'trabalho', label: 'Trabalho', n: n('trabalho'), dot: 'trabalho' },
      { v: 'pessoal', label: 'Pessoal', n: n('pessoal'), dot: 'pessoal' },
    ], f.area);
    const counts = new Map();
    for (const e of data.entries) if (!f.area || e.area === f.area) for (const t of e.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR')).slice(0, 14).map(([t]) => t);
    const shown = [...f.tags, ...top.filter(t => !f.tags.includes(t))];
    const extra = [['pessoa', f.pessoa], ['lugar', f.lugar], ['tipo', f.tipo]].filter(([, v]) => v);
    $('#chips').innerHTML =
      extra.map(([k, v]) => `<button type="button" class="chip on" data-clear="${k}">${k}: ${esc(v)} ${icon('close', 12)}</button>`).join('') +
      shown.map(t => {
        const on = f.tags.includes(t);
        return `<button type="button" class="chip${on ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${on}">` +
          `${on ? '' : '<span class="arr">↳</span>'}${esc(t)}<span class="n">${counts.get(t) || 0}</span>${on ? icon('close', 12) : ''}</button>`;
      }).join('');
  };

  const renderFeed = () => {
    const shown = data.entries.filter(e => matches(e, f));
    const words = shown.reduce((s, e) => s + (e.words || 0), 0);
    $('#stats').textContent = shown.length
      ? `${plural(shown.length, 'pensamento', 'pensamentos')}${words ? ` · ${plural(words, 'palavra', 'palavras')}` : ''}`
      : ' ';
    if (!shown.length) {
      feed.innerHTML = data.entries.length
        ? `<div class="empty"><p class="display sm">Nada <em>por aqui</em>.</p><p>Nenhum pensamento com esses filtros.</p><a class="btn btn-secondary" href="#/pensamentos">Limpar filtros</a></div>`
        : `<div class="empty"><p class="display sm">Nenhum <em>pensamento</em> ainda.</p><p>Escreva o primeiro; a IA organiza o resto.</p><a class="btn btn-primary" href="#/">Escrever</a></div>`;
      return;
    }
    const months = [];
    for (const e of shown) {
      const key = `${e.date.getFullYear()}-${e.date.getMonth()}`;
      if (months.at(-1)?.key !== key) months.push({ key, date: e.date, items: [] });
      months.at(-1).items.push(e);
    }
    let i = 0;
    feed.innerHTML = months.map(m => `
      <section class="month">
        <h2 class="month-label">${esc(fmtMonthName.format(m.date))} <span>${m.date.getFullYear()}</span></h2>
        ${masonry(m.items.map(e => cardHtml(e, i++)))}
      </section>`).join('');
    feed.classList.toggle('animate', animate && !reduceMotion.matches);
    animate = false;
  };

  const renderAll = () => { renderControls(); renderFeed(); };

  $('#seg').addEventListener('click', ev => {
    const b = ev.target.closest('[data-v]');
    if (!b) return;
    f.area = b.dataset.v;
    animate = true;
    sync(); renderAll();
  });
  $('#chips').addEventListener('click', ev => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.clear) f[b.dataset.clear] = '';
    else if (b.dataset.tag) {
      const t = b.dataset.tag;
      f.tags = f.tags.includes(t) ? f.tags.filter(x => x !== t) : [...f.tags, t];
    }
    animate = true;
    sync(); renderAll();
  });
  qInput.addEventListener('input', debounce(() => { f.q = qInput.value; sync(); renderControls(); renderFeed(); }, 140));
  spotlight(feed);
  const onResize = debounce(renderFeed, 160);
  window.addEventListener('resize', onResize);
  cleanup = () => window.removeEventListener('resize', onResize);
  renderAll();

  // Pensamentos recém-guardados ficam "a IA está lendo…" até a Action rodar: recarrega sozinho.
  let polls = 0;
  if (data.entries.some(e => !e.enriched)) {
    pollTimer = setInterval(async () => {
      if (++polls > POLL_MAX) { clearInterval(pollTimer); return; }
      try { data = await loadAll(); } catch { return; }
      if (seq !== viewSeq) return;
      renderAll();
      if (!data.entries.some(e => !e.enriched)) clearInterval(pollTimer);
    }, POLL_MS);
  }
}

// ---------- Pensamento ----------

async function viewEntry(rawPath) {
  const seq = viewSeq;
  const path = decodeURIComponent(rawPath);
  $view.innerHTML = `<article class="page narrow reading"><span class="sk short"></span><span class="sk tall"></span><span class="sk"></span><span class="sk"></span><span class="sk short"></span></article>`;
  let file, data;
  try {
    [file, data] = await Promise.all([getEntry(path), getData().catch(() => null)]);
  } catch (e) { if (seq === viewSeq) $view.firstElementChild.innerHTML = errorBox(e); return; }
  if (seq !== viewSeq) return;
  const e = data?.byPath.get(path) || { date: dateFromPath(path) };
  const stale = e.enriched && e.updated !== (file.meta.updated || '');
  const near = (data?.graph.neighbors?.[path] || [])
    .map(([p, s]) => [data.byPath.get(p), s]).filter(([x]) => x?.enriched).slice(0, 4);
  const tagLinks = (list, key) => (list || []).map(t =>
    `<a class="tag" href="#/pensamentos?${key}=${encodeURIComponent(t)}">${esc(t)}</a>`).join('');
  const cluster = e.cluster?.name && e.cluster.members.length > 1 ? e.cluster : null;
  $view.firstElementChild.innerHTML = `
    <a class="back" href="#/pensamentos">${icon('back', 16)} Pensamentos</a>
    <p class="eyebrow">${esc(fmtFull.format(e.date))}${file.meta.updated ? ' · editado' : ''}</p>
    <h1 class="title${e.enriched ? '' : ' is-pending'}">${e.enriched ? esc(e.title) : 'A IA ainda está lendo…'}</h1>
    ${e.enriched ? `<div class="meta-row">
      <div class="seg xs" id="area-pick" role="radiogroup" aria-label="Área: clique para corrigir" title="Corrigir a área: a sua escolha vence a da IA">
        ${Object.entries(AREA_LABEL).map(([a, label]) => `<button type="button" role="radio" aria-checked="${e.area === a}" data-area="${a}"><i class="dot dot-${a}"></i>${label}</button>`).join('')}
      </div>
      ${e.kind ? `<a class="pill" href="#/pensamentos?tipo=${encodeURIComponent(e.kind)}">${esc(e.kind)}</a>` : ''}
      ${e.mood ? `<span class="pill">${esc(e.mood)}${moodMeter(e.valence, e.mood)}</span>` : ''}
      ${stale ? '<span class="pill ghost">atualizando metadados…</span>' : ''}
    </div>` : ''}
    ${e.tags?.length ? `<div class="tags">${tagLinks(e.tags, 'tags')}</div>` : ''}
    <div class="prose">${esc(file.body)}</div>
    ${e.people?.length ? `<p class="refs"><span>Pessoas</span>${tagLinks(e.people, 'pessoa')}</p>` : ''}
    ${e.places?.length ? `<p class="refs"><span>Lugares</span>${tagLinks(e.places, 'lugar')}</p>` : ''}
    ${near.length || cluster ? `<section class="near">
      <div class="section-head"><h2 class="section-label">Pensamentos próximos</h2>
        ${cluster ? `<a class="link" href="#/constelacao?e=${encodeURIComponent(path)}">${icon('sky', 15)} constelação <em>${esc(cluster.name)}</em></a>` : ''}</div>
      <div class="near-grid">${near.map(([x, s]) => `
        <a class="near-card" href="#/e/${encodeURIComponent(x.path)}" title="afinidade semântica ${Math.round(s * 100)}%">
          <span class="when"><i class="dot dot-${esc(x.area || 'none')}"></i>${esc(dayMonth(x.date))}<span class="num">${Math.round(s * 100)}%</span></span>
          <span class="t">${esc(x.title)}</span>
        </a>`).join('')}</div>
    </section>` : ''}
    <div class="actions">
      <a class="btn btn-secondary" href="#/editar/${encodeURIComponent(path)}">Editar</a>
      <button id="del" class="btn btn-text danger" type="button">Apagar</button>
    </div>`;
  spotlight($view.firstElementChild);

  // Corrigir a área grava "area:" no frontmatter do próprio arquivo; a Action respeita essa
  // escolha (sem chamar o modelo) e a usa como exemplo para classificar os próximos.
  $('#area-pick')?.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-area]');
    if (!b || b.getAttribute('aria-checked') === 'true') return;
    const pick = $('#area-pick'), prevArea = e.area, area = b.dataset.area;
    const mark = a => pick.querySelectorAll('[data-area]').forEach(x => x.setAttribute('aria-checked', String(x.dataset.area === a)));
    mark(area);
    pick.classList.add('busy');
    try {
      const res = await putEntry(path, serializeEntry({ ...file.meta, area }, file.body), file.sha,
        `área de ${path.split('/').pop()}: ${area}`).then(r => r.json());
      file.sha = res.content.sha;
      file.meta.area = area;
      e.area = area;
      areaChosen.set(path, area);
      toast(`Marcado como ${AREA_LABEL[area].toLowerCase()}. A IA passa a usar isso como exemplo.`);
    } catch (err) {
      mark(prevArea);
      toast(errMsg(err), { error: true });
    } finally {
      pick.classList.remove('busy');
    }
  });

  const del = $('#del');
  let armed = null;
  del.addEventListener('click', async () => {
    if (!armed) {  // primeiro clique arma; o segundo, em até 4 s, apaga
      del.textContent = 'Confirmar: apagar de vez';
      del.classList.add('armed');
      armed = setTimeout(() => { armed = null; del.textContent = 'Apagar'; del.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(armed);
    del.disabled = true;
    try {
      await deleteEntry(path, file.sha);
      toast('Pensamento apagado. Ele continua no histórico de commits do repo.');
      location.hash = '#/pensamentos';
    } catch (err) { toast(errMsg(err), { error: true }); del.disabled = false; }
  });
}

async function viewEdit(rawPath) {
  const seq = viewSeq;
  const path = decodeURIComponent(rawPath);
  const date = dateFromPath(path);
  $view.innerHTML = '<section class="page day"><span class="sk short"></span><span class="sk tall"></span></section>';
  let file;
  try { file = await getEntry(path); } catch (e) { if (seq === viewSeq) $view.firstElementChild.innerHTML = errorBox(e); return; }
  if (seq !== viewSeq) return;
  $view.innerHTML = dayPage({
    date, stamp: fmtTime.format(date), text: file.body,
    placeholder: '', aria: 'Texto do pensamento', saveLabel: 'Guardar alterações',
    leftSlot: `<a class="day-status day-cancel" href="#/e/${encodeURIComponent(path)}">cancelar e voltar</a>`,
  });
  const ta = $('#body'), btn = $('#save');
  const quiet = quietMode(ta);
  cleanup = () => quiet.stop();
  btn.classList.add('ready');
  ta.addEventListener('input', () => { btn.disabled = !ta.value.trim(); btn.classList.toggle('ready', !btn.disabled); autosize(ta); });
  bindCtrlEnter(ta, btn);
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      await putEntry(path, serializeEntry({ ...file.meta, updated: isoLocal(new Date()) }, ta.value),
        file.sha, `edita ${path.split('/').pop()}`);
      toast('Alterações guardadas. Os metadados atualizam em ~1 min.');
      location.hash = `#/e/${encodeURIComponent(path)}`;
    } catch (e) {
      toast(errMsg(e), { error: true });
      btn.disabled = false;
    }
  });
  autosize(ta);
  ta.focus();
}

// ---------- Configuração ----------

// Testa token → repo → conteúdo, um passo por vez, para o erro dizer o que ajustar no token.
async function diagnose() {
  let login = '';
  try {
    login = (await api('/user').then(r => r.json())).login;
  } catch (e) {
    if (e.status === 401) return { error: 'Token inválido ou expirado: confira se colou o token inteiro (começa com github_pat_).' };
  }
  const who = login ? `O token de @${login}` : 'O token';
  let info;
  try {
    info = await gh('').then(r => r.json());
  } catch (e) {
    if (e.status === 404) {
      return { error: `${who} é válido, mas não enxerga ${cfg.repo}. Em github.com/settings/personal-access-tokens, ` +
        `abra o token e mude "Repository access" para "Only select repositories" com ${cfg.repo} marcado. ` +
        'O padrão, "Public repositories", não dá acesso a repos privados.' };
    }
    throw e;
  }
  try {
    const { entries } = await loadAll();
    return { info, entries };
  } catch (e) {
    if (e.status === 403) {
      return { error: `${who} enxerga ${info.full_name}, mas não pode ler o conteúdo. Abra o token e dê ` +
        '"Permissions → Repository → Contents: Read and write".' };
    }
    if (e.status === 404 || e.status === 409) return { error: `Branch "${cfg.branch}" não existe em ${info.full_name}.` };
    throw e;
  }
}

function viewConfig() {
  $view.innerHTML = `
    <section class="page narrow config">
      <header class="page-head">
        <p class="eyebrow">conexão com o GitHub</p>
        <h1 class="display">Configu<em>ração</em></h1>
      </header>
      <div class="panel">
        <p>Os pensamentos ficam no repositório <b>privado</b> abaixo. Este app (público) não guarda
          nada: ele lê e grava lá com um token que fica só neste navegador.</p>
        <ol class="steps">
          <li>Abra <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a>.</li>
          <li><i>Repository access</i> → <i>Only select repositories</i> → o repo do diário.</li>
          <li><i>Permissions</i> → <i>Repository</i> → <b>Contents: Read and write</b>.</li>
          <li>Gere o token e cole aqui. Faça o mesmo em cada aparelho.</li>
        </ol>
        <label>Token<input id="token" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></label>
        <label>Repositório<input id="repo" autocomplete="off" spellcheck="false"></label>
        <label>Branch<input id="branch" autocomplete="off" spellcheck="false"></label>
        <div class="actions">
          <button id="test" class="btn btn-primary" type="button">Guardar e testar</button>
          <button id="forget" class="btn btn-text" type="button">Esquecer token</button>
        </div>
        <p id="status" class="status"></p>
      </div>
    </section>`;
  const token = $('#token'), repo = $('#repo'), branch = $('#branch'), status = $('#status');
  token.value = cfg.token;
  repo.value = cfg.repo;
  branch.value = cfg.branch;
  $('#test').addEventListener('click', async () => {
    const repoName = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/(\.git)?\/*$/, '');
    cfg = { token: token.value.trim(), repo: repoName, branch: branch.value.trim() || 'main' };
    store.set(CFG_KEY, cfg);
    repo.value = cfg.repo;
    cache = null;
    status.className = 'status';
    status.textContent = 'Testando…';
    try {
      const r = await diagnose();
      status.className = `status ${r.error || !r.info.private ? 'bad' : 'ok'}`;
      status.innerHTML = r.error
        ? esc(r.error)
        : r.info.private
          ? `Conectado a <b>${esc(r.info.full_name)}</b> (privado) · ${plural(r.entries.length, 'pensamento', 'pensamentos')}.`
          : `Atenção: ${esc(r.info.full_name)} é <b>público</b>. Torne-o privado antes de escrever.`;
    } catch (e) { status.className = 'status bad'; status.textContent = errMsg(e); }
  });
  $('#forget').addEventListener('click', () => {
    cfg = { ...cfg, token: '' };
    store.set(CFG_KEY, cfg);
    cache = null;
    token.value = '';
    status.className = 'status';
    status.textContent = 'Token removido deste navegador.';
  });
}

// ---------- roteamento ----------

const ROUTES = [
  [/^#?\/?$/, viewWrite, 'write'],
  [/^#\/pensamentos(?:\?(.*))?$/, viewList, 'list'],
  [/^#\/entradas(?:\?(.*))?$/, qs => location.replace(`#/pensamentos${qs ? `?${qs}` : ''}`), 'list'],
  [/^#\/constelacao(?:\?(.*))?$/, qs => viewSky(qs), 'sky'],
  [/^#\/tags$/, () => location.replace('#/constelacao?modo=tags'), 'sky'],
  [/^#\/e\/(.+)$/, viewEntry, 'list'],
  [/^#\/editar\/(.+)$/, viewEdit, 'list'],
  [/^#\/config$/, viewConfig, 'config'],
];

let routed = false;
function route() {
  clearInterval(pollTimer);
  const hash = location.hash || '#/';
  if (!cfg.token && hash !== '#/config') { location.hash = '#/config'; return; }
  const hit = ROUTES.map(([re, view, nav]) => [hash.match(re), view, nav]).find(([m]) => m);
  if (!hit) { location.hash = '#/'; return; }
  const [m, view, nav] = hit;
  const render = () => {
    cleanup?.();
    cleanup = null;
    viewSeq++;
    document.querySelectorAll('[data-nav]').forEach(a => {
      a.classList.toggle('active', a.dataset.nav === nav);
      if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    window.scrollTo(0, 0);
    view(...m.slice(1));
  };
  if (routed && document.startViewTransition && !reduceMotion.matches) document.startViewTransition(render);
  else render();
  routed = true;
}

window.addEventListener('hashchange', route);
document.addEventListener('DOMContentLoaded', route);  // depois de ambient.js e constellation.js
