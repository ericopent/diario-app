'use strict';

// Diário: SPA estática. As entradas vivem num repo privado do GitHub e são lidas e
// gravadas pela API REST com um token fine-grained guardado só neste navegador.
// Metadados (título, resumo, tags...) vêm do index.json, que uma Action gera via OpenAI.

const CFG_KEY = 'diario.cfg';
const DRAFT_KEY = 'diario.draft';
const DEFAULT_CFG = { token: '', repo: 'ericopent/diario', branch: 'main' };
const CACHE_TTL_MS = 30_000;
const POLL_MS = 20_000;
const POLL_MAX = 15;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  del(key) { try { localStorage.removeItem(key); } catch {} },
};

let cfg = { ...DEFAULT_CFG, ...store.get(CFG_KEY, {}) };
let cache = null;      // { entries, loadedAt }
let pollTimer = null;

const $view = document.getElementById('view');
const $ = sel => $view.querySelector(sel);

// ---------- utilidades ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const fold = s => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const wordCount = s => (s.trim().match(/\S+/g) || []).length;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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
const fmtDay = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtMonth = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

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

// ---------- GitHub API ----------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(path, { method = 'GET', body, raw = false } = {}) {
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}${path}`, {
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
  const [tree, index] = await Promise.all([
    gh(`/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`).then(r => r.json()),
    gh(`/contents/index.json?${ref()}`, { raw: true }).then(r => r.json())
      .catch(e => { if (e.status === 404) return { entries: {} }; throw e; }),
  ]);
  const meta = index.entries || {};
  const entries = tree.tree
    .filter(n => n.type === 'blob' && n.path.startsWith('entries/') && n.path.endsWith('.md'))
    .map(n => ({ ...(meta[n.path] || {}), path: n.path, date: dateFromPath(n.path), enriched: !!meta[n.path] }))
    .filter(e => e.date)
    .sort((a, b) => b.date - a.date);
  cache = { entries, loadedAt: Date.now() };
  return cache;
}

const getData = () => (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS ? cache : loadAll());

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

const tagLink = (t, key = 'tag') =>
  `<a class="tag" href="#/entradas?${key}=${encodeURIComponent(t)}">${esc(t)}</a>`;
const tagSpan = t => `<span class="tag">${esc(t)}</span>`;
const errorBox = e => `<p class="error-box">${esc(errMsg(e))}</p>`;

function whenLabel(e) {
  return `${fmtDay.format(e.date)} · ${fmtTime.format(e.date)}`;
}

function itemHtml(e) {
  const title = e.enriched
    ? `<h3>${esc(e.title)}</h3>`
    : '<h3 class="pending">aguardando a IA…</h3>';
  return `
    <a class="item" href="#/e/${encodeURIComponent(e.path)}">
      <div class="item-head">
        <span>${esc(whenLabel(e))}</span>
        ${e.kind ? `<span class="kind">${esc(e.kind)}</span>` : ''}
      </div>
      ${title}
      ${e.summary ? `<p class="summary">${esc(e.summary)}</p>` : ''}
      ${e.tags?.length ? `<div class="tags">${e.tags.map(tagSpan).join('')}</div>` : ''}
    </a>`;
}

// ---------- telas ----------

function viewWrite() {
  const draft = store.get(DRAFT_KEY, '');
  $view.innerHTML = `
    <section class="write">
      <p class="when">${esc(fmtFull.format(new Date()))}</p>
      <textarea id="body" class="paper" placeholder="O que está passando pela sua cabeça?" aria-label="Texto da entrada">${esc(draft)}</textarea>
      <div class="bar">
        <span id="count" class="muted"></span>
        <button id="save" class="primary" type="button">Salvar</button>
      </div>
    </section>`;
  const ta = $('#body'), count = $('#count'), btn = $('#save');
  const update = () => {
    const n = wordCount(ta.value);
    count.textContent = n ? plural(n, 'palavra', 'palavras') : 'Ctrl+Enter salva';
    btn.disabled = !ta.value.trim();
    autosize(ta);
  };
  ta.addEventListener('input', () => { store.set(DRAFT_KEY, ta.value); update(); });
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });
  btn.addEventListener('click', async () => {
    const body = ta.value.trim();
    if (!body) return;
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    const now = new Date();
    const path = entryPath(now);
    try {
      await putEntry(path, serializeEntry({ created: isoLocal(now) }, body), null, `entrada ${entryId(now)}`);
      store.del(DRAFT_KEY);
      ta.value = '';
      toast('Salvo. As tags chegam em ~1 min.', { href: `#/e/${encodeURIComponent(path)}` });
    } catch (e) {
      toast(errMsg(e), { error: true });
    } finally {
      btn.textContent = 'Salvar';
      update();
    }
  });
  update();
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

