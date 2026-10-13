'use strict';

// Constelação: cada pensamento é uma estrela. As linhas ligam pensamentos com afinidade semântica
// (graph.json, embeddings da OpenAI); as nebulosas são os clusters (Louvain) que a IA nomeia; a
// cor diz a área. No modo Tags, as estrelas são tags, as linhas são coocorrência e o painel mostra
// as correlações (lift), o humor médio e a divisão trabalho/pessoal de cada tag.

const D3_SRC = 'vendor/d3-7.9.0.min.js';
const RGB = { trabalho: '147,172,217', pessoal: '231,168,107', neutro: '226,220,210' };
const TAU = Math.PI * 2;
let d3Loading = null;

function loadD3() {
  if (window.d3) return Promise.resolve(window.d3);
  d3Loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = D3_SRC;
    s.onload = () => resolve(window.d3);
    s.onerror = () => { d3Loading = null; reject(new Error('Não consegui carregar o motor do gráfico (d3).')); };
    document.head.append(s);
  });
  return d3Loading;
}

const glowSprites = new Map();
function glowSprite(rgb) {
  if (glowSprites.has(rgb)) return glowSprites.get(rgb);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb},0.85)`);
  grad.addColorStop(0.2, `rgba(${rgb},0.32)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  glowSprites.set(rgb, c);
  return c;
}

const mixRgb = (a, b, t) => {
  const A = a.split(',').map(Number), B = b.split(',').map(Number);
  return A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',');
};
const clamp01 = x => Math.max(0, Math.min(1, x));
const easeOut = x => 1 - (1 - x) ** 3;
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fmtLift = x => `${x >= 10 ? Math.round(x) : fmtNum(x)}×`;

// ---------- estatísticas de tags ----------

function tagStats(entries) {
  const s = { N: entries.length, count: new Map(), pairs: new Map(), val: new Map(), area: new Map(), byTag: new Map() };
  for (const e of entries) {
    const tags = [...new Set(e.tags || [])];
    for (const t of tags) {
      s.count.set(t, (s.count.get(t) || 0) + 1);
      if (!s.val.has(t)) { s.val.set(t, [0, 0]); s.area.set(t, { trabalho: 0, pessoal: 0 }); s.byTag.set(t, []); }
      if (typeof e.valence === 'number') { s.val.get(t)[0] += e.valence; s.val.get(t)[1]++; }
      if (e.area in s.area.get(t)) s.area.get(t)[e.area]++;
      s.byTag.get(t).push(e);
    }
    for (let i = 0; i < tags.length; i++) {
      for (let j = i + 1; j < tags.length; j++) {
        const k = tags[i] < tags[j] ? `${tags[i]}\u0000${tags[j]}` : `${tags[j]}\u0000${tags[i]}`;
        s.pairs.set(k, (s.pairs.get(k) || 0) + 1);
      }
    }
  }
  return s;
}

// lift = P(a e b) / (P(a)·P(b)): quantas vezes os dois aparecem juntos além do que o acaso daria.
const lift = (s, a, b, c) => (c * s.N) / (s.count.get(a) * s.count.get(b));

// Ordena por c·ln(lift): com poucos pensamentos, um par visto uma única vez já tem lift enorme;
// pesar pela frequência deixa no topo o que é associado E recorrente.
const pairScore = p => p.c * Math.log(p.lift);

function relatedTags(s, tag) {
  const out = [];
  for (const [k, c] of s.pairs) {
    const [a, b] = k.split('\u0000');
    if (a !== tag && b !== tag) continue;
    out.push({ tag: a === tag ? b : a, c, lift: lift(s, a, b, c) });
  }
  return out.sort((x, y) => pairScore(y) - pairScore(x) || y.c - x.c);
}

function strongPairs(s, limit) {
  const minC = s.N >= 20 ? 2 : 1;
  return [...s.pairs]
    .filter(([, c]) => c >= minC)
    .map(([k, c]) => { const [a, b] = k.split('\u0000'); return { a, b, c, lift: lift(s, a, b, c) }; })
    .filter(p => p.lift > 1)
    .sort((x, y) => pairScore(y) - pairScore(x))
    .slice(0, limit);
}

// ---------- tela ----------

