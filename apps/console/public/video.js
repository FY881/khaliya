// Khaliya video: canvas intro, a generic scene player with WebM export (captureStream + MediaRecorder),
// and two scenes: Hive Replay (evolution timeline) and Discovery Replay (best score over generations).
// Exposes window.KVID. Captions are drawn into the canvas, so they are burned into exported video.
(() => {
  "use strict";
  const isAr = () => document.documentElement.lang !== "en";
  const tr = (k, fb) => { const d = window.I18N || {}, l = isAr() ? "ar" : "en"; return (d[l] && d[l][k]) || (d.en && d.en[k]) || fb || k; };
  const reduced = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const FONT = (w, px) => `${w} ${px}px "IBM Plex Sans Arabic", "Inter", system-ui, sans-serif`;
  const MONO = (px) => `500 ${px}px "JetBrains Mono", ui-monospace, monospace`;
  const AMBER = "245,184,61", ORANGE = "232,116,59", GREEN = "76,195,138", RED = "239,91,91", BLUE = "106,168,255";
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const ease = { out: (p) => 1 - Math.pow(1 - p, 3), inOut: (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2), back: (p) => { const c = 1.7; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); } };
  const nfmt = (n, d = 0) => (n == null || !isFinite(n) ? "—" : new Intl.NumberFormat(isAr() ? "ar-EG-u-nu-latn" : "en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 }).format(n));
  const short = (s) => { s = String(s ?? ""); return !s ? "—" : s.length > 12 ? s.slice(0, 6) + "…" + s.slice(-4) : s; };

  function hexPath(c, x, y, r, rot = Math.PI / 6) { c.beginPath(); for (let i = 0; i < 6; i++) { const a = rot + (i * Math.PI) / 3; c[i ? "lineTo" : "moveTo"](x + r * Math.cos(a), y + r * Math.sin(a)); } c.closePath(); }
  function bgFill(c, W, H, t = 0) {
    const g = c.createRadialGradient(W * 0.5, H * 0.45, 10, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    g.addColorStop(0, "#1c160d"); g.addColorStop(1, "#0a0806");
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    // faint drifting comb
    const R = 34, hx = R * Math.sqrt(3), hy = R * 1.5, off = (t * 6) % hy;
    c.strokeStyle = "rgba(245,184,61,0.045)"; c.lineWidth = 1;
    for (let row = -1; row < H / hy + 2; row++) for (let col = -1; col < W / hx + 1; col++) { hexPath(c, col * hx + (row & 1 ? hx / 2 : 0), row * hy - off, R - 1); c.stroke(); }
  }
  function text(c, s, x, y, { font = FONT(600, 20), color = "#f3ede2", align = "center", rtl = isAr(), shadow = 0, alpha = 1 } = {}) {
    c.save(); c.globalAlpha *= alpha; c.font = font; c.fillStyle = color; c.textAlign = align; c.textBaseline = "middle"; c.direction = rtl ? "rtl" : "ltr";
    if (shadow) { c.shadowColor = `rgba(${AMBER},0.6)`; c.shadowBlur = shadow; }
    c.fillText(s, x, y); c.restore();
  }
  function caption(c, W, H, s, alpha = 1) {
    if (!s) return;
    c.save(); c.font = FONT(600, 26); c.direction = isAr() ? "rtl" : "ltr";
    const w = Math.min(W - 80, c.measureText(s).width + 48), h = 52, x = (W - w) / 2, y = H - 92;
    c.globalAlpha = alpha * 0.82; c.fillStyle = "#0b0906"; roundRect(c, x, y, w, h, 12); c.fill();
    c.globalAlpha = alpha; c.strokeStyle = `rgba(${AMBER},0.35)`; c.lineWidth = 1; c.stroke();
    c.restore();
    text(c, s, W / 2, y + h / 2 + 1, { font: FONT(600, 26), alpha });
  }
  function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }

  // ======================= INTRO =======================
  function introCells() {
    const cells = [];
    for (let q = -3; q <= 3; q++) for (let r = -3; r <= 3; r++) { const s = -q - r; if (Math.abs(s) <= 3) cells.push({ q, r, d: Math.max(Math.abs(q), Math.abs(r), Math.abs(s)), a: Math.random() * Math.PI * 2, dist: 500 + Math.random() * 700, spin: (Math.random() - 0.5) * 4 }); }
    return cells;
  }
  function drawIntro(c, W, H, t, cells) {
    bgFill(c, W, H, t);
    const S = Math.min(W, H) / 13, cx = W / 2, cy = H / 2 - S * 0.4;
    for (const k of cells) {
      const start = 0.15 + (3 - k.d) * 0.16 + Math.random() * 0.0;
      const p = clamp((t - start) / 0.9, 0, 1), e = ease.back(p);
      const tx = cx + S * Math.sqrt(3) * (k.q + k.r / 2), ty = cy + S * 1.5 * k.r;
      const x = tx + Math.cos(k.a) * k.dist * (1 - e), y = ty + Math.sin(k.a) * k.dist * (1 - e);
      const wave = clamp(1 - Math.abs(t - 1.55 - k.d * 0.12) / 0.25, 0, 1);
      const dim = t > 2 ? clamp(1 - (t - 2) / 0.6, 0.35, 1) : 1;
      c.save(); c.globalAlpha = p * dim;
      hexPath(c, x, y, S * 0.92, Math.PI / 6 + k.spin * (1 - e));
      c.fillStyle = `rgba(${k.d === 0 ? ORANGE : AMBER},${0.06 + wave * 0.5 + (k.d === 0 ? 0.25 : 0)})`; c.fill();
      c.strokeStyle = `rgba(${AMBER},${0.35 + wave * 0.6})`; c.lineWidth = 1.5; c.stroke();
      c.restore();
    }
    // logotype
    const lp = clamp((t - 1.7) / 0.8, 0, 1);
    if (lp > 0) {
      const fs = Math.round(S * 2.6);
      c.save(); c.font = FONT(700, fs); c.textAlign = "center"; c.textBaseline = "middle"; c.direction = "rtl";
      const tw = c.measureText("خلية").width + 40;
      c.beginPath(); c.rect(cx + tw / 2 - tw * ease.out(lp), cy - fs, tw * ease.out(lp), fs * 2); c.clip();
      const g = c.createLinearGradient(cx - tw / 2, 0, cx + tw / 2, 0); g.addColorStop(0, "#e8743b"); g.addColorStop(0.5, "#ffd36b"); g.addColorStop(1, "#f5b83d");
      c.shadowColor = `rgba(${AMBER},0.7)`; c.shadowBlur = 40 * lp; c.fillStyle = g; c.fillText("خلية", cx, cy + fs * 0.05);
      c.restore();
      const sweep = clamp((t - 1.9) / 0.7, 0, 1);
      if (sweep > 0 && sweep < 1) { const sx = cx + tw / 2 - tw * sweep; const sg = c.createLinearGradient(sx - 40, 0, sx + 40, 0); sg.addColorStop(0, "rgba(255,255,255,0)"); sg.addColorStop(0.5, "rgba(255,244,220,0.35)"); sg.addColorStop(1, "rgba(255,255,255,0)"); c.fillStyle = sg; c.fillRect(sx - 40, cy - fs * 0.7, 80, fs * 1.4); }
      text(c, "K H A L I Y A", cx, cy + fs * 0.95, { font: MONO(Math.round(S * 0.42)), color: `rgba(${AMBER},0.9)`, rtl: false, alpha: clamp((t - 2.1) / 0.5, 0, 1) });
      text(c, tr("tagline", "Self-evolving agent organization"), cx, cy + fs * 1.35, { font: FONT(500, Math.round(S * 0.5)), color: "#a39a89", alpha: clamp((t - 2.3) / 0.5, 0, 1) });
    }
  }
  /** Plays the intro over the page once per session. Resolves when done or skipped. */
  function intro({ force = false } = {}) {
    return new Promise((resolve) => {
      if (reduced() || (!force && sessionStorage.getItem("khaliya.intro"))) return resolve();
      try { sessionStorage.setItem("khaliya.intro", "1"); } catch {}
      const wrap = document.createElement("div"); wrap.className = "intro"; wrap.setAttribute("role", "img"); wrap.setAttribute("aria-label", "خلية · Khaliya");
      const cv = document.createElement("canvas"); wrap.appendChild(cv);
      const skip = document.createElement("button"); skip.className = "btn xs ghost intro-skip"; skip.textContent = tr("skip", "Skip"); wrap.appendChild(skip);
      document.body.appendChild(wrap);
      const dpr = Math.min(2, devicePixelRatio || 1); cv.width = innerWidth * dpr; cv.height = innerHeight * dpr;
      const c = cv.getContext("2d"); c.scale(dpr, dpr);
      const cells = introCells(), T = 3.3, t0 = performance.now(); let done = false, raf;
      const end = () => { if (done) return; done = true; cancelAnimationFrame(raf); wrap.classList.add("out"); setTimeout(() => { wrap.remove(); resolve(); }, 450); window.removeEventListener("keydown", end, true); };
      skip.onclick = end; wrap.onclick = end; window.addEventListener("keydown", end, true);
      if (window.KFX) setTimeout(() => KFX.sound.play("open"), 1700);
      (function f(ts) { const t = (ts - t0) / 1000; drawIntro(c, innerWidth, innerHeight, t, cells); if (t >= T) return end(); raf = requestAnimationFrame(f); })(t0);
    });
  }

  // ======================= PLAYER =======================
  function pickMime() {
    if (!window.MediaRecorder) return null;
    for (const m of ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]) if (MediaRecorder.isTypeSupported(m)) return m;
    return null;
  }
  /**
   * scene: { title, duration (s), draw(c, W, H, t), caption(t) → string, filename }
   * Opens a theater modal with play/pause, scrub, speed, captions and Export WebM.
   */
  function player(scene) {
    const W = 1280, H = 720;
    const prev = document.activeElement;
    const wrap = document.createElement("div"); wrap.className = "theater-wrap";
    wrap.innerHTML = `<div class="theater" role="dialog" aria-modal="true" aria-label="${scene.title}">
      <div class="th-head"><b>${scene.title}</b><span class="th-rec" hidden><i></i>${tr("rec_recording", "Recording")} <span class="num" data-rp>0%</span></span><span class="spacer"></span><button class="btn xs ghost" data-x aria-label="${tr("close", "Close")}">✕</button></div>
      <canvas width="${W}" height="${H}" role="img" aria-label="${scene.title}"></canvas>
      <div class="th-ctrl">
        <button class="btn sm primary th-play" data-play aria-label="${tr("rp_play", "Play")}">▶</button>
        <input type="range" min="0" max="1000" value="0" data-scrub aria-label="${tr("rp_scrub", "Timeline")}"/>
        <span class="num faint th-time" data-time>0:00</span>
        <select class="sel-sm" data-speed aria-label="${tr("rp_speed", "Speed")}"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
        <label class="th-cap"><input type="checkbox" data-cap checked/> ${tr("rp_captions", "Captions")}</label>
        <button class="btn sm" data-export>${tr("rp_export", "Export WebM")}</button>
      </div></div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("open"));
    const cv = wrap.querySelector("canvas"), c = cv.getContext("2d");
    const $ = (s) => wrap.querySelector(s);
    const D = scene.duration;
    let t = 0, playing = false, speed = 1, caps = true, raf = 0, last = 0, rec = null;
    const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    function render() {
      c.save(); scene.draw(c, W, H, t); c.restore();
      if (caps && scene.caption) { const cp = scene.caption(t); if (cp) caption(c, W, H, cp.text || cp, cp.alpha ?? 1); }
      // tiny brand bug (burned in)
      text(c, "خلية · KHALIYA", 26, H - 24, { font: FONT(600, 15), color: `rgba(${AMBER},0.55)`, align: "left", rtl: false });
      $("[data-scrub]").value = Math.round((t / D) * 1000);
      $("[data-time]").textContent = `${fmt(t)} / ${fmt(D)}`;
    }
    function loop(ts) {
      if (!playing) return;
      const dt = last ? (ts - last) / 1000 : 0; last = ts;
      t = Math.min(D, t + dt * (rec ? 1 : speed));
      render();
      if (rec) $("[data-rp]").textContent = Math.round((t / D) * 100) + "%";
      if (t >= D) { pause(); if (rec) setTimeout(() => rec.stop(), 250); return; }
      raf = requestAnimationFrame(loop);
    }
    function play() { if (t >= D) t = 0; playing = true; last = 0; $("[data-play]").textContent = "❚❚"; $("[data-play]").setAttribute("aria-label", tr("rp_pause", "Pause")); raf = requestAnimationFrame(loop); }
    function pause() { playing = false; cancelAnimationFrame(raf); $("[data-play]").textContent = "▶"; $("[data-play]").setAttribute("aria-label", tr("rp_play", "Play")); }
    $("[data-play]").onclick = () => (playing ? pause() : play());
    $("[data-scrub]").oninput = (e) => { t = (Number(e.target.value) / 1000) * D; render(); };
    $("[data-speed]").onchange = (e) => (speed = Number(e.target.value));
    $("[data-cap]").onchange = (e) => { caps = e.target.checked; render(); };
    $("[data-export]").onclick = () => {
      const mime = pickMime();
      if (!mime || !cv.captureStream) { (window.KFX ? KFX.toast : alert)(tr("rp_no_rec", "This browser can't record canvas video"), { kind: "err" }); return; }
      const stream = cv.captureStream(30);
      const chunks = [];
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      rec.ondataavailable = (e) => e.data && e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((x) => x.stop());
        const blob = new Blob(chunks, { type: "video/webm" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
        a.download = `${scene.filename || "khaliya-replay"}-${new Date().toISOString().slice(0, 10)}.webm`;
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        rec = null; wrap.classList.remove("recording"); $(".th-rec").hidden = true;
        wrap.querySelectorAll("[data-export],[data-scrub],[data-speed],[data-play]").forEach((b) => (b.disabled = false));
        if (window.KFX) KFX.toast(`${tr("rp_saved", "Video saved")} · ${(blob.size / 1048576).toFixed(1)} MB`, { kind: "ok", sound: "done" });
      };
      wrap.classList.add("recording"); $(".th-rec").hidden = false;
      wrap.querySelectorAll("[data-export],[data-scrub],[data-speed],[data-play]").forEach((b) => (b.disabled = true));
      pause(); t = 0; render(); rec.start(250); play();
    };
    const close = () => { if (rec) { try { rec.onstop = null; rec.stop(); } catch {} } pause(); wrap.remove(); document.removeEventListener("keydown", key, true); if (prev && prev.focus) prev.focus(); };
    const key = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      else if (e.key === " " && e.target.tagName !== "BUTTON" && e.target.tagName !== "SELECT") { e.preventDefault(); if (!rec) playing ? pause() : play(); }
      else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.target.tagName !== "INPUT" && !rec) { t = clamp(t + (e.key === "ArrowRight" ? 2 : -2) * (isAr() ? -1 : 1), 0, D); render(); }
    };
    document.addEventListener("keydown", key, true);
    $("[data-x]").onclick = close;
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => { render(); if (!reduced()) play(); });
    $("[data-play]").focus();
    return { close };
  }

  // ======================= HIVE REPLAY SCENE =======================
  const ROLES = ["director", "architect", "researcher", "builder", "toolsmith", "evaluator", "critic", "librarian", "auditor"];
  const AX = { director: [0, 0], architect: [1, -1], researcher: [1, 0], builder: [0, 1], toolsmith: [-1, 1], evaluator: [-1, 0], critic: [0, -1], librarian: [2, -1], auditor: [-2, 1] };
  /**
   * data: { proposals:[{role,operator,stage,created_at,updated_at,genome_id}], promotions:[{kind,role,from_genome,to_genome,at,reason}],
   *         ratings:[{genome_id,role,rating}], roleLabel(r), opLabel(o), demo }
   */
  function hiveScene(data) {
    const rating = new Map((data.ratings || []).map((r) => [r.genome_id, Number(r.rating)]));
    const evs = [];
    for (const p of data.promotions || []) {
      const k = String(p.kind || "");
      if (k === "canary_start") continue;
      evs.push({ ts: p.at || 0, kind: k.includes("rollback") ? "rollback" : "promotion", role: p.role, from: p.from_genome, to: p.to_genome, elo: rating.get(p.to_genome) });
    }
    for (const p of data.proposals || []) {
      const st = p.stage;
      const ts = p.created_at || 0;
      evs.push({ ts, kind: "proposal", role: p.role, op: p.operator });
      if (["rejected", "lost", "rolled_back"].includes(st)) evs.push({ ts: (p.updated_at || ts) + 1, kind: "rejection", role: p.role, op: p.operator });
    }
    evs.sort((a, b) => a.ts - b.ts);
    const n = evs.length;
    const per = n ? clamp(54 / n, 0.35, 1.1) : 1;
    evs.forEach((e, i) => (e.t = 1.5 + i * per));
    const duration = Math.max(8, 1.5 + n * per + 2.5);
    const base = {}; ROLES.forEach((r) => (base[r] = { elo: 1500, v: 1 }));
    // initial Elo = earliest known rating of a from_genome per role
    for (const e of evs) if (e.kind === "promotion" && e.from && rating.has(e.from) && base[e.role] && !base[e.role]._set) { base[e.role].elo = rating.get(e.from); base[e.role]._set = 1; }
    const label = data.roleLabel || ((r) => r), opl = data.opLabel || ((o) => o);
    function stateAt(t) {
      const s = {}; ROLES.forEach((r) => (s[r] = { elo: base[r].elo, prevElo: base[r].elo, v: 1, last: null }));
      let gen = 0, cur = null;
      for (const e of evs) {
        if (e.t > t) break;
        const r = s[e.role]; if (!r) continue;
        if (e.kind === "proposal") gen++;
        if (e.kind === "promotion") { r.prevElo = r.elo; if (e.elo != null && isFinite(e.elo)) r.elo = e.elo; else r.elo += 12; r.v++; }
        if (e.kind === "rollback") { r.prevElo = r.elo; if (e.elo != null && isFinite(e.elo)) r.elo = e.elo; r.v = Math.max(1, r.v - 1); }
        r.last = e; cur = e;
      }
      return { s, gen, cur };
    }
    function pos(role, W, H) { const S = 84, [q, r] = AX[role] || [0, 0]; return [W / 2 + S * Math.sqrt(3) * (q + r / 2), H / 2 - 40 + S * 1.5 * r]; }
    function draw(c, W, H, t) {
      bgFill(c, W, H, t);
      const { s, gen, cur } = stateAt(t);
      const core = [W / 2, 58];
      // lineage edges: core → each role, plus director spokes
      c.lineWidth = 1;
      for (const r of ROLES) { const [x, y] = pos(r, W, H); c.strokeStyle = "rgba(245,184,61,0.10)"; c.beginPath(); c.moveTo(core[0], core[1]); c.quadraticCurveTo((core[0] + x) / 2, (core[1] + y) / 2 - 60, x, y); c.stroke(); }
      // flowing particles for events in flight
      for (const e of evs) {
        const dt = t - e.t; if (dt < -0.9 || dt > 1.4) continue;
        const [x, y] = pos(e.role, W, H);
        if ((e.kind === "promotion" || e.kind === "rollback") && dt < 0.1) {
          const p = clamp((dt + 0.9) / 1.0, 0, 1);
          const col = e.kind === "promotion" ? AMBER : BLUE;
          for (let k = 0; k < 14; k++) {
            const q = clamp(p - k * 0.035, 0, 1); if (q <= 0) continue;
            const qq = e.kind === "promotion" ? q : 1 - q;
            const mx = (core[0] + x) / 2, my = (core[1] + y) / 2 - 60;
            const px = (1 - qq) * (1 - qq) * core[0] + 2 * (1 - qq) * qq * mx + qq * qq * x, py = (1 - qq) * (1 - qq) * core[1] + 2 * (1 - qq) * qq * my + qq * qq * y;
            c.fillStyle = `rgba(${col},${(1 - k / 14) * 0.9})`; c.beginPath(); c.arc(px, py, 3.2 - k * 0.15, 0, 7); c.fill();
          }
        }
        if (dt >= 0 && dt < 1.4) {
          const p = dt / 1.4, col = e.kind === "promotion" ? AMBER : e.kind === "rollback" ? BLUE : e.kind === "rejection" ? RED : "255,244,220";
          const strength = e.kind === "proposal" ? 0.35 : 1;
          c.strokeStyle = `rgba(${col},${(1 - p) * strength})`; c.lineWidth = e.kind === "proposal" ? 1 : 3;
          hexPath(c, x, y, 76 + p * (e.kind === "proposal" ? 18 : 46)); c.stroke();
          if (e.kind === "promotion" && dt < 1.2) for (let k = 0; k < 18; k++) { const a = (k / 18) * Math.PI * 2 + e.t, d = 70 + ease.out(p) * 120; c.fillStyle = `rgba(${k & 1 ? AMBER : ORANGE},${1 - p})`; c.beginPath(); c.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 3, 0, 7); c.fill(); }
        }
      }
      // core (evolution lab)
      c.save(); c.shadowColor = `rgba(${ORANGE},0.8)`; c.shadowBlur = 24 + Math.sin(t * 3) * 8; hexPath(c, core[0], core[1], 22); c.fillStyle = `rgba(${ORANGE},0.85)`; c.fill(); c.restore();
      text(c, tr("rp_lab", "Evolution lab"), core[0] + 36, core[1], { font: FONT(500, 15), color: "#a39a89", align: "left", rtl: false });
      // role cells
      for (const r of ROLES) {
        const [x, y] = pos(r, W, H), st = s[r], le = st.last, age = le ? t - le.t : 99;
        const hot = le && le.kind === "promotion" ? clamp(1 - age / 2.5, 0, 1) : 0;
        const cold = le && le.kind === "rejection" ? clamp(1 - age / 1.2, 0, 1) : 0;
        const breath = 0.5 + 0.5 * Math.sin(t * 1.6 + x * 0.01);
        c.save();
        c.shadowColor = `rgba(${AMBER},${0.25 + hot * 0.6})`; c.shadowBlur = 14 + hot * 40 + breath * 6;
        hexPath(c, x, y, 74);
        const g = c.createLinearGradient(x - 70, y - 70, x + 70, y + 70);
        g.addColorStop(0, `rgba(${AMBER},${0.14 + hot * 0.4})`); g.addColorStop(1, `rgba(${ORANGE},${0.08 + hot * 0.3})`);
        c.fillStyle = g; c.fill();
        c.shadowBlur = 0; c.strokeStyle = cold ? `rgba(${RED},${0.5 + cold * 0.5})` : `rgba(${AMBER},${0.45 + hot * 0.55})`; c.lineWidth = 2; c.stroke();
        c.restore();
        text(c, label(r), x, y - 20, { font: FONT(700, label(r).length > 9 ? 16 : 19) });
        text(c, `v${st.v}`, x, y + 8, { font: MONO(14), color: "#a39a89", rtl: false });
        const d = st.elo - st.prevElo, showD = le && (le.kind === "promotion" || le.kind === "rollback") && age < 3 && d;
        text(c, `${nfmt(st.elo)} Elo${showD ? `  ${d > 0 ? "+" : ""}${nfmt(d)}` : ""}`, x, y + 30, { font: MONO(14), color: showD ? (d > 0 ? `rgb(${GREEN})` : `rgb(${RED})`) : `rgba(${AMBER},0.9)`, rtl: false });
      }
      // HUD
      text(c, tr("rp_hive_title", "Hive Replay"), 40, 36, { font: FONT(700, 26), align: "left", rtl: false });
      text(c, `${tr("rp_gen", "Generation")} ${nfmt(gen)}`, 40, 72, { font: FONT(600, 20), color: `rgb(${AMBER})`, align: "left", rtl: false });
      if (cur && cur.ts) text(c, new Intl.DateTimeFormat(isAr() ? "ar-EG-u-nu-latn" : "en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(cur.ts)), 40, 100, { font: FONT(500, 15), color: "#a39a89", align: "left", rtl: isAr() });
      // Elo strip
      const bw = Math.min(110, (W - 160) / ROLES.length), bx = (W - bw * ROLES.length) / 2, by = H - 150;
      const elos = ROLES.map((r) => s[r].elo), lo = Math.min(...elos) - 40, hi = Math.max(...elos) + 40;
      ROLES.forEach((r, i) => { const h = 6 + ((s[r].elo - lo) / (hi - lo || 1)) * 30; c.fillStyle = `rgba(${AMBER},0.12)`; c.fillRect(bx + i * bw + 12, by - 36, bw - 24, 36); c.fillStyle = `rgba(${AMBER},0.85)`; c.fillRect(bx + i * bw + 12, by - h, bw - 24, h); text(c, label(r), bx + i * bw + bw / 2, by + 13, { font: FONT(500, 12), color: "#6f675a" }); });
      if (data.demo) text(c, tr("rp_demo", "Demo preview — sample data"), W - 30, H - 24, { font: FONT(600, 15), color: `rgba(${RED},0.85)`, align: "right", rtl: false });
      if (t < 1.4) { c.fillStyle = `rgba(10,8,6,${1 - t / 1.4})`; c.fillRect(0, 0, W, H); }
      if (!n) text(c, tr("rp_empty", "No evolution events yet"), W / 2, H / 2 + 220, { font: FONT(600, 22), color: "#a39a89" });
    }
    function cap(t) {
      let e = null; for (const x of evs) { if (x.t > t) break; if (x.kind !== "proposal" || per > 0.6) e = x; }
      if (!e) return t < 1.5 ? { text: tr("rp_hive_intro", "The hive's evolution, generation by generation"), alpha: clamp(t / 0.6, 0, 1) } : null;
      const age = t - e.t, alpha = clamp(1 - (age - 2.2) / 0.5, 0, 1); if (alpha <= 0) return null;
      const R = label(e.role);
      const txt = e.kind === "promotion" ? `${tr("rp_c_promo", "Promotion")} · ${R}: ${short(e.from)} ← ${short(e.to)}${e.elo != null ? ` (${nfmt(e.elo)} Elo)` : ""}`
        : e.kind === "rollback" ? `${tr("rp_c_rollback", "Rollback")} · ${R} → ${short(e.to)}`
        : e.kind === "rejection" ? `${tr("rp_c_reject", "Rejected")} · ${R} · ${opl(e.op)}`
        : `${tr("rp_c_proposal", "Proposal")} · ${R} · ${opl(e.op)}`;
      return { text: txt, alpha };
    }
    // sound + DOM fx during live (non-export) playback is handled by the scene event hook
    return { title: tr("rp_hive_title", "Hive Replay"), duration, draw, caption: cap, filename: "khaliya-hive-replay" };
  }
  function demoHive() {
    const now = Date.now(), H = 3600e3, props = [], proms = [], ratings = [];
    const ops = ["prompt_rewrite", "strategy_swap", "tool_add", "crossover", "distill"];
    let k = 0;
    for (let i = 0; i < 26; i++) {
      const role = ROLES[(i * 5) % ROLES.length], ts = now - (26 - i) * H, outcome = i % 4 === 1 ? "promoted" : i % 3 === 0 ? "rejected" : "lost";
      props.push({ role, operator: ops[i % ops.length], stage: outcome, created_at: ts, updated_at: ts + 600e3 });
      if (outcome === "promoted") { const g = "g_demo_" + ++k; ratings.push({ genome_id: g, role, rating: 1500 + k * 23 }); proms.push({ kind: k === 5 ? "owner_rollback" : "promote", role, from_genome: "g_demo_" + (k - 1), to_genome: g, at: ts + 900e3 }); }
    }
    return { proposals: props, promotions: proms, ratings, demo: true };
  }

  // ======================= DISCOVERY REPLAY SCENE =======================
  /** data: { title, direction: "max"|"min", history:[{gen, best}], best_known, best_known_label } */
  function discoveryScene(data) {
    const h = (data.history || []).filter((x) => x && isFinite(x.best)).sort((a, b) => a.gen - b.gen);
    const dir = data.direction === "min" ? -1 : 1;
    const n = h.length, duration = clamp(2 + n * 0.22, 8, 32), T0 = 1.2, T1 = duration - 1.8;
    const improv = []; let best = null;
    h.forEach((x, i) => { if (best == null || (x.best - best) * dir > 1e-12) { if (best != null) improv.push({ i, gen: x.gen, best: x.best, prev: best }); best = x.best; } });
    const vals = h.map((x) => x.best).concat(data.best_known != null && isFinite(data.best_known) ? [data.best_known] : []);
    const lo = vals.length ? Math.min(...vals) : 0, hi = vals.length ? Math.max(...vals) : 1, pad = (hi - lo || Math.abs(hi) || 1) * 0.12;
    const prog = (t) => clamp((t - T0) / (T1 - T0), 0, 1);
    const dec = Math.abs(hi) < 10 ? 3 : Math.abs(hi) < 1000 ? 1 : 0;
    function draw(c, W, H, t) {
      bgFill(c, W, H, t);
      const L = 110, R = W - 70, Tp = 170, B = H - 170;
      const X = (i) => L + (n > 1 ? (i / (n - 1)) * (R - L) : (R - L) / 2), Y = (v) => B - ((v - (lo - pad)) / (hi - lo + 2 * pad || 1)) * (B - Tp);
      // axes + grid
      c.strokeStyle = "rgba(245,184,61,0.12)"; c.lineWidth = 1;
      for (let k = 0; k <= 4; k++) { const y = Tp + ((B - Tp) * k) / 4; c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); text(c, nfmt(hi + pad - ((hi - lo + 2 * pad) * k) / 4, dec), L - 14, y, { font: MONO(13), color: "#6f675a", align: "right", rtl: false }); }
      text(c, tr("rp_gen", "Generation"), (L + R) / 2, B + 36, { font: FONT(500, 15), color: "#6f675a" });
      if (n) { text(c, nfmt(h[0].gen), L, B + 16, { font: MONO(13), color: "#6f675a", rtl: false }); text(c, nfmt(h[n - 1].gen), R, B + 16, { font: MONO(13), color: "#6f675a", rtl: false }); }
      // best known
      if (data.best_known != null && isFinite(data.best_known)) {
        const y = Y(data.best_known); c.save(); c.setLineDash([8, 8]); c.strokeStyle = `rgba(${BLUE},0.75)`; c.lineWidth = 1.5; c.beginPath(); c.moveTo(L, y); c.lineTo(R, y); c.stroke(); c.restore();
        text(c, `${tr("dc_best_known", "Best known")} ${nfmt(data.best_known, dec)}${data.best_known_label ? " · " + data.best_known_label : ""}`, R, y - 14, { font: FONT(600, 14), color: `rgb(${BLUE})`, align: "right", rtl: false });
      }
      const p = prog(t), upto = p * (n - 1);
      if (n) {
        // area + line
        const k = Math.floor(upto), f = upto - k;
        const pts = h.slice(0, k + 1).map((x, i) => [X(i), Y(x.best)]);
        if (k < n - 1) pts.push([X(k) + (X(k + 1) - X(k)) * f, Y(h[k].best + (h[k + 1].best - h[k].best) * f)]);
        const g = c.createLinearGradient(0, Tp, 0, B); g.addColorStop(0, `rgba(${AMBER},0.28)`); g.addColorStop(1, `rgba(${AMBER},0)`);
        c.beginPath(); pts.forEach(([x, y], i) => c[i ? "lineTo" : "moveTo"](x, y)); c.lineTo(pts[pts.length - 1][0], B); c.lineTo(pts[0][0], B); c.closePath(); c.fillStyle = g; c.fill();
        c.save(); c.shadowColor = `rgba(${AMBER},0.7)`; c.shadowBlur = 14; c.beginPath(); pts.forEach(([x, y], i) => c[i ? "lineTo" : "moveTo"](x, y)); c.strokeStyle = `rgb(${AMBER})`; c.lineWidth = 3; c.stroke(); c.restore();
        const [hx, hy] = pts[pts.length - 1]; c.fillStyle = "#fff4dc"; c.beginPath(); c.arc(hx, hy, 5, 0, 7); c.fill();
        // improvements: rings + sparks
        for (const im of improv) {
          if (im.i > upto) break;
          const at = T0 + (im.i / Math.max(1, n - 1)) * (T1 - T0), dt = t - at, x = X(im.i), y = Y(im.best);
          c.fillStyle = `rgb(${AMBER})`; hexPath(c, x, y, 6); c.fill();
          if (dt >= 0 && dt < 1.3) { const q = dt / 1.3; c.strokeStyle = `rgba(${AMBER},${1 - q})`; c.lineWidth = 2.5; hexPath(c, x, y, 8 + q * 50); c.stroke(); for (let s = 0; s < 12; s++) { const a = (s / 12) * Math.PI * 2, d = 10 + ease.out(q) * 70; c.fillStyle = `rgba(${s & 1 ? AMBER : GREEN},${1 - q})`; c.fillRect(x + Math.cos(a) * d - 2, y + Math.sin(a) * d - 2, 4, 4); } }
        }
        // big counter
        const curBest = h.slice(0, Math.floor(upto) + 1).reduce((b, x) => (b == null || (x.best - b) * dir > 0 ? x.best : b), null);
        text(c, nfmt(curBest, dec), W - 70, 70, { font: FONT(700, 52), color: `rgb(${AMBER})`, align: "right", rtl: false, shadow: 18 });
        text(c, `${tr("dc_best", "Best")} · ${tr("rp_gen", "Generation")} ${nfmt(h[Math.min(n - 1, Math.floor(upto))].gen)}`, W - 70, 116, { font: FONT(500, 16), color: "#a39a89", align: "right", rtl: false });
      } else text(c, tr("dc_no_history", "No score history yet"), W / 2, H / 2, { font: FONT(600, 24), color: "#a39a89" });
      text(c, data.title || "", 40, 46, { font: FONT(700, 26), align: "left", rtl: false });
      text(c, `${tr("rp_disc_title", "Discovery Replay")} · ${data.direction === "min" ? tr("dc_min", "lower is better") : tr("dc_max", "higher is better")}`, 40, 82, { font: FONT(500, 16), color: `rgba(${AMBER},0.9)`, align: "left", rtl: false });
      if (data.demo) text(c, tr("rp_demo", "Demo preview — sample data"), W - 30, H - 24, { font: FONT(600, 15), color: `rgba(${RED},0.85)`, align: "right", rtl: false });
      if (t < 1) { c.fillStyle = `rgba(10,8,6,${1 - t})`; c.fillRect(0, 0, W, H); }
    }
    function cap(t) {
      const upto = prog(t) * (n - 1);
      let e = null; for (const im of improv) { if (im.i > upto) break; e = im; }
      if (!e) return t < T0 + 1 ? { text: tr("rp_disc_intro", "Evolving programs, verified every step"), alpha: clamp(t / 0.6, 0, 1) } : null;
      const at = T0 + (e.i / Math.max(1, n - 1)) * (T1 - T0), age = t - at, alpha = clamp(1 - (age - 2) / 0.5, 0, 1);
      if (alpha <= 0) return null;
      return { text: `${tr("rp_gen", "Generation")} ${nfmt(e.gen)}: ${tr("rp_c_newbest", "new best")} ${nfmt(e.best, dec)} (${e.best - e.prev > 0 ? "+" : ""}${nfmt(e.best - e.prev, dec)})`, alpha };
    }
    return { title: `${tr("rp_disc_title", "Discovery Replay")} · ${data.title || ""}`, duration, draw, caption: cap, filename: "khaliya-discovery-replay" };
  }

  window.KVID = { intro, player, hiveScene, demoHive, discoveryScene, hexPath };
})();