const FILTERS = [['tag', 'tag'], ['pessoa', 'pessoa'], ['lugar', 'lugar'], ['tipo', 'tipo']];

function matches(e, f, q) {
  if (f.tag && !e.tags?.includes(f.tag)) return false;
  if (f.pessoa && !e.people?.includes(f.pessoa)) return false;
  if (f.lugar && !e.places?.includes(f.lugar)) return false;
  if (f.tipo && e.kind !== f.tipo) return false;
  if (!q) return true;
  const hay = fold([e.title, e.summary, e.excerpt, e.mood, e.kind, ...(e.tags || []),
    ...(e.people || []), ...(e.places || [])].join(' '));
  return q.split(/\s+/).every(w => hay.includes(w));
}

async function viewList(qs) {
  const params = new URLSearchParams(qs || '');
  const f = Object.fromEntries(FILTERS.map(([k]) => [k, params.get(k) || '']));
  const active = FILTERS.filter(([k]) => f[k]);
  $view.innerHTML = `
    <section class="list">
      <input id="q" type="search" placeholder="Buscar em títulos, resumos, tags, pessoas…" aria-label="Buscar" autocomplete="off">
      ${active.length ? `<div class="filters">${active.map(([k, label]) =>
        `<a class="chip" href="#/entradas" title="Remover filtro">${esc(label)}: ${esc(f[k])} <span aria-hidden="true">×</span></a>`).join('')}</div>` : ''}
      <p id="stats" class="muted"></p>
      <div id="items"><p class="muted">Carregando…</p></div>
    </section>`;
  let data;
  try { data = await getData(); } catch (e) { $('#items').innerHTML = errorBox(e); return; }
  const qInput = $('#q');

  const render = () => {
    const q = fold(qInput.value.trim());
    const shown = data.entries.filter(e => matches(e, f, q));
    const words = shown.reduce((s, e) => s + (e.words || 0), 0);
    $('#stats').textContent = shown.length
      ? `${plural(shown.length, 'entrada', 'entradas')}${words ? ` · ${words.toLocaleString('pt-BR')} palavras` : ''}`
      : '';
    if (!shown.length) {
      $('#items').innerHTML = data.entries.length
        ? '<p class="empty">Nada encontrado.</p>'
        : '<p class="empty">Nenhuma entrada ainda. <a href="#/">Escreva a primeira.</a></p>';
      return;
    }
    let html = '', month = '';
    for (const e of shown) {
      const m = fmtMonth.format(e.date);
      if (m !== month) { html += `<h2 class="month">${esc(m)}</h2>`; month = m; }
      html += itemHtml(e);
    }
    $('#items').innerHTML = html;
  };
  qInput.addEventListener('input', debounce(render, 120));
  render();

  // Entradas recém-salvas ficam "aguardando a IA" até a Action rodar: recarrega sozinho.
  let polls = 0;
  if (data.entries.some(e => !e.enriched)) {
    pollTimer = setInterval(async () => {
      if (++polls > POLL_MAX) { clearInterval(pollTimer); return; }
      try { data = await loadAll(); } catch { return; }
      render();
      if (!data.entries.some(e => !e.enriched)) clearInterval(pollTimer);
    }, POLL_MS);
  }
}

