// Khaliya FX: synthesized sound engine + visual effects. No external assets, no dependencies.
// Exposes window.KFX. Everything degrades: reduced-motion → no animation loops, quiet → muted by default.
(() => {
  "use strict";
  const LS = "khaliya.sound";
  const mq = (q) => window.matchMedia && window.matchMedia(q).matches;
  const reduced = () => mq("(prefers-reduced-motion: reduce)");
  const L = () => (document.documentElement.lang === "en" ? "en" : "ar");
  const tr = (k, fb) => { const d = window.I18N || {}; return (d[L()] && d[L()][k]) || (d.en && d.en[k]) || fb || k; };

  // ======================= SOUND =======================
  const CATS = ["evolution", "discovery", "forge", "jobs", "alerts", "ui"];
  const CUE_CAT = { promotion: "evolution", rollback: "evolution", rejection: "evolution", record: "discovery", tool: "forge", done: "jobs", failed: "jobs", budget: "alerts", kill: "alerts", hover: "ui", click: "ui", open: "ui", notify: "alerts" };
  const defaults = () => ({ volume: 0.55, muted: reduced(), ambient: false, cats: { evolution: true, discovery: true, forge: true, jobs: true, alerts: true, ui: true } });
  let prefs;
  try { prefs = Object.assign(defaults(), JSON.parse(localStorage.getItem(LS) || "{}")); prefs.cats = Object.assign(defaults().cats, prefs.cats || {}); } catch { prefs = defaults(); }
  const save = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch {} emit(); };
  const listeners = new Set();
  const emit = () => listeners.forEach((f) => { try { f(prefs); } catch {} });

  let ctx = null, out = null, humNodes = null, unlocked = false, lastHover = 0;
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.2;
    out = ctx.createGain();
    out.gain.value = prefs.muted ? 0 : prefs.volume;
    out.connect(comp); comp.connect(ctx.destination);
    return ctx;
  }
  // Audio stays silent until the first user gesture (autoplay policy + courtesy).
  const unlock = () => {
    if (unlocked) return;
    unlocked = true;
    if (!ensure()) return;
    if (ctx.state === "suspended") ctx.resume();
    if (prefs.ambient && !prefs.muted) hum(true);
  };
  ["pointerdown", "keydown"].forEach((ev) => window.addEventListener(ev, unlock, { once: false, capture: true, passive: true }));

  function env(g, t0, a, peak, d) { g.gain.cancelScheduledValues(t0); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(peak, t0 + a); g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + d); }
  function tone(f, at, dur, { type = "sine", gain = 0.2, to = null, attack = 0.008, filter = null, detune = 0 } = {}) {
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t0); o.detune.value = detune;
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    let node = o;
    if (filter) { const bq = ctx.createBiquadFilter(); bq.type = "lowpass"; bq.frequency.value = filter; bq.Q.value = 0.7; o.connect(bq); node = bq; }
    node.connect(g); g.connect(out);
    env(g, t0, attack, gain, dur);
    o.start(t0); o.stop(t0 + attack + dur + 0.05);
  }
  function noise(at, dur, { gain = 0.15, freq = 800, type = "bandpass", q = 1 } = {}) {
    const t0 = ctx.currentTime + at;
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(), bq = ctx.createBiquadFilter(), g = ctx.createGain();
    s.buffer = buf; bq.type = type; bq.frequency.value = freq; bq.Q.value = q;
    s.connect(bq); bq.connect(g); g.connect(out);
    env(g, t0, 0.004, gain, dur);
    s.start(t0); s.stop(t0 + dur + 0.05);
  }
  const N = (semi) => 440 * Math.pow(2, (semi - 9) / 12) * 2; // semitones from C5
  const CUES = {
    promotion() { [0, 4, 7, 12].forEach((s, i) => tone(N(s), i * 0.075, 0.5 - i * 0.05, { type: "triangle", gain: 0.16 })); tone(N(-12), 0, 0.9, { type: "sine", gain: 0.12 }); tone(N(19), 0.3, 0.6, { type: "sine", gain: 0.05 }); },
    rollback() { tone(N(7), 0, 0.22, { type: "sine", gain: 0.16, to: N(2) }); tone(N(2), 0.18, 0.4, { type: "sine", gain: 0.14, to: N(-5) }); noise(0, 0.25, { gain: 0.03, freq: 600 }); },
    rejection() { tone(N(-15), 0, 0.14, { type: "square", gain: 0.07, filter: 900 }); tone(N(-18), 0.15, 0.24, { type: "square", gain: 0.07, filter: 700 }); },
    record() {
      [-5, 0, 4, 7].forEach((s, i) => tone(N(s), i * 0.11, 0.18, { type: "sawtooth", gain: 0.07, filter: 2600 }));
      [0, 4, 7, 12].forEach((s) => { tone(N(s), 0.46, 1.3, { type: "sawtooth", gain: 0.05, filter: 2200, attack: 0.03 }); tone(N(s), 0.46, 1.3, { type: "triangle", gain: 0.06, detune: 7, attack: 0.03 }); });
      tone(N(-12), 0.46, 1.4, { type: "sine", gain: 0.14, attack: 0.02 });
      for (let i = 0; i < 6; i++) tone(N(24 + [0, 4, 7, 12, 7, 4][i]), 0.6 + i * 0.07, 0.25, { type: "sine", gain: 0.03 });
      noise(0.46, 0.5, { gain: 0.04, freq: 7000, type: "highpass" });
    },
    tool() { tone(1320, 0, 0.35, { gain: 0.1 }); tone(1980, 0.005, 0.5, { gain: 0.06 }); tone(2640, 0.09, 0.3, { gain: 0.04 }); noise(0, 0.03, { gain: 0.06, freq: 4000 }); },
    done() { tone(N(9), 0, 0.14, { gain: 0.13 }); tone(N(16), 0.1, 0.3, { gain: 0.12 }); },
    failed() { tone(N(-3), 0, 0.18, { type: "triangle", gain: 0.13 }); tone(N(-9), 0.14, 0.34, { type: "triangle", gain: 0.12 }); },
    budget() { [0, 0.16].forEach((at) => tone(990, at, 0.09, { type: "square", gain: 0.05, filter: 2500 })); },
    kill() { for (let i = 0; i < 3; i++) tone(440, i * 0.34, 0.3, { type: "sawtooth", gain: 0.09, to: 880, filter: 1800 }); tone(55, 0, 0.6, { type: "sine", gain: 0.25, to: 35 }); noise(0, 0.2, { gain: 0.08, freq: 120, type: "lowpass" }); },
    notify() { tone(N(12), 0, 0.12, { gain: 0.08 }); tone(N(19), 0.07, 0.2, { gain: 0.06 }); },
    open() { tone(N(7), 0, 0.12, { type: "sine", gain: 0.05, to: N(12) }); },
    hover() { tone(2400, 0, 0.018, { gain: 0.012, attack: 0.002 }); },
    click() { tone(1150, 0, 0.03, { type: "triangle", gain: 0.04, attack: 0.002 }); noise(0, 0.015, { gain: 0.02, freq: 3000 }); },
  };
  function play(name) {
    if (!unlocked || prefs.muted || !CUES[name]) return;
    if (!prefs.cats[CUE_CAT[name] || "alerts"]) return;
    if (name === "hover") { const n = performance.now(); if (n - lastHover < 45) return; lastHover = n; }
    if (!ensure()) return;
    if (ctx.state === "suspended") ctx.resume();
    try { CUES[name](); } catch {}
  }
  function hum(on) {
    if (!ensure()) return;
    if (on && !humNodes) {
      const g = ctx.createGain(); g.gain.value = 0.0001;
      const bq = ctx.createBiquadFilter(); bq.type = "lowpass"; bq.frequency.value = 160; bq.Q.value = 3;
      const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.12; lg.gain.value = 60; lfo.connect(lg); lg.connect(bq.frequency);
      const oscs = [55, 55.35, 110.2].map((f, i) => { const o = ctx.createOscillator(); o.type = i === 2 ? "sine" : "sawtooth"; o.frequency.value = f; o.connect(bq); o.start(); return o; });
      bq.connect(g); g.connect(out); lfo.start();
      g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 2.5);
      humNodes = { g, oscs, lfo };
    } else if (!on && humNodes) {
      const h = humNodes; humNodes = null;
      h.g.gain.cancelScheduledValues(ctx.currentTime);
      h.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.4);
      setTimeout(() => { h.oscs.forEach((o) => o.stop()); h.lfo.stop(); h.g.disconnect(); }, 2000);
    }
  }
  function set(patch) {
    Object.assign(prefs, patch);
    if (patch.cats) prefs.cats = Object.assign({}, prefs.cats, patch.cats);
    if (ctx && out) out.gain.setTargetAtTime(prefs.muted ? 0 : prefs.volume, ctx.currentTime, 0.05);
    if (unlocked) hum(prefs.ambient && !prefs.muted);
    save();
  }
  const sound = { play, set, get: () => prefs, CATS, onChange: (f) => (listeners.add(f), () => listeners.delete(f)), toggleMute: () => { set({ muted: !prefs.muted }); if (!prefs.muted) { unlock(); play("notify"); } return prefs.muted; } };

  // ======================= SOUND PANEL =======================
  const SPK = (m) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z"/>${m ? '<path d="M17 9l5 6M22 9l-5 6"/>' : '<path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12"/>'}</svg>`;
  function soundPanel(anchor) {
    const old = document.querySelector(".snd-pop");
    if (old) { old.remove(); return; }
    const p = prefs;
    const pop = document.createElement("div");
    pop.className = "snd-pop"; pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", tr("snd_title", "Sound"));
    pop.innerHTML = `<div class="snd-h"><b>${tr("snd_title", "Sound")}</b><button class="btn xs ghost" data-x aria-label="${tr("close", "Close")}">✕</button></div>
      <label class="snd-row"><span>${tr("snd_mute", "Mute")}</span><input type="checkbox" data-k="muted" ${p.muted ? "checked" : ""}/></label>
      <label class="snd-row col"><span>${tr("snd_volume", "Volume")} <b class="num" data-vv>${Math.round(p.volume * 100)}%</b></span><input type="range" min="0" max="1" step="0.05" value="${p.volume}" data-k="volume"/></label>
      <label class="snd-row"><span>${tr("snd_ambient", "Hive hum")}</span><input type="checkbox" data-k="ambient" ${p.ambient ? "checked" : ""}/></label>
      <div class="snd-sep">${tr("snd_cats", "Categories")}</div>
      ${CATS.map((c) => `<label class="snd-row"><span>${tr("snd_cat_" + c, c)}</span><input type="checkbox" data-c="${c}" ${p.cats[c] ? "checked" : ""}/></label>`).join("")}
      <div class="snd-test">${["promotion", "record", "tool", "rollback", "rejection", "kill"].map((c) => `<button class="btn xs" data-t="${c}">${tr("snd_t_" + c, c)}</button>`).join("")}</div>`;
    document.body.appendChild(pop);
    const r = anchor && anchor.getBoundingClientRect();
    if (r) { pop.style.top = Math.max(10, Math.min(innerHeight - pop.offsetHeight - 10, r.top - pop.offsetHeight + r.height)) + "px"; pop.style.insetInlineStart = (document.dir === "rtl" ? innerWidth - r.left + 8 : r.right + 8) + "px"; if (innerWidth < 760) { pop.style.insetInlineStart = "10px"; pop.style.top = "60px"; } }
    pop.querySelector("[data-x]").onclick = () => pop.remove();
    pop.addEventListener("input", (e) => {
      const el = e.target; unlock();
      if (el.dataset.k === "volume") { set({ volume: Number(el.value) }); pop.querySelector("[data-vv]").textContent = Math.round(el.value * 100) + "%"; }
      else if (el.dataset.k) set({ [el.dataset.k]: el.checked });
      else if (el.dataset.c) set({ cats: { [el.dataset.c]: el.checked } });
    });
    pop.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { unlock(); const was = prefs.muted; if (was) set({ muted: false }); play(b.dataset.t); }));
    const off = (e) => { if (!pop.contains(e.target) && e.target !== anchor && !(anchor && anchor.contains(e.target))) { pop.remove(); document.removeEventListener("pointerdown", off, true); } };
    setTimeout(() => document.addEventListener("pointerdown", off, true), 0);
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); pop.remove(); anchor && anchor.focus(); } });
    pop.querySelector("input").focus();
  }

  // ======================= LIVING HONEYCOMB BACKGROUND =======================
  const bg = (() => {
    let cv, c2, W = 0, H = 0, DPR = 1, raf = 0, running = false, glows = [], tPrev = 0, slow = 0, quality = 1, lastFrame = 0;
    const R = 26; // hex radius (css px)
    const hx = R * Math.sqrt(3), hy = R * 1.5;
    function cellCenter(col, row) { return [col * hx + (row & 1 ? hx / 2 : 0), row * hy]; }
    function hexPath(ctx, x, y, r) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + (i * Math.PI) / 3; ctx[i ? "lineTo" : "moveTo"](x + r * Math.cos(a), y + r * Math.sin(a)); } ctx.closePath(); }
    function paintGrid() {
      // static grid → CSS background image of the canvas (painted once per resize, zero per-frame cost)
      const g = document.createElement("canvas"); g.width = Math.ceil(hx) * 2; g.height = Math.ceil(hy * 2);
      const x = g.getContext("2d"); x.strokeStyle = "rgba(245,184,61,0.055)"; x.lineWidth = 1;
      for (let r = -1; r < 3; r++) for (let c = -1; c < 3; c++) { const [cx, cy] = cellCenter(c, r); hexPath(x, cx, cy, R - 1); x.stroke(); }
      cv.style.backgroundImage = `url(${g.toDataURL()})`;
      cv.style.backgroundSize = `${g.width}px ${g.height}px`;
    }
    function resize() {
      DPR = Math.min(2, window.devicePixelRatio || 1) * (quality < 1 ? 0.6 : 1);
      W = innerWidth; H = innerHeight;
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      c2.setTransform(DPR, 0, 0, DPR, 0, 0);
    }
    function spawn(x, y, opts = {}) {
      let col, row;
      if (x == null) { col = Math.floor(Math.random() * (W / hx + 1)); row = Math.floor(Math.random() * (H / hy + 1)); }
      else { row = Math.round(y / hy); col = Math.round((x - (row & 1 ? hx / 2 : 0)) / hx); }
      const [cx, cy] = cellCenter(col, row);
      glows.push({ x: cx, y: cy, t: 0, life: opts.life || 2.4 + Math.random() * 2.6, hue: opts.hue || (Math.random() < 0.85 ? "245,184,61" : "232,116,59"), max: opts.max || 0.25 + Math.random() * 0.25, walk: opts.walk ?? (Math.random() < 0.3 ? 4 : 0) });
    }
    function frame(ts) {
      if (!running) return;
      raf = requestAnimationFrame(frame);
      const minDt = quality < 1 ? 33 : 15;
      if (ts - lastFrame < minDt) return;
      const dt = Math.min(0.1, (ts - (tPrev || ts)) / 1000);
      tPrev = ts; lastFrame = ts;
      // adaptive quality: sustained slow frames → fewer glows, lower resolution, 30fps
      if (dt > 0.034) slow++; else slow = Math.max(0, slow - 1);
      if (slow > 90 && quality === 1) { quality = 0.5; resize(); }
      const target = Math.round((W * H) / 52000 * quality) + 3;
      if (glows.length < target && Math.random() < 0.08) spawn();
      c2.clearRect(0, 0, W, H);
      for (let i = glows.length - 1; i >= 0; i--) {
        const g = glows[i];
        g.t += dt;
        const p = g.t / g.life;
        if (p >= 1) { if (g.walk > 0) { const dir = Math.floor(Math.random() * 6), a = (dir * Math.PI) / 3; spawn(g.x + hx * Math.cos(a), g.y + hx * Math.sin(a), { hue: g.hue, max: g.max * 0.85, life: g.life * 0.8, walk: g.walk - 1 }); } glows.splice(i, 1); continue; }
        const a = Math.sin(p * Math.PI) * g.max;
        hexPath(c2, g.x, g.y, R - 2);
        c2.fillStyle = `rgba(${g.hue},${(a * 0.22).toFixed(3)})`; c2.fill();
        c2.strokeStyle = `rgba(${g.hue},${a.toFixed(3)})`; c2.lineWidth = 1.2; c2.stroke();
      }
    }
    function start() { if (running || reduced() || document.hidden) return; running = true; tPrev = 0; raf = requestAnimationFrame(frame); }
    function stop() { running = false; cancelAnimationFrame(raf); }
    function init() {
      if (cv) return;
      cv = document.createElement("canvas"); cv.id = "fxBg"; cv.setAttribute("aria-hidden", "true");
      document.body.prepend(cv); c2 = cv.getContext("2d");
      if ((navigator.hardwareConcurrency || 4) <= 2 || (navigator.deviceMemory || 4) <= 2) quality = 0.5;
      resize(); paintGrid();
      let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resize, 150); });
      document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
      const m = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
      if (m && m.addEventListener) m.addEventListener("change", () => (reduced() ? (stop(), c2.clearRect(0, 0, W, H)) : start()));
      for (let i = 0; i < 6; i++) spawn();
      start();
    }
    function surge(x, y, hue) { if (!cv || reduced()) return; const cx = x ?? W / 2, cy = y ?? H / 2; for (let i = 0; i < 14; i++) spawn(cx + (Math.random() - 0.5) * 360, cy + (Math.random() - 0.5) * 240, { hue, max: 0.6, life: 1.2 + Math.random(), walk: 2 }); }
    return { init, start, stop, surge, pulse: (x, y, hue) => spawn(x, y, { hue, max: 0.7, life: 1.4, walk: 3 }) };
  })();

  // ======================= CONFETTI / BURST =======================
  function confetti({ x = innerWidth / 2, y = innerHeight / 3, count = 140, colors = ["#f5b83d", "#e8743b", "#ffe2a3", "#fff4dc", "#4cc38a"] } = {}) {
    if (reduced()) return flash("gold");
    const cv = document.createElement("canvas"); cv.className = "fx-overlay"; cv.setAttribute("aria-hidden", "true");
    const dpr = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
    document.body.appendChild(cv);
    const c = cv.getContext("2d"); c.scale(dpr, dpr);
    const ps = Array.from({ length: count }, () => { const a = Math.random() * Math.PI * 2, s = 4 + Math.random() * 9; return { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 6, r: 3 + Math.random() * 5, rot: Math.random() * 6, vr: (Math.random() - 0.5) * 0.4, col: colors[(Math.random() * colors.length) | 0], hex: Math.random() < 0.6 }; });
    let t0 = performance.now();
    (function f(ts) {
      const el = (ts - t0) / 1000;
      c.clearRect(0, 0, innerWidth, innerHeight);
      c.globalAlpha = Math.max(0, 1 - Math.max(0, el - 1.3) / 0.7);
      for (const p of ps) {
        p.vy += 0.32; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        c.save(); c.translate(p.x, p.y); c.rotate(p.rot); c.fillStyle = p.col;
        if (p.hex) { c.beginPath(); for (let i = 0; i < 6; i++) { const a = (i * Math.PI) / 3; c[i ? "lineTo" : "moveTo"](p.r * Math.cos(a), p.r * Math.sin(a)); } c.fill(); } else c.fillRect(-p.r, -p.r / 3, p.r * 2, p.r / 1.5);
        c.restore();
      }
      if (el < 2) requestAnimationFrame(f); else cv.remove();
    })(t0);
  }
  function burst(el, color = "245,184,61") {
    if (!el || reduced()) return;
    const r = el.getBoundingClientRect();
    const b = document.createElement("span"); b.className = "fx-burst"; b.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + r.height / 2}px;--c:${color}`;
    document.body.appendChild(b); setTimeout(() => b.remove(), 900);
  }
  function flash(kind = "red") { const f = document.createElement("div"); f.className = "fx-flash " + kind; f.setAttribute("aria-hidden", "true"); document.body.appendChild(f); setTimeout(() => f.remove(), 900); }
  function shake() { if (reduced()) return flash("red"); const a = document.getElementById("app"); if (!a) return; a.classList.remove("fx-shake"); void a.offsetWidth; a.classList.add("fx-shake"); flash("red"); setTimeout(() => a.classList.remove("fx-shake"), 600); }

  // ======================= COUNTERS =======================
  function countUp(root) {
    if (!root) return;
    const loc = L() === "ar" ? "ar-EG-u-nu-latn" : "en-US";
    root.querySelectorAll(".stat .value, [data-count]").forEach((el) => {
      if (el.dataset.counted) return; el.dataset.counted = "1";
      const node = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
      if (!node) return;
      const raw = node.textContent.trim(), num = Number(raw.replace(/[,\s٬]/g, ""));
      if (!isFinite(num) || num <= 0 || !/^[\d,٬.\s]+$/.test(raw)) return;
      if (reduced()) return;
      const nf = new Intl.NumberFormat(loc, { maximumFractionDigits: raw.includes(".") ? 2 : 0 });
      const dur = 700 + Math.min(600, num * 3), t0 = performance.now(), trail = node.textContent.match(/\s*$/)[0];
      (function f(ts) { const p = Math.min(1, (ts - t0) / dur), e = 1 - Math.pow(1 - p, 3); node.textContent = nf.format(num * e) + trail; if (p < 1) requestAnimationFrame(f); })(t0);
    });
  }

  // ======================= TOASTS =======================
  const ICON = {
    ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', err: '<path d="M12 7v6M12 16.5v.5"/><path d="M12 3l9.5 17h-19z"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.5"/>',
    warn: '<path d="M12 8v5M12 16v.5"/><circle cx="12" cy="12" r="9"/>', record: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0zM17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3"/>',
    promotion: '<path d="M12 19V5M5 12l7-7 7 7"/>', rollback: '<path d="M9 14L4 9l5-5"/><path d="M4 9h11a5 5 0 010 10h-3"/>', tool: '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>', kill: '<path d="M12 2v10"/><path d="M5.6 6.6a9 9 0 1012.8 0"/>',
  };
  function toast(msg, opts = {}) {
    if (typeof opts === "boolean") opts = { kind: opts ? "err" : "ok" };
    const kind = opts.kind || "ok";
    let wrap = document.getElementById("toasts");
    if (!wrap) { wrap = document.createElement("div"); wrap.id = "toasts"; wrap.setAttribute("role", "status"); wrap.setAttribute("aria-live", "polite"); document.body.appendChild(wrap); }
    const el = document.createElement("div");
    el.className = "tst " + kind;
    el.innerHTML = `<span class="tst-i"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[opts.icon || kind] || ICON.info}</svg></span><span class="tst-m" dir="auto"></span><button class="tst-x" aria-label="${tr("close", "Close")}">✕</button>`;
    el.querySelector(".tst-m").textContent = msg;
    wrap.appendChild(el);
    while (wrap.children.length > 4) wrap.firstElementChild.remove();
    requestAnimationFrame(() => el.classList.add("in"));
    const kill = () => { el.classList.remove("in"); el.classList.add("out"); setTimeout(() => el.remove(), 260); };
    el.querySelector(".tst-x").onclick = kill;
    setTimeout(kill, opts.ms || (kind === "err" ? 5200 : 3400));
    if (opts.sound !== false) play(opts.sound || (kind === "err" ? "failed" : kind === "warn" ? "budget" : "notify"));
  }

  // ======================= GLOBAL UI DELIGHT =======================
  function initUi() {
    document.addEventListener("pointerover", (e) => { const b = e.target.closest && e.target.closest(".btn,.nav a,[data-hov]"); if (b && !(e.relatedTarget && b.contains(e.relatedTarget))) play("hover"); }, { passive: true });
    document.addEventListener("pointerdown", (e) => {
      const b = e.target.closest && e.target.closest(".btn,.nav a");
      if (!b) return;
      play("click");
      if (reduced() || b.disabled) return;
      const r = b.getBoundingClientRect(), s = document.createElement("span");
      s.className = "rip"; s.style.cssText = `left:${e.clientX - r.left}px;top:${e.clientY - r.top}px`;
      if (getComputedStyle(b).position === "static") b.style.position = "relative";
      b.style.overflow = "hidden"; b.appendChild(s); setTimeout(() => s.remove(), 600);
    }, { passive: true });
  }

  window.KFX = { sound, soundPanel, SPK, bg, confetti, burst, flash, shake, countUp, toast, reduced, init() { bg.init(); initUi(); } };
})();
