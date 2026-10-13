'use strict';

// Fundo: poeira de estrelas à deriva que forma linhas de constelação perto do cursor.
// Fica parado com prefers-reduced-motion e é pausado na tela da Constelação (que tem o próprio céu).

const ambient = (() => {
  const canvas = document.getElementById('ambient');
  const ctx = canvas.getContext('2d');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: -9999, y: -9999 };
  const LINK = 120, NEAR = 170;
  let W = 0, H = 0, dpr = 1, pts = [], raf = 0, running = false, wanted = true;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    const n = Math.round(Math.min(110, (W * H) / 15000));
    pts = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.14, vy: (Math.random() - 0.5) * 0.14,
      r: 0.5 + Math.random() * 1.1, p: Math.random() * Math.PI * 2,
    }));
    draw(performance.now());
  }

  function draw(t) {
    const still = reduce.matches;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!still) {
      for (const p of pts) {
        p.x += p.vx;
        p.y += p.vy;
        const dx = pointer.x - p.x, dy = pointer.y - p.y;
        if (dx * dx + dy * dy < NEAR * NEAR) { p.x += dx * 0.0015; p.y += dy * 0.0015; }
        if (p.x < -10) p.x = W + 10; else if (p.x > W + 10) p.x = -10;
        if (p.y < -10) p.y = H + 10; else if (p.y > H + 10) p.y = -10;
      }
    }
    ctx.lineWidth = 0.6;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      for (let j = i + 1; j < pts.length; j++) {
        const b = pts[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
        if (d2 > LINK * LINK) continue;
        const near = Math.hypot((a.x + b.x) / 2 - pointer.x, (a.y + b.y) / 2 - pointer.y);
        const boost = near < NEAR ? (1 - near / NEAR) * 0.28 : 0;
        ctx.strokeStyle = `rgba(236,226,210,${((1 - Math.sqrt(d2) / LINK) * (0.045 + boost)).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    for (const p of pts) {
      const tw = still ? 0.6 : 0.5 + 0.5 * Math.sin(t / 1300 + p.p);
      const d = Math.hypot(p.x - pointer.x, p.y - pointer.y);
      const glow = d < NEAR ? 1 - d / NEAR : 0;
      ctx.fillStyle = `rgba(240,232,220,${(0.16 + 0.22 * tw + 0.5 * glow).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + glow * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function frame(t) {
    if (!running) return;
    draw(t);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || !wanted || document.hidden) return;
    if (reduce.matches) { draw(performance.now()); return; }
    running = true;
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(resize, 150); });
  window.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => { pointer.x = pointer.y = -9999; });
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  reduce.addEventListener('change', () => { stop(); start(); });

  resize();
  start();

  return {
    pause() { wanted = false; stop(); canvas.hidden = true; },
    resume() { wanted = true; canvas.hidden = false; start(); },
  };
})();