async function viewEntry(rawPath) {
  const path = decodeURIComponent(rawPath);
  $view.innerHTML = '<p class="muted">Carregando…</p>';
  let file, data;
  try {
    [file, data] = await Promise.all([getEntry(path), getData().catch(() => null)]);
  } catch (e) { $view.innerHTML = errorBox(e); return; }
  const e = data?.entries.find(x => x.path === path) || { date: dateFromPath(path) };
  const stale = e.enriched && e.updated !== (file.meta.updated || '');
  const facts = [e.kind, e.mood].filter(Boolean).map(esc).join(' · ');
  const people = (e.people || []).map(p => tagLink(p, 'pessoa')).join('');
  const places = (e.places || []).map(p => tagLink(p, 'lugar')).join('');
  $view.innerHTML = `
    <article class="entry">
      <p class="when">${esc(fmtFull.format(e.date))}${file.meta.updated ? ' · editada' : ''}</p>
      <h1 class="${e.enriched ? '' : 'pending'}">${e.enriched ? esc(e.title) : 'aguardando a IA…'}</h1>
      ${facts ? `<p class="facts">${facts}${stale ? ' · <em>metadados sendo atualizados</em>' : ''}</p>` : ''}
      ${e.tags?.length ? `<div class="tags">${e.tags.map(t => tagLink(t)).join('')}</div>` : ''}
      <div class="body">${esc(file.body)}</div>
      ${people ? `<p class="refs"><span class="muted">Pessoas</span> ${people}</p>` : ''}
      ${places ? `<p class="refs"><span class="muted">Lugares</span> ${places}</p>` : ''}
      <div class="actions">
        <a class="btn" href="#/editar/${encodeURIComponent(path)}">Editar</a>
        <button id="del" class="ghost danger" type="button">Apagar</button>
      </div>
    </article>`;
  $('#del').addEventListener('click', async () => {
    if (!confirm('Apagar esta entrada? Ela continua no histórico de commits do repo.')) return;
    try {
      await deleteEntry(path, file.sha);
      toast('Entrada apagada.');
      location.hash = '#/entradas';
    } catch (err) { toast(errMsg(err), { error: true }); }
  });
}

async function viewEdit(rawPath) {
  const path = decodeURIComponent(rawPath);
  $view.innerHTML = '<p class="muted">Carregando…</p>';
  let file;
  try { file = await getEntry(path); } catch (e) { $view.innerHTML = errorBox(e); return; }
  const date = dateFromPath(path);
  $view.innerHTML = `
    <section class="write">
      <p class="when">Editando · ${esc(fmtFull.format(date))}</p>
      <textarea id="body" class="paper" aria-label="Texto da entrada">${esc(file.body)}</textarea>
      <div class="bar">
        <a class="ghost" href="#/e/${encodeURIComponent(path)}">Cancelar</a>
        <button id="save" class="primary" type="button">Salvar alterações</button>
      </div>
    </section>`;
  const ta = $('#body'), btn = $('#save');
  ta.addEventListener('input', () => { btn.disabled = !ta.value.trim(); autosize(ta); });
  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); btn.click(); }
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    const meta = { ...file.meta, updated: isoLocal(new Date()) };
    try {
      await putEntry(path, serializeEntry(meta, ta.value), file.sha, `edita ${path.split('/').pop()}`);
      toast('Alterações salvas. Metadados atualizam em ~1 min.');
      location.hash = `#/e/${encodeURIComponent(path)}`;
    } catch (e) {
      toast(errMsg(e), { error: true });
      btn.disabled = false;
      btn.textContent = 'Salvar alterações';
    }
  });
  autosize(ta);
  ta.focus();
}