async function viewSky(qs) {
  const seq = viewSeq;
  const params = new URLSearchParams(qs || '');
  const st = {
    mode: params.get('modo') === 'tags' ? 'tags' : 'pensamentos',
    area: AREA_LABEL[params.get('area')] ? params.get('area') : '',
    tags: (params.get('tags') || '').split(',').filter(Boolean),
    sel: params.get('e') || (params.get('t') ? `tag:${params.get('t')}` : ''),
    cluster: params.get('c') || '',
  };
  document.body.classList.add('sky-mode');
  ambient.pause();
  $view.innerHTML = `
    <section class="sky">
      <canvas id="sky-canvas" aria-label="Constelação de pensamentos. Use o painel para navegar pelo teclado."></canvas>
      <div class="sky-hud">
        <div class="hud-card">
          <p class="eyebrow">segundo cérebro</p>
          <h1 class="display sm">Conste<em>lação</em></h1>
          <div class="seg sm" id="mode" role="tablist" aria-label="O que cada estrela representa"></div>
          <div class="seg sm" id="area" role="tablist" aria-label="Área"></div>
        </div>
        <div class="hud-chips" id="chips"></div>
      </div>
      <aside class="sky-panel" id="panel" aria-live="polite">
        <button class="panel-handle" id="handle" type="button" aria-label="Expandir painel"><span></span></button>
        <div class="panel-body" id="panel-body"><span class="sk short"></span><span class="sk tall"></span><span class="sk"></span></div>
      </aside>
      <div class="sky-tip" id="tip" hidden></div>
      <p class="sky-legend"><span><i class="dot dot-trabalho"></i>trabalho</span><span><i class="dot dot-pessoal"></i>pessoal</span><span>linhas = afinidade</span><span>arraste · role para zoom</span></p>
    </section>`;
  const canvas = $('#sky-canvas'), ctx = canvas.getContext('2d');
  const panel = $('#panel'), body = $('#panel-body'), tip = $('#tip');
  let alive = true, raf = 0, sim = null, zoom = null, d3 = null, data = null;
  let W = 0, H = 0, dpr = 1, T = null;
  let nodes = [], links = [], byId = new Map(), adj = new Map(), stats = null, hl = null;
  let bornAt = 0, hover = null, fitted = false;
  const pos = new Map();
  const dust = Array.from({ length: 260 }, () => ({
    x: Math.random(), y: Math.random(), r: 0.3 + Math.random() * 0.9, p: Math.random() * TAU, d: 0.15 + Math.random() * 0.85,
  }));
  const onResize = debounce(() => { resize(); }, 120);
  cleanup = () => {
    alive = false;
    cancelAnimationFrame(raf);
    sim?.stop();
    window.removeEventListener('resize', onResize);
    document.body.classList.remove('sky-mode');
    ambient.resume();
  };

  try {
    [d3, data] = await Promise.all([loadD3(), getData()]);
    await document.fonts.load('italic 18px "Instrument Serif"').catch(() => {});
  } catch (e) {
    if (seq === viewSeq) body.innerHTML = errorBox(e);
    return;
  }
  if (seq !== viewSeq) return;

  T = d3.zoomIdentity;
  zoom = d3.zoom().scaleExtent([0.2, 8]).on('zoom', ev => { T = ev.transform; });
  d3.select(canvas).call(zoom).on('dblclick.zoom', null);
  window.addEventListener('resize', onResize);
  resize();

  // ----- geometria -----

  function resize() {
    const r = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = r.width;
    H = r.height;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }

  // Área útil do céu: abaixo do HUD e fora do painel (lateral no desktop, inferior no celular).
  function viewport() {
    const hud = $('.sky-hud').getBoundingClientRect(), p = panel.getBoundingClientRect();
    return W >= 900
      ? { x0: 24, y0: hud.bottom + 8, x1: p.left - 16, y1: H - 44 }
      : { x0: 8, y0: hud.bottom + 8, x1: W - 8,
        // aberto, o painel ainda está crescendo (transição): usa a altura final, a mesma do CSS
        y1: (panel.classList.contains('open') ? p.bottom - Math.min(H * 0.46, 440) : p.top) - 8 };
  }

  function fitTo(list, animate = true, maxK = 2.2) {
    if (!list.length) return;
    const xs = list.map(n => n.x), ys = list.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const v = viewport(), pad = 50;
    const k = Math.min(maxK,
      (v.x1 - v.x0 - pad * 2) / Math.max(1, maxX - minX),
      (v.y1 - v.y0 - pad * 2) / Math.max(1, maxY - minY));
    const target = d3.zoomIdentity
      .translate((v.x0 + v.x1) / 2 - (k * (minX + maxX)) / 2, (v.y0 + v.y1) / 2 - (k * (minY + maxY)) / 2)
      .scale(k);
    const sel = d3.select(canvas);
    if (animate && !reduceMotion.matches) sel.transition().duration(900).ease(d3.easeCubicInOut).call(zoom.transform, target);
    else sel.call(zoom.transform, target);
  }

  function focusCurrent(animate = true) {
    if (hl?.size) fitTo(nodes.filter(n => hl.has(n.id)), animate, 2.4);
    else fitTo(nodes, animate);
  }

  // ----- grafo -----

  function build() {
    sim?.stop();
    for (const n of nodes) pos.set(n.id, { x: n.x, y: n.y });
    const list = data.entries.filter(e => e.enriched && (!st.area || e.area === st.area));
    stats = tagStats(list);

    if (st.mode === 'pensamentos') {
      nodes = list.map((e, i) => ({
        id: e.path, kind: 'entry', e, i, phase: Math.random() * TAU,
        r: Math.min(9, 2.6 + Math.sqrt(e.words || 40) / 3.2),
        rgb: RGB[e.area] || RGB.neutro,
        cluster: e.cluster && e.cluster.members.length > 1 ? e.cluster : null,
      }));
      const ids = new Set(nodes.map(n => n.id));
      links = data.graph.links.filter(l => ids.has(l.s) && ids.has(l.t)).map(l => ({ source: l.s, target: l.t, w: l.w }));
      // Âncoras: constelações maiores perto do centro, em espiral áurea; estrelas soltas por fora.
      const groups = new Map();
      for (const n of nodes) {
        const k = n.cluster ? `c${n.cluster.id}` : `s:${n.id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(n);
      }
      [...groups.values()].sort((a, b) => b.length - a.length).forEach((g, idx) => {
        const rad = 150 * Math.sqrt(idx), ang = idx * 2.39996;
        for (const n of g) { n.ax = rad * Math.cos(ang); n.ay = rad * Math.sin(ang); }
      });
    } else {
      const counts = [...stats.count].sort((a, b) => b[1] - a[1]);
      const max = counts[0]?.[1] || 1;
      nodes = counts.map(([t, c], i) => {
        const a = stats.area.get(t), tot = a.trabalho + a.pessoal;
        return {
          id: `tag:${t}`, kind: 'tag', tag: t, c, i, phase: Math.random() * TAU, ax: 0, ay: 0,
          r: 2.4 + 7 * Math.sqrt(c / max),
          rgb: tot ? mixRgb(RGB.pessoal, RGB.trabalho, a.trabalho / tot) : RGB.neutro,
        };
      });
      // Linhas = coocorrência (peso Jaccard); no máximo 5 por tag para não virar um novelo.
      const cand = [...stats.pairs].map(([k, c]) => {
        const [a, b] = k.split('\u0000');
        return { a, b, c, w: c / (stats.count.get(a) + stats.count.get(b) - c) };
      }).sort((x, y) => y.w - x.w);
      const deg = new Map();
      links = [];
      for (const p of cand) {
        if ((deg.get(p.a) || 0) >= 5 || (deg.get(p.b) || 0) >= 5) continue;
        deg.set(p.a, (deg.get(p.a) || 0) + 1);
        deg.set(p.b, (deg.get(p.b) || 0) + 1);
        links.push({ source: `tag:${p.a}`, target: `tag:${p.b}`, w: p.w });
      }
    }

    byId = new Map(nodes.map(n => [n.id, n]));
    adj = new Map(nodes.map(n => [n.id, new Set()]));
    for (const l of links) { adj.get(l.source).add(l.target); adj.get(l.target).add(l.source); }
    const first = !pos.size;
    for (const n of nodes) {
      const p = pos.get(n.id);
      n.x = p ? p.x : n.ax + (Math.random() - 0.5) * 70;
      n.y = p ? p.y : n.ay + (Math.random() - 0.5) * 70;
    }
    if (st.sel && !byId.has(st.sel)) st.sel = '';

    sim = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(n => n.id).distance(l => 28 + (1 - l.w) * 110).strength(l => 0.12 + l.w * 0.5))
      .force('charge', d3.forceManyBody().strength(st.mode === 'tags' ? -70 : -38).distanceMax(340))
      .force('collide', d3.forceCollide(n => n.r + 6))
      .force('x', d3.forceX(n => n.ax).strength(0.06))
      .force('y', d3.forceY(n => n.ay).strength(0.06))
      .alphaDecay(0.035)
      .on('end', () => { if (!fitted && alive) { fitted = true; focusCurrent(); } });
    if (reduceMotion.matches) {
      sim.stop();
      sim.tick(300);
      fitted = true;
    } else if (first) {
      sim.tick(140);  // quase assentado antes do primeiro quadro; o resto anima enquanto as estrelas surgem
    }
    bornAt = performance.now();
    computeHighlight();
    renderControls();
    renderPanel();  // antes do enquadramento: no celular o painel aberto muda a área útil
    if (first || reduceMotion.matches) focusCurrent(false);
    else fitted = false;
  }

  function computeHighlight() {
    hl = null;
    if (st.sel && byId.has(st.sel)) hl = new Set([st.sel, ...adj.get(st.sel)]);
    else if (st.mode === 'pensamentos' && st.cluster) {
      hl = new Set(nodes.filter(n => n.cluster && String(n.cluster.id) === st.cluster).map(n => n.id));
    } else if (st.tags.length) {
      if (st.mode === 'pensamentos') {
        hl = new Set(nodes.filter(n => st.tags.every(t => n.e.tags?.includes(t))).map(n => n.id));
      } else {
        const ids = st.tags.map(t => `tag:${t}`).filter(id => byId.has(id));
        hl = new Set(ids.flatMap(id => [id, ...adj.get(id)]));
      }
    }
  }

  function sync() {
    const p = new URLSearchParams();
    if (st.mode === 'tags') p.set('modo', 'tags');
    if (st.area) p.set('area', st.area);
    if (st.tags.length) p.set('tags', st.tags.join(','));
    if (st.sel.startsWith('tag:')) p.set('t', st.sel.slice(4));
    else if (st.sel) p.set('e', st.sel);
    if (st.cluster) p.set('c', st.cluster);
    const s = p.toString();
    history.replaceState(null, '', `#/constelacao${s ? `?${s}` : ''}`);
  }

  function select(id, focus = false) {
    st.sel = id;
    if (id) st.cluster = '';
    sync();
    computeHighlight();
    renderPanel();
    if (focus || W < 900) focusCurrent();  // no celular o painel cobre parte do céu: sempre reenquadra
  }

  // ----- desenho -----

  function appear(n, now) {
    if (reduceMotion.matches) return 1;
    const stagger = Math.min(28, 1400 / Math.max(1, nodes.length));
    return easeOut(clamp01((now - bornAt - n.i * stagger) / 650));
  }

  function nebulae() {
    const groups = new Map();
    for (const n of nodes) {
      if (!n.cluster) continue;
      if (!groups.has(n.cluster.id)) groups.set(n.cluster.id, { c: n.cluster, list: [] });
      groups.get(n.cluster.id).list.push(n);
    }
    const out = [];
    for (const { c, list } of groups.values()) {
      if (list.length < 2) continue;
      const x = list.reduce((s, n) => s + n.x, 0) / list.length;
      const y = list.reduce((s, n) => s + n.y, 0) / list.length;
      const r = Math.max(...list.map(n => Math.hypot(n.x - x, n.y - y))) + 46;
      out.push({ c, list, x, y, r, on: !hl || list.some(n => hl.has(n.id)) });
    }
    return out;
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const still = reduceMotion.matches;

    // poeira de fundo, com leve paralaxe
    for (const s of dust) {
      const x = (((s.x * W + T.x * 0.05 * s.d) % W) + W) % W;
      const y = (((s.y * H + T.y * 0.05 * s.d) % H) + H) % H;
      const tw = still ? 0.5 : 0.35 + 0.65 * Math.abs(Math.sin(now / 1800 + s.p));
      ctx.fillStyle = `rgba(236,230,220,${(0.08 + 0.22 * tw * s.d).toFixed(3)})`;
      ctx.fillRect(x, y, s.r, s.r);
    }

    const nebs = st.mode === 'pensamentos' ? nebulae() : [];
    ctx.save();
    ctx.translate(T.x, T.y);
    ctx.scale(T.k, T.k);

    for (const nb of nebs) {
      const g = ctx.createRadialGradient(nb.x, nb.y, 0, nb.x, nb.y, nb.r);
      const a = (nb.on ? 0.075 : 0.025) * Math.min(1, (now - bornAt) / 900);
      g.addColorStop(0, `rgba(236,226,210,${a})`);
      g.addColorStop(0.6, `rgba(236,226,210,${a * 0.4})`);
      g.addColorStop(1, 'rgba(236,226,210,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(nb.x, nb.y, nb.r, 0, TAU);
      ctx.fill();
    }

    ctx.lineWidth = 1 / T.k;
    for (const l of links) {
      const a = l.source, b = l.target;
      const ap = Math.min(appear(a, now), appear(b, now));
      if (ap <= 0) continue;
      const on = !hl || (hl.has(a.id) && hl.has(b.id));
      const alpha = (hl ? (on ? 0.5 : 0.025) : 0.07 + l.w * 0.24) * ap;
      ctx.strokeStyle = `rgba(236,232,225,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    for (const n of nodes) {
      const ap = appear(n, now);
      if (ap <= 0) continue;
      const tw = still ? 1 : 0.8 + 0.2 * Math.sin(now / 900 + n.phase);
      const dim = hl && !hl.has(n.id) ? 0.16 : 1;
      const R = n.r * (n === hover ? 4.2 : 3.4);
      ctx.globalAlpha = 0.6 * tw * dim * ap;
      ctx.drawImage(glowSprite(n.rgb), n.x - R, n.y - R, R * 2, R * 2);
      ctx.globalAlpha = dim * ap;
      ctx.fillStyle = `rgb(${n.rgb})`;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * (0.5 + 0.5 * ap), 0, TAU);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,250,242,0.9)';
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * 0.38, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const sel = byId.get(st.sel);
    if (sel) {
      const pulse = still ? 0 : (Math.sin(now / 420) + 1) * 1.5;
      ctx.strokeStyle = 'rgba(255,248,236,0.75)';
      ctx.lineWidth = 1.2 / T.k;
      ctx.beginPath();
      ctx.arc(sel.x, sel.y, sel.r + 5 + pulse, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();

    drawLabels(nebs, now);
  }

  // Rótulos em coordenadas de tela (tamanho fixo no zoom), por prioridade e sem sobreposição:
  // hover/selecionado → destacados → nebulosas → o resto (zoom alto ou tags frequentes).
  function drawLabels(nebs, now) {
    const small = W < 600;
    const nebFont = `italic ${small ? 16 : 19}px "Instrument Serif", Georgia, serif`;
    const nodeFont = '500 11.5px Geist, system-ui, sans-serif';
    const tagLabelMin = st.mode === 'tags' ? (nodes[Math.min(nodes.length - 1, small ? 10 : 18)]?.c ?? 1) : Infinity;
    const cands = [];
    for (const nb of nebs) if (nb.c.name) cands.push({ pri: nb.on ? 2 : 4, nb });
    for (const n of nodes) {
      if (appear(n, now) < 1) continue;
      const pri = n === hover || n.id === st.sel ? 0
        : hl ? (hl.has(n.id) && hl.size <= 14 ? 1 : -1)
          : T.k >= 2.3 || (n.kind === 'tag' && n.c >= tagLabelMin) ? 3 : -1;
      if (pri >= 0) cands.push({ pri, n });
    }
    cands.sort((a, b) => a.pri - b.pri);
    const boxes = [];
    const free = (x, y, w, h) => {
      if (boxes.some(b => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y)) return false;
      boxes.push({ x, y, w, h });
      return true;
    };
    ctx.lineJoin = 'round';
    for (const c of cands) {
      if (c.nb) {
        const [x, y] = T.apply([c.nb.x, c.nb.y - c.nb.r * 0.78]);
        ctx.font = nebFont;
        const w = ctx.measureText(c.nb.c.name).width;
        if (!free(x - w / 2 - 4, y - 16, w + 8, 22)) continue;
        ctx.textAlign = 'center';
        ctx.strokeStyle = 'rgba(12,11,10,0.7)';
        ctx.lineWidth = 4;
        ctx.strokeText(c.nb.c.name, x, y);
        ctx.fillStyle = `rgba(236,230,220,${c.nb.on ? 0.72 : 0.2})`;
        ctx.fillText(c.nb.c.name, x, y);
      } else {
        const n = c.n;
        const [sx, sy] = T.apply([n.x, n.y]);
        const text = n.kind === 'tag' ? n.tag : truncate(n.e.title, 34);
        ctx.font = nodeFont;
        const w = ctx.measureText(text).width;
        let x = sx + n.r * T.k + 6;
        if (x + w > W - 8) x = sx - n.r * T.k - 6 - w;  // perto da borda: rótulo à esquerda da estrela
        if (!free(x - 2, sy - 9, w + 4, 16)) continue;
        ctx.textAlign = 'left';
        ctx.strokeStyle = 'rgba(12,11,10,0.85)';
        ctx.lineWidth = 3;
        ctx.strokeText(text, x, sy + 4);
        ctx.fillStyle = 'rgba(240,234,224,0.92)';
        ctx.fillText(text, x, sy + 4);
      }
    }
  }

  function frame(now) {
    if (!alive) return;
    draw(now);
    raf = requestAnimationFrame(frame);
  }

  // ----- painel -----

  function renderControls() {
    $('#mode').innerHTML = segHtml([{ v: 'pensamentos', label: 'Pensamentos' }, { v: 'tags', label: 'Tags' }], st.mode);
    const n = a => data.entries.filter(e => e.enriched && (!a || e.area === a)).length;
    $('#area').innerHTML = segHtml([
      { v: '', label: 'Tudo', n: n('') },
      { v: 'trabalho', label: 'Trabalho', n: n('trabalho'), dot: 'trabalho' },
      { v: 'pessoal', label: 'Pessoal', n: n('pessoal'), dot: 'pessoal' },
    ], st.area);
    const top = [...stats.count].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
    const shown = [...st.tags, ...top.filter(t => !st.tags.includes(t))];
    $('#chips').innerHTML = shown.map(t => {
      const on = st.tags.includes(t);
      return `<button type="button" class="chip${on ? ' on' : ''}" data-tag="${esc(t)}" aria-pressed="${on}">` +
        `${on ? '' : '<span class="arr">↳</span>'}${esc(t)}<span class="n">${stats.count.get(t) || 0}</span>${on ? icon('close', 12) : ''}</button>`;
    }).join('');
  }

  function renderPanel() {
    const n = byId.get(st.sel);
    body.innerHTML = n ? (n.kind === 'tag' ? tagPanel(n) : entryPanel(n)) : overviewPanel();
    panel.classList.toggle('open', !!n);
    body.scrollTop = 0;
  }

  function overviewPanel() {
    if (!data.entries.length) {
      return `<p class="eyebrow">céu vazio</p><h2 class="panel-title">Nenhum <em>pensamento</em> ainda.</h2>
        <p class="panel-text">Cada pensamento que você guardar vira uma estrela aqui.</p>
        <a class="btn btn-primary block" href="#/">Escrever o primeiro</a>`;
    }
    const sparse = nodes.length < 8
      ? '<p class="hint">Com mais pensamentos, as constelações ganham forma.</p>' : '';
    const pairs = strongPairs(stats, 5);
    const pairsHtml = pairs.length ? `<h3 class="panel-label">Correlações</h3>
      <ul class="rows">${pairs.map(p => `<li><button type="button" data-tags="${esc(p.a)},${esc(p.b)}">
        <span class="t">${esc(p.a)} <em>+</em> ${esc(p.b)}</span><span class="num">${fmtLift(p.lift)} · ${p.c}</span></button></li>`).join('')}</ul>
      <p class="hint">× = quantas vezes mais juntas do que o acaso (lift) · nº de pensamentos.</p>` : '';

    if (st.mode === 'tags') {
      const top = [...stats.count].sort((a, b) => b[1] - a[1]).slice(0, 8);
      return `<p class="eyebrow">visão geral · tags</p>
        <h2 class="panel-title">${plural(stats.count.size, 'tag', 'tags')}<br><em>em ${plural(stats.N, 'pensamento', 'pensamentos')}</em></h2>
        ${sparse}
        <h3 class="panel-label">Mais frequentes</h3>
        <ul class="rows">${top.map(([t, c]) => `<li><button type="button" data-node="tag:${esc(t)}"><span class="t">${esc(t)}</span><span class="num">${c}</span></button></li>`).join('')}</ul>
        ${pairsHtml}`;
    }
    const groups = data.graph.clusters
      .map(c => ({ c, n: c.members.filter(m => byId.has(m)).length }))
      .filter(x => x.c.name && x.n >= 2);
    return `<p class="eyebrow">visão geral</p>
      <h2 class="panel-title">${plural(nodes.length, 'pensamento', 'pensamentos')}<br><em>${plural(groups.length, 'constelação', 'constelações')}</em></h2>
      ${data.hasGraph ? sparse : '<p class="hint">O grafo aparece depois que a Action processar os pensamentos (embeddings + clusters).</p>'}
      ${groups.length ? `<h3 class="panel-label">Constelações</h3>
        <ul class="clusters">${groups.map(({ c, n: count }) => `<li><button type="button" data-cluster="${c.id}" class="${st.cluster === String(c.id) ? 'on' : ''}" aria-pressed="${st.cluster === String(c.id)}">
          <span class="c-name">${esc(c.name)}</span><span class="num">${count}</span>
          ${c.description ? `<span class="c-desc">${esc(c.description)}</span>` : ''}</button></li>`).join('')}</ul>` : ''}
      ${pairsHtml}
      <p class="hint">Clique numa estrela para ver o pensamento e os mais próximos.</p>`;
  }

  function entryPanel(n) {
    const e = n.e;
    const near = (data.graph.neighbors[e.path] || [])
      .map(([p, s]) => [data.byPath.get(p), s]).filter(([x]) => x?.enriched).slice(0, 5);
    return `<button class="panel-x" type="button" data-close aria-label="Fechar">${icon('close', 16)}</button>
      <p class="eyebrow"><i class="dot dot-${esc(e.area || 'none')}"></i>${esc(shortWhen(e.date))}</p>
      <h2 class="panel-title">${esc(e.title)}</h2>
      <p class="panel-sub">${esc([e.kind, e.mood].filter(Boolean).join(' · '))}${moodMeter(e.valence, e.mood)}</p>
      ${e.summary ? `<p class="panel-text">${esc(e.summary)}</p>` : ''}
      <div class="tags">${(e.tags || []).map(t => `<button type="button" class="tag" data-tags="${esc(t)}">${esc(t)}</button>`).join('')}</div>
      ${n.cluster?.name ? `<button type="button" class="in-cluster" data-cluster="${n.cluster.id}">${icon('sky', 15)} constelação <em>${esc(n.cluster.name)}</em></button>` : ''}
      ${near.length ? `<h3 class="panel-label">Mais próximos</h3>
        <ul class="rows">${near.map(([x, s]) => `<li><button type="button" data-node="${esc(x.path)}">
          <span class="t"><i class="dot dot-${esc(x.area || 'none')}"></i>${esc(x.title)}</span><span class="num">${Math.round(s * 100)}%</span></button></li>`).join('')}</ul>` : ''}
      <a class="btn btn-primary block" href="#/e/${encodeURIComponent(e.path)}">Abrir pensamento ${icon('arrow', 16)}</a>`;
  }

  function tagPanel(n) {
    const t = n.tag, c = stats.count.get(t), a = stats.area.get(t), [vs, vn] = stats.val.get(t);
    const pctWork = Math.round((100 * a.trabalho) / Math.max(1, a.trabalho + a.pessoal));
    const rel = relatedTags(stats, t).slice(0, 6);
    const maxLift = Math.max(1, ...rel.map(r => r.lift));
    const avg = vn ? vs / vn : null;
    return `<button class="panel-x" type="button" data-close aria-label="Fechar">${icon('close', 16)}</button>
      <p class="eyebrow">tag</p>
      <h2 class="panel-title">${esc(t)}</h2>
      <p class="panel-sub">${plural(c, 'pensamento', 'pensamentos')}${avg != null ? ` · humor médio ${avg > 0 ? '+' : ''}${fmtNum(avg)}` : ''}</p>
      <div class="split" role="img" aria-label="${pctWork}% trabalho, ${100 - pctWork}% pessoal"><span style="width:${pctWork}%"></span></div>
      <p class="split-legend"><span><i class="dot dot-trabalho"></i>${pctWork}% trabalho</span><span><i class="dot dot-pessoal"></i>${100 - pctWork}% pessoal</span></p>
      ${rel.length ? `<h3 class="panel-label">Aparece junto com</h3>
        <ul class="rows bars">${rel.map(r => `<li><button type="button" data-node="tag:${esc(r.tag)}">
          <span class="bar" style="width:${Math.round((r.lift / maxLift) * 100)}%"></span>
          <span class="t">${esc(r.tag)}</span><span class="num">${fmtLift(r.lift)} · ${r.c}</span></button></li>`).join('')}</ul>
        <p class="hint">× = quantas vezes mais juntas do que o acaso (lift) · nº de pensamentos.</p>` : ''}
      <h3 class="panel-label">Pensamentos</h3>
      <ul class="rows">${stats.byTag.get(t).slice(0, 5).map(e => `<li><a href="#/e/${encodeURIComponent(e.path)}">
        <span class="t"><i class="dot dot-${esc(e.area || 'none')}"></i>${esc(e.title)}</span><span class="num">${esc(dayMonth(e.date))}</span></a></li>`).join('')}</ul>
      <a class="btn btn-secondary block" href="#/pensamentos?tags=${encodeURIComponent(t)}">Ver todos com “${esc(t)}”</a>`;
  }

  // ----- interação -----

  $('#mode').addEventListener('click', ev => {
    const b = ev.target.closest('[data-v]');
    if (!b || b.dataset.v === st.mode) return;
    st.mode = b.dataset.v;
    st.sel = '';
    st.cluster = '';
    pos.clear();
    nodes = [];
    sync();
    build();
  });
  $('#area').addEventListener('click', ev => {
    const b = ev.target.closest('[data-v]');
    if (!b || b.dataset.v === st.area) return;
    st.area = b.dataset.v;
    sync();
    build();
  });
  $('#chips').addEventListener('click', ev => {
    const b = ev.target.closest('[data-tag]');
    if (!b) return;
    const t = b.dataset.tag;
    st.tags = st.tags.includes(t) ? st.tags.filter(x => x !== t) : [...st.tags, t];
    st.sel = '';
    st.cluster = '';
    sync();
    computeHighlight();
    renderControls();
    renderPanel();
    focusCurrent();
  });
  $('#handle').addEventListener('click', () => panel.classList.toggle('open'));
  body.addEventListener('click', ev => {
    const b = ev.target.closest('[data-node],[data-cluster],[data-tags],[data-close]');
    if (!b) return;
    if (b.hasAttribute('data-close')) { select(''); focusCurrent(); return; }
    if (b.dataset.node) {
      if (byId.has(b.dataset.node)) select(b.dataset.node, true);
      else location.hash = `#/e/${encodeURIComponent(b.dataset.node)}`;  // fora do filtro atual
      return;
    }
    st.sel = '';
    if (b.dataset.cluster != null) {
      st.cluster = st.cluster === b.dataset.cluster ? '' : b.dataset.cluster;
      if (st.mode !== 'pensamentos') return;
    } else {
      st.cluster = '';
      st.tags = b.dataset.tags.split(',').filter(Boolean);
      renderControls();
    }
    sync();
    computeHighlight();
    renderPanel();
    focusCurrent();
  });

  const pick = (ev, radius) => {
    const [x, y] = T.invert([ev.offsetX, ev.offsetY]);
    return sim.find(x, y, radius / T.k) || null;
  };
  canvas.addEventListener('pointermove', ev => {
    const n = pick(ev, 16);
    hover = n;
    canvas.classList.toggle('over-node', !!n);
    if (n && ev.pointerType === 'mouse') {
      const e = n.e;
      tip.innerHTML = n.kind === 'tag'
        ? `<b>${esc(n.tag)}</b><span>${plural(n.c, 'pensamento', 'pensamentos')}</span>`
        : `<span class="when">${esc(shortWhen(e.date))}</span><b>${esc(e.title)}</b>${e.summary ? `<span>${esc(truncate(e.summary, 140))}</span>` : ''}`;
      tip.hidden = false;
      const x = Math.min(ev.offsetX + 16, W - 300);
      tip.style.transform = `translate(${x}px, ${ev.offsetY + 16}px)`;
    } else {
      tip.hidden = true;
    }
  });
  canvas.addEventListener('pointerleave', () => { hover = null; tip.hidden = true; });
  canvas.addEventListener('click', ev => {
    const n = pick(ev, 18);
    if (n) select(n.id === st.sel ? '' : n.id);
    else if (st.sel || st.cluster) { st.cluster = ''; select(''); }
  });

  build();
  raf = requestAnimationFrame(frame);
}