function cloud(counts, key) {
  const list = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'pt-BR'));
  if (!list.length) return '<p class="muted">Nada ainda.</p>';
  const max = Math.log(list[0][1]);
  return `<div class="cloud">${list.map(([t, n]) => {
    const size = max > 0 ? 0.85 + 0.5 * (Math.log(n) / max) : 0.9;
    return `<a class="tag" style="font-size:${size.toFixed(2)}rem" href="#/entradas?${key}=${encodeURIComponent(t)}">${esc(t)} <span class="n">${n}</span></a>`;
  }).join('')}</div>`;
}

async function viewTags() {
  $view.innerHTML = '<p class="muted">Carregando…</p>';
  let data;
  try { data = await getData(); } catch (e) { $view.innerHTML = errorBox(e); return; }
  const count = field => {
    const m = new Map();
    for (const e of data.entries) for (const v of [e[field]].flat().filter(Boolean)) m.set(v, (m.get(v) || 0) + 1);
    return m;
  };
  $view.innerHTML = `
    <section class="tags-view">
      <h2 class="month">Tags</h2>${cloud(count('tags'), 'tag')}
      <h2 class="month">Tipos</h2>${cloud(count('kind'), 'tipo')}
      <h2 class="month">Pessoas</h2>${cloud(count('people'), 'pessoa')}
      <h2 class="month">Lugares</h2>${cloud(count('places'), 'lugar')}
    </section>`;
}

function viewConfig() {
  $view.innerHTML = `
    <section class="config">
      <h1>Configuração</h1>
      <p>As entradas ficam no repositório <b>privado</b> abaixo. Este app (público) não guarda
        nada: ele lê e grava lá usando um token que fica só neste navegador.</p>
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
        <button id="test" class="primary" type="button">Salvar e testar</button>
        <button id="forget" class="ghost" type="button">Esquecer token</button>
      </div>
      <p id="status" class="muted"></p>
    </section>`;
  const token = $('#token'), repo = $('#repo'), branch = $('#branch'), status = $('#status');
  token.value = cfg.token;
  repo.value = cfg.repo;
  branch.value = cfg.branch;
  $('#test').addEventListener('click', async () => {
    cfg = { token: token.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main' };
    store.set(CFG_KEY, cfg);
    cache = null;
    status.textContent = 'Testando…';
    try {
      const info = await gh('').then(r => r.json());
      const { entries } = await loadAll();
      status.innerHTML = info.private
        ? `Conectado a <b>${esc(info.full_name)}</b> (privado) · ${plural(entries.length, 'entrada', 'entradas')}.`
        : `<span class="danger">Atenção: ${esc(info.full_name)} é <b>público</b>. Torne-o privado antes de escrever.</span>`;
    } catch (e) { status.innerHTML = `<span class="danger">${esc(errMsg(e))}</span>`; }
  });
  $('#forget').addEventListener('click', () => {
    cfg = { ...cfg, token: '' };
    store.set(CFG_KEY, cfg);
    cache = null;
    token.value = '';
    status.textContent = 'Token removido deste navegador.';
  });
}

// ---------- roteamento ----------

const ROUTES = [
  [/^#?\/?$/, viewWrite, 'write'],
  [/^#\/entradas(?:\?(.*))?$/, viewList, 'list'],
  [/^#\/e\/(.+)$/, viewEntry, 'list'],
  [/^#\/editar\/(.+)$/, viewEdit, 'list'],
  [/^#\/tags$/, viewTags, 'tags'],
  [/^#\/config$/, viewConfig, 'config'],
];

function route() {
  clearInterval(pollTimer);
  const hash = location.hash || '#/';
  if (!cfg.token && hash !== '#/config') { location.hash = '#/config'; return; }
  for (const [re, view, nav] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    document.querySelectorAll('[data-nav]').forEach(a =>
      a.classList.toggle('active', a.dataset.nav === nav));
    window.scrollTo(0, 0);
    view(...m.slice(1));
    return;
  }
  location.hash = '#/';
}

window.addEventListener('hashchange', route);
route();
