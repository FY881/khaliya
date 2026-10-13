// Khaliya owner console — dependency-free SPA (hash routing), Arabic-first RTL with English toggle.
const API = window.KHALIYA_API_BASE || "";
const $app = document.getElementById("app");
const state = { lang: localStorage.getItem("khaliya.lang") || "ar", pending: 0, auditBefore: null, deskTab: "trace" };

// ---------- i18n ----------
const t = (k) => (window.I18N[state.lang] && window.I18N[state.lang][k]) || window.I18N.en[k] || k;
function applyLang() {
  document.documentElement.lang = state.lang;
  document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
  document.title = state.lang === "ar" ? "خلية · لوحة المالك" : "Khaliya · Owner console";
}
function toggleLang() {
  state.lang = state.lang === "ar" ? "en" : "ar";
  localStorage.setItem("khaliya.lang", state.lang);
  applyLang();
  route();
}

// ---------- utils ----------
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LOCALE = () => (state.lang === "ar" ? "ar-EG-u-nu-latn" : "en-US"); // Western digits read best on dashboards
const nf = (n) => new Intl.NumberFormat(LOCALE()).format(n ?? 0);
const when = (ms) => (ms ? new Intl.DateTimeFormat(state.lang === "ar" ? "ar-EG-u-nu-latn" : "en-GB", { dateStyle: "short", timeStyle: "medium" }).format(new Date(ms)) : "—");
const ago = (ms) => {
  if (!ms) return "—";
  const s = Math.round((Date.now() - ms) / 1000);
  const rtf = new Intl.RelativeTimeFormat(state.lang === "ar" ? "ar-EG-u-nu-latn" : "en", { numeric: "auto" });
  if (s < 60) return rtf.format(-s, "second");
  if (s < 3600) return rtf.format(-Math.round(s / 60), "minute");
  if (s < 86400) return rtf.format(-Math.round(s / 3600), "hour");
  return rtf.format(-Math.round(s / 86400), "day");
};
const pretty = (v) => esc(typeof v === "string" ? (() => { try { return JSON.stringify(JSON.parse(v), null, 2); } catch { return v; } })() : JSON.stringify(v, null, 2));
const badge = (s, label) => `<span class="badge ${esc(s)}">${esc(label ?? t("st_" + s) ?? s)}</span>`;
const roleLabel = (r) => tOr("role_" + r, r || "—");
const tOr = (k, fb) => { const v = t(k); return v === k ? fb : v; };
const roleGlyph = { director: "م", architect: "ع", researcher: "ب", builder: "ن", toolsmith: "ص", evaluator: "ق", critic: "ن", librarian: "ك", auditor: "د" };
const roleGlyphEn = { director: "D", architect: "A", researcher: "R", builder: "B", toolsmith: "T", evaluator: "E", critic: "C", librarian: "L", auditor: "U" };
const glyph = (r) => (state.lang === "ar" ? roleGlyph[r] : roleGlyphEn[r]) || "•";
const runBadge = (s) => badge(s, s);

let toastTimer;
function toast(msg, err = false, sound) {
  if (window.KFX) return KFX.toast(msg, { kind: err ? "err" : "ok", sound });
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ""), 3200);
}

class AuthError extends Error {}
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(API + path, {
    method,
    credentials: "include",
    headers: { "content-type": "application/json", "x-khaliya": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && path !== "/api/auth/login") throw new AuthError("unauthorized");
  if (!res.ok) {
    const e = new Error((data && data.error) || `${res.status}`);
    e.status = res.status;
    e.data = data;
    throw e;
  }
  return data;
}

// ---------- icons ----------
const I = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l8.66 5v10L12 22l-8.66-5V7z"/><circle cx="12" cy="11" r="3"/><path d="M7 18c1-2.5 3-3.5 5-3.5s4 1 5 3.5"/></svg>',
  runs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/></svg>',
  approvals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 12l2 2 4-4"/><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/></svg>',
  kill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2v10"/><path d="M5.6 6.6a9 9 0 1012.8 0"/></svg>',
  audit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>',
  evals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 3h6M10 3v5.5L4.8 18A2 2 0 006.5 21h11a2 2 0 001.7-3L14 8.5V3"/><path d="M7.5 15h9"/><circle cx="10.5" cy="17.6" r=".6" fill="currentColor"/><circle cx="13.6" cy="18.2" r=".6" fill="currentColor"/></svg>',
  evolution: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 3c0 4 10 5 10 9s-10 5-10 9"/><path d="M17 3c0 4-10 5-10 9s10 5 10 9"/><path d="M8.5 6.5h7M8.5 17.5h7M10.5 10h3M10.5 14h3"/></svg>',
  hive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3l4 2.3v4.6L8 12.2 4 9.9V5.3zM16 3l4 2.3v4.6l-4 2.3-4-2.3V5.3zM12 11.8l4 2.3v4.6L12 21l-4-2.3v-4.6z"/><circle cx="12" cy="16.4" r="1.2" fill="currentColor"/></svg>',
  forge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 9h11l3-3h4v4l-3 2H14"/><path d="M6 9v3a4 4 0 004 4h1M9 16l-2 5h10l-2-5"/></svg>',
  discovery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/><path d="M7.5 12l2-3 2 2 2-3"/></svg>',
  inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 01-2 2H4a2 2 0 01-2-2v-6z"/></svg>',
};
const LOGO = '<svg class="brand-mark" viewBox="0 0 64 64"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f5b83d"/><stop offset="1" stop-color="#e8743b"/></linearGradient></defs><path fill="url(#lg)" d="M32 4l24 14v28L32 60 8 46V18z"/><path fill="#14110d" d="M32 18l12 7v14l-12 7-12-7V25z"/><path fill="url(#lg)" d="M32 26l5 3v6l-5 3-5-3v-6z"/></svg>';

// ---------- shell ----------
const NAV = [
  ["overview", "nav_overview"], ["hive", "nav_hive"], ["agents", "nav_agents"], ["evolution", "nav_evolution"], ["evals", "nav_evals"], ["forge", "nav_forge"], ["discovery", "nav_discovery"], ["runs", "nav_runs"], ["approvals", "nav_approvals"],
  ["kill", "nav_kill"], ["audit", "nav_audit"], ["settings", "nav_settings"],
];
function shell(active, title, sub, content) {
  const nav = NAV.map(([k, label]) => `<a href="#/${k}" class="${active === k ? "active" : ""}">${I[k]}<span>${t(label)}</span>${k === "approvals" && state.pending ? `<span class="count">${nf(state.pending)}</span>` : ""}</a>`).join("");
  const mnav = NAV.map(([k, label]) => `<a href="#/${k}" class="${active === k ? "active" : ""}">${t(label)}</a>`).join("");
  $app.innerHTML = `
  <div class="shell">
    <aside class="side">
      <div class="brand">${LOGO}<div><div class="brand-name">${t("brand")}</div><div class="brand-tag">${t("tagline")}</div></div></div>
      <nav class="nav">${nav}</nav>
      <div class="side-foot">
        <div class="row side-tools"><button class="btn ghost sm" id="sndBtn" aria-label="${t("snd_title")}" title="${t("snd_title")} (M)">${window.KFX ? KFX.SPK(KFX.sound.get().muted) : ""}</button><button class="btn ghost sm grow" id="palBtn" title="${t("kb_palette")}"><span dir="ltr">Ctrl K</span></button><button class="btn ghost sm" id="helpBtn" aria-label="${t("kb_title")}" title="${t("kb_title")} (?)">?</button></div>
        <button class="btn ghost sm" id="langBtn">${t("lang")}</button>
        <button class="btn ghost sm" id="logoutBtn">${t("logout")}</button>
      </div>
    </aside>
    <div>
      <div class="mobile-nav">${mnav}<a href="#" id="langBtn2">${t("lang")}</a></div>
      <main class="main">
        <div class="topbar"><div><h1>${esc(title)}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}</div><div class="row" id="topActions"></div></div>
        <div id="content">${content}</div>
      </main>
    </div>
  </div>`;
  document.getElementById("langBtn").onclick = toggleLang;
  const sb = document.getElementById("sndBtn");
  if (sb && window.KFX) { sb.onclick = () => KFX.soundPanel(sb); }
  document.getElementById("palBtn").onclick = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }));
  document.getElementById("helpBtn").onclick = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "?" }));
  document.getElementById("langBtn2").onclick = (e) => { e.preventDefault(); toggleLang(); };
  document.getElementById("logoutBtn").onclick = async () => { try { await api("/api/auth/logout", { method: "POST" }); } catch {} renderLogin(); };
}
const content = () => document.getElementById("content");
const topActions = () => document.getElementById("topActions");

// ---------- login ----------
function renderLogin() {
  if (window.KEXT) KEXT.leave();
  if (window.KVID && !renderLogin._intro) { renderLogin._intro = 1; KVID.intro().then(() => { const c = document.getElementById("code"); if (c) c.focus(); }); }
  $app.innerHTML = `
  <div class="login-wrap"><form class="card login" id="loginForm" autocomplete="off">
    ${LOGO}
    <h1>${t("login_title")}</h1>
    <p>${t("login_sub")}</p>
    <input class="otp" id="code" inputmode="numeric" pattern="[0-9]*" maxlength="6" autofocus placeholder="••••••" aria-label="TOTP" />
    <button class="btn primary block" style="margin-top:14px;height:44px" id="loginBtn">${t("login_btn")}</button>
    <div class="err" id="loginErr"></div>
    <button type="button" class="btn ghost sm lang" id="loginLang">${t("lang")}</button>
  </form></div>`;
  const code = document.getElementById("code");
  code.addEventListener("input", () => { code.value = code.value.replace(/\D/g, "").slice(0, 6); if (code.value.length === 6) document.getElementById("loginForm").requestSubmit(); });
  document.getElementById("loginLang").onclick = () => { toggleLang(); renderLogin(); };
  document.getElementById("loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById("loginErr");
    err.textContent = "";
    try {
      await api("/api/auth/login", { method: "POST", body: { code: code.value } });
      if (!location.hash || location.hash === "#/login") location.hash = "#/overview";
      route();
    } catch (ex) {
      err.textContent = ex.status === 423 ? t("login_locked") : ex.status === 503 ? t("login_notcfg") : t("login_bad");
      code.value = "";
      code.focus();
    }
  };
}

// ---------- overview ----------
function meter(name, used, cap) {
  const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  return `<div class="meter"><div class="name" title="${esc(name)}">${esc(name)}</div><div class="bar"><div class="fill ${pct >= 80 ? "warn" : ""}" style="width:${pct.toFixed(1)}%"></div></div><div class="num"><b>${nf(used)}</b> / ${nf(cap)}</div></div>`;
}
function scopeName(scope, metric) {
  const [kind, id] = scope.split(":");
  const k = kind === "global" ? t("scope_global") : kind === "provider" ? `${t("scope_provider")} · ${id}` : `${t("scope_agent")} · ${id}`;
  return `${k} — ${t("metric_" + metric)}`;
}
async function renderOverview() {
  shell("overview", t("nav_overview"), "", `<div class="grid g4">${'<div class="skeleton"></div>'.repeat(4)}</div>`);
  const o = await api("/api/overview");
  state.pending = o.pending_approvals;
  const live = Object.entries(o.agents).filter(([s]) => s !== "retired").reduce((a, [, n]) => a + n, 0);
  const runsToday = Object.values(o.runs_today).reduce((a, n) => a + n, 0);
  const g = (m) => (o.usage.find((u) => u.scope === "global" && u.metric === m) || { used: 0 }).used;
  const globalMeters = ["llm_calls", "tokens", "tool_calls", "runs"].map((m) => meter(scopeName("global", m), g(m), o.caps.global[m])).join("");
  const provMeters = Object.entries(o.caps.provider).filter(([, cap]) => cap > 0).map(([p, cap]) => {
    const u = o.usage.find((x) => x.scope === "provider:" + p);
    return meter(scopeName("provider:" + p, "llm_calls"), u ? u.used : 0, cap);
  }).join("");
  const agentMeters = o.usage.filter((u) => u.scope.startsWith("agent:") && u.metric === "llm_calls").sort((a, b) => b.used - a.used).slice(0, 6).map((u) => meter(scopeName(u.scope, u.metric), u.used, u.cap)).join("");
  const P = o.providers;
  const prov = (name, on, extra) => `<div class="prov"><span class="dot ${on ? "on" : ""}"></span><div style="flex:1"><div style="font-weight:600">${esc(name)}</div><div class="faint" style="font-size:12px">${extra}</div></div>${badge(on ? "ok" : "draft", on ? t("configured") : t("not_configured"))}</div>`;
  shell("overview", t("nav_overview"), `${t("day")}: ${esc(o.day)}`, `
    <div class="hero ${o.kill_global ? "danger" : ""}"><span class="pulse"></span><div><div class="t">${o.kill_global ? t("status_killed") : t("status_running")}</div><div class="s">${t("mode")}: ${esc(P.mode)} · ${t("free_only")}</div></div><div class="spacer"></div><a class="btn sm ${o.kill_global ? "success" : "danger"}" href="#/kill">${t("nav_kill")}</a></div>
    <div class="grid g4">
      <div class="card stat"><div class="label">${t("agents_live")}</div><div class="value">${nf(live)} <small>/ ${nf(o.caps.population.live)}</small></div></div>
      <div class="card stat"><div class="label">${t("runs_today")}</div><div class="value">${nf(runsToday)}</div></div>
      <div class="card stat"><div class="label">${t("pending_approvals")}</div><div class="value">${nf(o.pending_approvals)}</div></div>
      <div class="card stat"><div class="label">${t("llm_calls")}</div><div class="value">${nf(g("llm_calls"))} <small>/ ${nf(o.caps.global.llm_calls)}</small></div></div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="card"><h2>${t("quotas")}</h2>${globalMeters}${provMeters}${agentMeters || ""}</div>
      <div class="card"><h2>${t("providers")}</h2>
        ${prov("Google Gemini", P.gemini.configured, `${nf(P.gemini.keys)} ${t("keys")} · ${nf(P.gemini.free_limits.rpm)} RPM · ${nf(P.gemini.free_limits.rpd)} RPD`)}
        ${prov("OpenRouter :free", P.openrouter.configured, `${nf(P.openrouter.keys)} ${t("keys")} · ${t("free_only")}`)}
        ${prov("Workers AI", P.workers_ai.configured, `${nf(P.workers_ai.free_limits.rpd)} RPD`)}
        <div class="faint mono" style="margin-top:12px;direction:ltr;text-align:start">${P.default_chain.map(esc).join(" → ")}</div>
      </div>
    </div>`);
  const hot = o.usage.some((u) => u.cap > 0 && u.used / u.cap >= 0.8) || ["llm_calls", "tokens", "tool_calls", "runs"].some((m) => o.caps.global[m] > 0 && g(m) / o.caps.global[m] >= 0.8);
  if (hot && window.KFX && !sessionStorage.getItem("khaliya.budgetWarn")) { sessionStorage.setItem("khaliya.budgetWarn", "1"); KFX.toast(t("budget_warn"), { kind: "warn", sound: "budget" }); }
}

// ---------- agents ----------
async function renderAgents() {
  shell("agents", t("nav_agents"), "", `<div class="agents">${'<div class="skeleton"></div>'.repeat(8)}</div>`);
  const { agents } = await api("/api/agents");
  if (!agents.length) {
    content().innerHTML = `<div class="card empty">${I.agents}<div>${t("seed_empty")}</div><button class="btn primary" style="margin-top:14px" id="seedBtn">${t("seed_btn")}</button></div>`;
    document.getElementById("seedBtn").onclick = seed;
    return;
  }
  content().innerHTML = `<div class="agents">${agents.map((a) => `
    <div class="card agent" data-id="${esc(a.id)}">
      <div class="top"><div class="hex ${a.killed || a.status === "retired" ? "off" : ""}">${esc(glyph(a.role))}</div><div><div class="nm">${esc(state.lang === "ar" ? roleLabel(a.role) : a.name)}</div><div class="id">${esc(a.id)}</div></div></div>
      <div class="meta">${badge(a.status)}${a.killed ? badge("killed", t("killed")) : ""}</div>
    </div>`).join("")}</div>`;
  content().querySelectorAll(".agent").forEach((el) => (el.onclick = () => (location.hash = "#/agents/" + el.dataset.id)));
}
async function seed() {
  try { await api("/api/seed", { method: "POST" }); toast("✓"); route(); } catch (e) { toast(e.message, true); }
}

function traceView(trace) {
  if (!trace || !trace.length) return `<div class="empty">${t("no_trace")}</div>`;
  return `<div class="timeline">${trace.map((e) => `
    <div class="ev ${esc(e.phase)}"><div class="h"><span class="ph">${esc(t("ph_" + e.phase))}</span>${e.step != null ? `<span class="step">#${esc(e.step)}</span>` : ""}<span class="faint" style="font-size:11.5px">${esc(new Date(e.at).toLocaleTimeString())}</span></div>
      <div class="sm" dir="auto">${esc(e.summary)}</div>
      ${e.data != null && e.data !== "" ? `<details><summary>JSON</summary><pre class="json">${pretty(e.data)}</pre></details>` : ""}
    </div>`).join("")}</div>`;
}

async function renderDesk(id) {
  shell("agents", t("desk"), "", `<div class="skeleton"></div>`);
  const d = await api(`/api/agents/${encodeURIComponent(id)}/desk`);
  const a = d.agent;
  const statuses = ["draft", "sandboxed", "candidate", "champion", "retired", "quarantined"];
  const tabs = [["trace", "tab_trace"], ["memory", "tab_memory"], ["tools", "tab_tools"], ["inbox", "tab_inbox"], ["genome", "tab_genome"]];
  const tabBody = {
    trace: () => `${d.current ? `<div class="hero" style="margin-bottom:14px"><span class="pulse"></span><div><div class="t">${t("current_task")}</div><div class="s" dir="auto">${esc(d.current.task)}</div></div></div>` : ""}${traceView(d.trace)}`,
    memory: () => (d.memory.length ? `<div class="faint" style="margin-bottom:6px">${nf(d.memory_count)}</div>` + d.memory.map((m) => `<div class="mem"><div class="row"><span class="k ${esc(m.kind)}">${esc(m.kind)}</span><span class="w">${esc(ago(m.at))}</span></div><div dir="auto">${esc(m.text)}</div></div>`).join("") : `<div class="empty">${t("no_memory")}</div>`),
    tools: () => d.tools.map((x) => `<div class="tool"><span class="tier t${x.tier}">T${esc(x.tier)}</span><div><div class="tn">${esc(x.id)}</div><div class="td">${esc(x.description)}</div></div></div>`).join("") || `<div class="empty">—</div>`,
    inbox: () => (d.inbox.length ? d.inbox.map((m) => `<div class="mem"><div class="row"><span class="k">${esc(m.from_id)}</span><span class="w">${esc(ago(m.at))}</span>${m.read ? "" : badge("pending", "new")}</div><div dir="auto">${esc(m.text)}</div></div>`).join("") : `<div class="empty">${t("no_inbox")}</div>`),
    genome: () => `<pre class="json" style="max-height:600px">${pretty(d.genome)}</pre>`,
  };
  shell("agents", esc(state.lang === "ar" ? roleLabel(a.role) : a.name), `<a href="#/agents">← ${t("back")}</a>`, `
    <div class="desk-head"><div class="hex ${d.killed ? "off" : ""}">${esc(glyph(a.role))}</div><div><div class="row">${badge(a.status)}${d.killed ? badge("killed", t("killed")) : ""}</div><div class="faint mono" style="margin-top:4px">${esc(a.id)} · ${esc(a.genome_id)}</div></div></div>
    <div class="desk-cols">
      <div class="card"><div class="tabs">${tabs.map(([k, l]) => `<div class="tab ${state.deskTab === k ? "active" : ""}" data-tab="${k}">${t(l)}</div>`).join("")}</div><div id="tabBody">${tabBody[state.deskTab]()}</div></div>
      <div class="stack">
        <div class="card"><h2>${t("run_task")}</h2><textarea id="task" placeholder="${esc(t("run_placeholder"))}"></textarea>
          <div class="row" style="margin-top:10px"><button class="btn primary" id="runBtn">${t("run_btn")}</button><button class="btn" id="queueBtn">${t("queue_btn")}</button></div></div>
        <div class="card"><h2>${t("messages_send")}</h2><textarea id="msg" style="min-height:60px"></textarea><button class="btn sm" style="margin-top:8px" id="msgBtn">${t("send")}</button></div>
        <div class="card"><h2>${t("change_status")}</h2><div class="row"><select id="st">${statuses.map((s) => `<option value="${s}" ${s === a.status ? "selected" : ""}>${t("st_" + s)}</option>`).join("")}</select><button class="btn sm" id="stBtn">${t("save")}</button></div>
          <div style="margin-top:12px">${d.killed ? `<button class="btn success block" id="resumeBtn">${t("resume_agent")}</button>` : `<button class="btn danger block" id="killBtn">${t("kill_agent")}</button>`}</div></div>
      </div>
    </div>`);
  document.querySelectorAll(".tab").forEach((el) => (el.onclick = () => { state.deskTab = el.dataset.tab; document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === el)); document.getElementById("tabBody").innerHTML = tabBody[state.deskTab](); }));
  const runIt = async (wait) => {
    const task = document.getElementById("task").value.trim();
    if (!task) return;
    const btn = document.getElementById(wait ? "runBtn" : "queueBtn");
    btn.disabled = true;
    btn.innerHTML = `<span class="spin"></span>`;
    try {
      const r = await api(`/api/agents/${encodeURIComponent(id)}/run`, { method: "POST", body: { task, wait } });
      toast(wait ? `${r.status}: ${r.final || r.stop_reason || ""}`.slice(0, 160) : `queued ${r.run_id}`);
      state.deskTab = "trace";
      setTimeout(() => renderDesk(id), wait ? 0 : 1500);
    } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = wait ? t("run_btn") : t("queue_btn"); }
  };
  document.getElementById("runBtn").onclick = () => runIt(true);
  document.getElementById("queueBtn").onclick = () => runIt(false);
  document.getElementById("msgBtn").onclick = async () => { const text = document.getElementById("msg").value.trim(); if (!text) return; try { await api(`/api/agents/${encodeURIComponent(id)}/message`, { method: "POST", body: { text } }); toast("✓"); renderDesk(id); } catch (e) { toast(e.message, true); } };
  document.getElementById("stBtn").onclick = async () => { try { await api(`/api/agents/${encodeURIComponent(id)}/status`, { method: "PATCH", body: { status: document.getElementById("st").value } }); toast(t("saved")); renderDesk(id); } catch (e) { toast(e.message, true); } };
  const kb = document.getElementById("killBtn"), rb = document.getElementById("resumeBtn");
  if (kb) kb.onclick = async () => { await api(`/api/agents/${encodeURIComponent(id)}/kill`, { method: "POST" }); renderDesk(id); };
  if (rb) rb.onclick = async () => { await api(`/api/agents/${encodeURIComponent(id)}/resume`, { method: "POST" }); renderDesk(id); };
}

// ---------- runs ----------
async function renderRuns() {
  shell("runs", t("nav_runs"), "", `<div class="skeleton"></div>`);
  const { runs } = await api("/api/runs?limit=100");
  if (!runs.length) { content().innerHTML = `<div class="card empty">${I.runs}<div>${t("no_runs")}</div></div>`; return; }
  content().innerHTML = `<div class="card" style="overflow:auto"><table class="table"><thead><tr><th>${t("col_when")}</th><th>${t("col_agent")}</th><th>${t("col_task")}</th><th>${t("col_status")}</th><th>${t("col_steps")}</th><th>${t("col_tokens")}</th><th>${t("col_time")}</th></tr></thead><tbody>
    ${runs.map((r) => `<tr class="click" data-id="${esc(r.id)}"><td class="faint">${esc(ago(r.created_at))}</td><td class="mono">${esc(r.agent_id)}</td><td class="trunc" dir="auto" title="${esc(r.task)}">${esc(r.task)}</td><td>${runBadge(r.status)}</td><td class="num">${nf(r.steps)}</td><td class="num">${nf(r.tokens)}</td><td class="num">${r.wall_ms ? nf(Math.round(r.wall_ms / 100) / 10) + "s" : "—"}</td></tr>`).join("")}
  </tbody></table></div>`;
  content().querySelectorAll("tr.click").forEach((el) => (el.onclick = () => (location.hash = "#/runs/" + el.dataset.id)));
}
async function renderRun(id) {
  shell("runs", t("trace"), "", `<div class="skeleton"></div>`);
  const { run, trace } = await api(`/api/runs/${encodeURIComponent(id)}`);
  shell("runs", `${t("col_run")} ${esc(run.id)}`, `<a href="#/runs">← ${t("back")}</a>`, `
    <div class="grid g4">
      <div class="card stat"><div class="label">${t("col_status")}</div><div style="margin-top:10px">${runBadge(run.status)}</div><div class="faint" style="font-size:12px;margin-top:6px">${esc(run.stop_reason || "")}</div></div>
      <div class="card stat"><div class="label">${t("col_steps")}</div><div class="value">${nf(run.steps)}</div></div>
      <div class="card stat"><div class="label">${t("col_tokens")}</div><div class="value">${nf(run.tokens)}</div></div>
      <div class="card stat"><div class="label">${t("col_time")}</div><div class="value">${nf(Math.round((run.wall_ms || 0) / 100) / 10)}<small>s</small></div></div>
    </div>
    <div class="grid g2" style="margin-top:16px;align-items:start">
      <div class="card"><h2>${t("trace")}</h2>${traceView(trace)}</div>
      <div class="stack"><div class="card"><h2>${t("col_task")}</h2><div dir="auto">${esc(run.task)}</div><div class="faint" style="margin-top:8px"><a href="#/agents/${esc(run.agent_id)}">${esc(run.agent_id)}</a> · ${esc(when(run.created_at))}</div></div>
      <div class="card"><h2>${t("result")}</h2><div style="white-space:pre-wrap" dir="auto">${esc(run.result || "—")}</div><div class="faint mono" style="margin-top:10px;font-size:11px;direction:ltr;text-align:start">prompt_hash ${esc(run.prompt_hash || "—")}</div></div></div>
    </div>`);
}

// ---------- approvals ----------
async function renderApprovals() {
  const filter = new URLSearchParams(location.hash.split("?")[1] || "").get("s") || "pending";
  shell("approvals", t("nav_approvals"), "", `<div class="skeleton"></div>`);
  const { approvals } = await api("/api/approvals" + (filter === "all" ? "" : "?status=pending"));
  if (filter === "pending") state.pending = approvals.length;
  shell("approvals", t("nav_approvals"), "", "");
  topActions().innerHTML = `<a class="btn sm ${filter === "pending" ? "primary" : ""}" href="#/approvals?s=pending">${t("pending")}</a><a class="btn sm ${filter === "all" ? "primary" : ""}" href="#/approvals?s=all">${t("all")}</a>`;
  if (!approvals.length) { content().innerHTML = `<div class="card empty">${I.approvals}<div>${t("approvals_empty")}</div></div>`; return; }
  content().innerHTML = approvals.map((a) => `
    <div class="card apr">
      <div><div class="title"><span class="tier t${a.tier}">T${esc(a.tier)}</span><span class="mono">${esc(a.tool_id)}</span>${badge(a.status, a.status)}<span class="faint" style="font-weight:400;font-size:12.5px">${esc(a.agent_id)} · ${esc(ago(a.created_at))}</span></div>
        ${a.reason ? `<div class="muted" style="margin-top:6px">${esc(a.reason)}</div>` : ""}
        <pre class="json">${pretty(a.args)}</pre>
        ${a.result ? `<div class="faint" style="margin-top:8px">${t("result")}</div><pre class="json">${pretty(a.result)}</pre>` : ""}
      </div>
      ${a.status === "pending" ? `<div class="stack" style="min-width:140px"><button class="btn success" data-act="approve" data-id="${esc(a.id)}" data-tier="${a.tier}">${t("approve")}</button><button class="btn danger" data-act="reject" data-id="${esc(a.id)}">${t("reject")}</button></div>` : "<div></div>"}
    </div>`).join("");
  content().querySelectorAll("button[data-act]").forEach((b) => (b.onclick = async () => {
    const body = {};
    if (b.dataset.act === "approve" && Number(b.dataset.tier) >= 4) {
      const code = prompt(t("stepup_prompt"));
      if (!code) return;
      body.code = code.trim();
    }
    try { await api(`/api/approvals/${encodeURIComponent(b.dataset.id)}/${b.dataset.act}`, { method: "POST", body }); toast("✓"); renderApprovals(); } catch (e) { toast(e.message, true); }
  }));
}

// ---------- kill switch ----------
async function renderKill() {
  shell("kill", t("nav_kill"), "", `<div class="skeleton"></div>`);
  const [g, { agents }] = await Promise.all([api("/api/governor"), api("/api/agents")]);
  shell("kill", t("nav_kill"), "", `
    <div class="card big-kill ${g.kill_global ? "" : ""}"><div class="ico">${I.kill}</div><div style="flex:1"><div style="font-size:18px;font-weight:700">${t("kill_title")}</div><div class="muted">${t("kill_desc")}</div><div style="margin-top:8px">${g.kill_global ? badge("killed", t("status_killed")) : badge("ok", t("status_running"))}</div></div>
      ${g.kill_global ? `<button class="btn success" id="gk" style="height:46px">${t("kill_off")}</button>` : `<button class="btn danger" id="gk" style="height:46px">${t("kill_on")}</button>`}</div>
    <div class="grid g2" style="margin-top:16px;align-items:start">
      <div class="card"><h2>${t("per_agent")}</h2>${agents.map((a) => `<div class="ka"><div class="hex ${a.killed ? "off" : ""}" style="width:32px;height:32px;font-size:14px">${esc(glyph(a.role))}</div><div style="flex:1"><div style="font-weight:600">${esc(state.lang === "ar" ? roleLabel(a.role) : a.name)}</div><div class="faint mono" style="font-size:11.5px">${esc(a.id)}</div></div><label class="switch"><input type="checkbox" data-id="${esc(a.id)}" ${a.killed ? "checked" : ""}/><span></span></label></div>`).join("") || `<div class="empty">—</div>`}</div>
      <div class="card"><h2>${t("constitution")}</h2><ol class="articles">${(state.lang === "ar" && window.I18N.ar.articles.length === g.constitution.articles.length ? window.I18N.ar.articles : g.constitution.articles.map((x) => x.replace(/^\d+\.\s*/, ""))).map((x) => `<li dir="auto">${esc(x)}</li>`).join("")}</ol></div>
    </div>`);
  document.getElementById("gk").onclick = async () => {
    const on = !g.kill_global;
    if (on && !(await dialog({ title: t("kill_title"), body: esc(t("confirm_kill")), confirm: t("kill_on"), danger: true }))) return;
    await api("/api/governor/kill", { method: "POST", body: { on } });
    if (window.KFX) { if (on) { KFX.sound.play("kill"); KFX.shake(); KFX.toast(t("kill_engaged"), { kind: "err", icon: "kill", sound: false }); } else { KFX.sound.play("done"); KFX.toast(t("kill_released"), { kind: "ok", sound: false }); } }
    else toast("✓");
    renderKill();
  };
  content().querySelectorAll("input[type=checkbox][data-id]").forEach((cb) => (cb.onchange = async () => {
    try { await api(`/api/agents/${encodeURIComponent(cb.dataset.id)}/${cb.checked ? "kill" : "resume"}`, { method: "POST" }); if (cb.checked && window.KFX) { KFX.sound.play("rejection"); KFX.flash("red"); } toast("✓"); } catch (e) { toast(e.message, true); cb.checked = !cb.checked; }
  }));
}

// ---------- audit ----------
async function renderAudit(append = false) {
  if (!append) { state.auditBefore = null; shell("audit", t("nav_audit"), "", `<div class="skeleton"></div>`); }
  const q = state.auditBefore ? `?limit=100&before=${state.auditBefore}` : "?limit=100";
  const { entries } = await api("/api/audit" + q);
  const rows = entries.map((e) => `<tr><td class="faint num">${esc(e.seq)}</td><td class="faint">${esc(when(e.at))}</td><td class="mono">${esc(e.actor)}</td><td><b>${esc(e.action)}</b></td><td class="mono trunc">${esc(e.target || "")}</td><td class="mono trunc faint" title="${esc(e.detail || "")}">${esc(e.detail || "")}</td></tr>`).join("");
  if (!append) {
    content().innerHTML = `<div class="card" style="overflow:auto"><table class="table"><thead><tr><th>#</th><th>${t("col_when")}</th><th>${t("col_actor")}</th><th>${t("col_action")}</th><th>${t("col_target")}</th><th>${t("col_detail")}</th></tr></thead><tbody id="auditBody">${rows}</tbody></table>
      <div class="row" style="margin-top:12px;justify-content:center"><button class="btn sm" id="more">${t("load_more")}</button></div></div>`;
    topActions().innerHTML = `<span id="chain"></span><button class="btn sm" id="verify">${t("audit_verify")}</button>`;
    document.getElementById("verify").onclick = async () => {
      const v = await api("/api/audit/verify");
      document.getElementById("chain").innerHTML = v.ok ? badge("ok", `${t("chain_ok")} · ${nf(v.checked)}`) : badge("failed", `${t("chain_bad")} #${v.broken_at}`);
    };
    document.getElementById("more").onclick = () => renderAudit(true);
  } else document.getElementById("auditBody").insertAdjacentHTML("beforeend", rows);
  if (entries.length) state.auditBefore = entries[entries.length - 1].seq;
  if (entries.length < 100) document.getElementById("more").style.display = "none";
}

// ---------- settings ----------
async function renderSettings() {
  shell("settings", t("nav_settings"), "", `<div class="skeleton"></div>`);
  const [s, g] = await Promise.all([api("/api/settings"), api("/api/governor")]);
  const P = s.providers;
  shell("settings", t("nav_settings"), "", `
    <div class="grid g2" style="align-items:start">
      <div class="stack">
        <div class="card"><h2>${t("settings_providers")}</h2>
          <dl class="kv">
            <dt>${t("mode")}</dt><dd class="mono">${esc(P.mode)}</dd>
            <dt>Gemini</dt><dd>${P.gemini.configured ? badge("ok", `${t("configured")} · ${nf(P.gemini.keys)} ${t("keys")}`) : badge("draft", t("not_configured"))}</dd>
            <dt>OpenRouter</dt><dd>${P.openrouter.configured ? badge("ok", `${t("configured")} · ${nf(P.openrouter.keys)} ${t("keys")}`) : badge("draft", t("not_configured"))} <span class="faint">${t("free_only")}</span></dd>
            <dt>Workers AI</dt><dd>${P.workers_ai.configured ? badge("ok", t("configured")) : badge("draft", t("not_configured"))}</dd>
            <dt>${t("queues")}</dt><dd>${s.queues.enabled ? badge("ok", t("enabled")) : badge("draft", t("disabled"))}</dd>
          </dl>
          <div class="faint" style="margin-top:12px;font-size:12.5px">${t("secrets_note")}</div>
        </div>
        <div class="card"><h2>${t("settings_auth")}</h2><dl class="kv"><dt>Method</dt><dd>${esc(s.auth.method)}</dd><dt>Cross-site</dt><dd>${s.auth.cross_site_console ? "Pages origin (SameSite=None)" : "same origin (SameSite=Strict)"}</dd></dl>
          <div class="row" style="margin-top:14px"><button class="btn sm" id="lo">${t("logout")}</button><button class="btn sm danger" id="loa">${t("logout_all")}</button></div></div>
      </div>
      <div class="stack">
        <div class="card"><h2>${t("settings_caps")} <span class="hint">≤ 90%</span></h2>
          <label class="f">${t("margin")}: <b id="mv">${Math.round(g.caps.margin * 100)}%</b></label><input type="range" id="margin" min="10" max="90" step="5" value="${Math.round(g.caps.margin * 100)}" style="padding:0" />
          <label class="f" style="margin-top:14px">${t("population")}</label><input type="number" id="pop" min="1" max="64" value="${g.caps.population.live}" />
          <button class="btn primary" style="margin-top:14px" id="saveCaps">${t("save")}</button>
          <dl class="kv" style="margin-top:16px"><dt>LLM / ${t("day")}</dt><dd class="num">${nf(g.caps.global.llm_calls)}</dd><dt>Tokens / ${t("day")}</dt><dd class="num">${nf(g.caps.global.tokens)}</dd><dt>Runs / ${t("day")}</dt><dd class="num">${nf(g.caps.global.runs)}</dd></dl><pre class="json" style="margin-top:12px">${pretty(g.constitution.runHardCaps)}</pre>
        </div>
        <div class="card"><h2>${t("org")}</h2><button class="btn" id="seedBtn">${t("seed_btn")}</button></div>
      </div>
    </div>`);
  const m = document.getElementById("margin");
  m.oninput = () => (document.getElementById("mv").textContent = m.value + "%");
  document.getElementById("saveCaps").onclick = async () => { try { await api("/api/governor/caps", { method: "POST", body: { margin: Number(m.value) / 100, population_live: Number(document.getElementById("pop").value) } }); toast(t("saved")); renderSettings(); } catch (e) { toast(e.message, true); } };
  document.getElementById("seedBtn").onclick = seed;
  document.getElementById("lo").onclick = async () => { await api("/api/auth/logout", { method: "POST" }); renderLogin(); };
  document.getElementById("loa").onclick = async () => { await api("/api/auth/logout-all", { method: "POST" }); renderLogin(); };
}

// ---------- shared: drawer, dialogs, soft-fail ----------
const short = (id) => { const s = String(id ?? ""); return !s ? "—" : s.length > 16 ? s.slice(0, 7) + "…" + s.slice(-5) : s; };
const pctTxt = (x) => (x == null || !isFinite(x) ? "—" : nf(Math.round(Number(x) * 100)) + "%");
const r1 = (x) => (x == null || !isFinite(x) ? "—" : nf(Math.round(Number(x))));
const HIVE_ART = '<svg class="hive-art" viewBox="0 0 120 96" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2"><path d="M30 8l16 9v18l-16 9-16-9V17z"/><path d="M62 8l16 9v18l-16 9-16-9V17z" opacity=".55"/><path d="M46 35l16 9v18l-16 9-16-9V44z" opacity=".8"/><path d="M78 35l16 9v18l-16 9-16-9V44z" opacity=".35"/><path d="M62 62l16 9v18l-16 9-16-9V71z" opacity=".2"/></g><path d="M46 44l8 4.5v9l-8 4.5-8-4.5v-9z" fill="url(#hg)"/><defs><linearGradient id="hg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f5b83d"/><stop offset="1" stop-color="#e8743b"/></linearGradient></defs></svg>';
class NotReady extends Error {}
async function apiSoft(path, opts) {
  try {
    const d = await api(path, opts);
    if (d == null || typeof d !== "object") throw new NotReady("not available");
    return d;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (e.status === 404 || e.status === 405 || e.status === 501) { const n = new NotReady(e.message); n.status = e.status; throw n; }
    throw e;
  }
}
function notReadyCard(kind) {
  return `<div class="card empty hive-empty">${HIVE_ART}<div class="t">${t("nr_title")}</div><div class="muted">${t("nr_body_" + kind)}</div><button class="btn sm" style="margin-top:14px" data-retry>${t("retry")}</button></div>`;
}
function errorCard(e) {
  return `<div class="card empty hive-empty err">${HIVE_ART}<div class="t">${t("error")}</div><div class="muted mono" dir="auto">${esc(e && e.message)}</div><button class="btn sm" style="margin-top:14px" data-retry>${t("retry")}</button></div>`;
}
const failCard = (e, kind) => (e instanceof NotReady ? notReadyCard(kind) : errorCard(e));
function bindRetry(root, fn) { (root || document).querySelectorAll("[data-retry]").forEach((b) => (b.onclick = fn || route)); }
function actErr(e) {
  if (e instanceof AuthError) return renderLogin();
  if (e instanceof NotReady || e.status === 404) return toast(t("nr_action"), true);
  if (e.status === 409) return toast(t("evo_locked") + (e.data && e.data.lock && e.data.lock.holder ? ` · ${e.data.lock.holder}` : ""), true);
  if (e.status === 423) return toast(t("lab_killed"), true);
  if (e.status === 429) return toast(t("lab_budget"), true);
  toast(e.message, true);
}
// ---------- background jobs: start → poll /api/jobs/:id → progress dock ----------
const JOB_KIND_LABEL = { "eval.seed": "job_seed", "eval.saturation": "job_saturation", "evolution.generation": "job_generation", "evolution.tick": "job_tick", "forge.submit": "job_forge", "forge.admit": "job_forge", "discovery.evolve": "job_discovery", "discovery.reverify": "job_reverify", "redteam.campaign": "job_redteam", "memory.compact": "job_compact", "court.probe": "job_probe", "studio.design": "job_studio", "army.mission": "job_mission" };
const jobWatch = new Map(); // job id → { onDone, timer }
function jobDock() {
  let d = document.getElementById("jobDock");
  if (!d) { d = document.createElement("div"); d.id = "jobDock"; d.setAttribute("aria-live", "polite"); document.body.appendChild(d); }
  return d;
}
function jobCard(j) {
  const pct = Math.max(0, Math.min(100, Number(j.progress && j.progress.pct) || 0));
  const active = j.status === "queued" || j.status === "running";
  const st = tOr("job_st_" + j.status, j.status) + (j.stopped && j.stopped !== "cancelled" ? ` · ${tOr("job_stop_" + j.stopped, j.stopped)}` : "");
  return `<div class="jobcard ${esc(j.status)}" data-job="${esc(j.id)}">
    <div class="jc-head"><b>${esc(t(JOB_KIND_LABEL[j.kind] || "job"))}</b><span class="jc-st">${esc(st)}</span>
      ${active ? `<button class="btn xs ghost" data-jcancel="${esc(j.id)}">${t("job_cancel")}</button>` : `<button class="btn xs ghost" data-jclose="${esc(j.id)}" aria-label="${t("close")}">✕</button>`}</div>
    <div class="jc-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div>
    <div class="jc-meta"><span>${nf(Math.round(pct))}% · ${nf(j.progress ? j.progress.done : 0)}/${nf(j.progress ? j.progress.total : 0)}</span><span>${nf(j.llm_calls || 0)} / ${nf(j.max_calls || 0)} ${t("job_calls")}</span></div>
    ${j.message ? `<div class="jc-msg mono" dir="auto">${esc(j.message)}</div>` : ""}
    ${j.error ? `<div class="jc-msg err mono" dir="auto">${esc(j.error)}</div>` : ""}
  </div>`;
}
function paintJob(j) {
  const d = jobDock();
  let el = d.querySelector(`[data-job="${CSS.escape(j.id)}"]`);
  const html = jobCard(j);
  if (el) el.outerHTML = html; else d.insertAdjacentHTML("afterbegin", html);
  el = d.querySelector(`[data-job="${CSS.escape(j.id)}"]`);
  const c = el.querySelector("[data-jcancel]");
  if (c) c.onclick = async () => { try { const r = await api(`/api/jobs/${encodeURIComponent(j.id)}/cancel`, { method: "POST", body: {} }); paintJob(r.job); } catch (e) { actErr(e); } };
  const x = el.querySelector("[data-jclose]");
  if (x) x.onclick = () => el.remove();
}
/** Watch a job until it ends; `onDone(job)` runs once on a terminal state. */
function watchJob(job, onDone) {
  if (jobWatch.has(job.id)) { if (onDone) jobWatch.get(job.id).onDone = onDone; return; }
  const w = { onDone, timer: null, misses: 0 };
  jobWatch.set(job.id, w);
  paintJob(job);
  const tick = async () => {
    let j;
    try { j = (await api(`/api/jobs/${encodeURIComponent(job.id)}`)).job; w.misses = 0; }
    catch (e) { if (e instanceof AuthError) { jobWatch.delete(job.id); return; } if (++w.misses > 10) { jobWatch.delete(job.id); return toast(e.message, true); } w.timer = setTimeout(tick, 4000); return; }
    paintJob(j);
    if (j.status === "queued" || j.status === "running") { w.timer = setTimeout(tick, 2000); return; }
    jobWatch.delete(job.id);
    const ok = j.status === "done" && !j.stopped;
    if (window.KFX) KFX.sound.play(ok ? "done" : j.status === "done" ? "budget" : "failed");
    toast(`${t(JOB_KIND_LABEL[j.kind] || "job")} · ${tOr("job_st_" + j.status, j.status)}${j.stopped ? " · " + tOr("job_stop_" + j.stopped, j.stopped) : ""}`, !ok && j.status !== "done", false);
    if (w.onDone) { try { w.onDone(j); } catch {} }
    if (ok) setTimeout(() => { const el = jobDock().querySelector(`[data-job="${CSS.escape(j.id)}"]`); if (el) el.remove(); }, 12000);
  };
  w.timer = setTimeout(tick, 1200);
}
/** POST a job-starting endpoint; falls back to the old synchronous answer if the server returns a result. */
async function startJob(path, body, onDone) {
  const r = await apiSoft(path, { method: "POST", body });
  if (r && r.job_id && r.job) { watchJob(r.job, onDone); if (r.reused) toast(t("job_reused")); return r.job; }
  if (onDone) onDone({ status: "done", result: r });
  return null;
}
let jobsResumed = false;
async function resumeJobs() {
  if (jobsResumed) return;
  jobsResumed = true;
  try {
    for (const st of ["running", "queued"]) {
      const r = await api(`/api/jobs?status=${st}&limit=10`);
      for (const j of (r && r.jobs) || []) watchJob(j);
    }
  } catch {}
}
/** Make elements keyboard-clickable rows/cards. */
function bindClick(root, sel, fn) {
  root.querySelectorAll(sel).forEach((el) => {
    if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
    if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    el.onclick = (ev) => { if (ev.target.closest("button,a,select,input")) return; fn(el, ev); };
    el.onkeydown = (ev) => { if ((ev.key === "Enter" || ev.key === " ") && ev.target === el) { ev.preventDefault(); fn(el, ev); } };
  });
}
async function busy(btn, fn) {
  const html = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span><span>${btn.textContent}</span>`;
  try { return await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.innerHTML = html; } }
}

function openDrawer(html, label) {
  closeDrawer(true);
  const wrap = document.createElement("div");
  wrap.className = "drawer-wrap";
  wrap._prev = document.activeElement;
  wrap.innerHTML = `<div class="drawer-scrim" data-close></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(label)}" tabindex="-1"><button class="btn ghost sm drawer-x" data-close aria-label="${esc(t("close"))}">✕</button><div class="drawer-body">${html}</div></aside>`;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add("open"));
  const dr = wrap.querySelector(".drawer");
  dr.focus();
  wrap.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => closeDrawer()));
  return dr.querySelector(".drawer-body");
}
function closeDrawer(instant) {
  const w = document.querySelector(".drawer-wrap");
  if (!w) return;
  const prev = w._prev;
  if (instant) w.remove();
  else { w.classList.remove("open"); setTimeout(() => w.remove(), 220); }
  if (prev && prev.isConnected && prev.focus) prev.focus();
}
/** Promise-based confirm / prompt dialog. Resolves false (cancel), true (confirm) or the input string. */
function dialog({ title, body = "", confirm, danger = false, input = null }) {
  return new Promise((resolve) => {
    const prev = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "modal-wrap";
    wrap.innerHTML = `<div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="mdT"><div class="modal-hex ${danger ? "danger" : ""}">${danger ? "!" : "?"}</div><h3 id="mdT">${esc(title)}</h3>${body ? `<div class="muted" dir="auto">${body}</div>` : ""}${input ? `<input id="mdIn" placeholder="${esc(input.placeholder || "")}" value="${esc(input.value || "")}" ${input.dir ? `dir="${input.dir}"` : ""}/>` : ""}<div class="row modal-actions"><button class="btn" data-v="0">${t("cancel")}</button><button class="btn ${danger ? "danger" : "primary"}" data-v="1">${esc(confirm || t("confirm"))}</button></div></div>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add("open"));
    const inp = wrap.querySelector("#mdIn");
    const done = (v) => { wrap.remove(); document.removeEventListener("keydown", key, true); if (prev && prev.focus) prev.focus(); resolve(v); };
    const ok = () => done(input ? inp.value.trim() || input.fallback || "" : true);
    const key = (e) => { if (e.key === "Escape") { e.stopPropagation(); done(false); } else if (e.key === "Enter" && (input || document.activeElement === wrap.querySelector('[data-v="1"]'))) { e.preventDefault(); ok(); } };
    document.addEventListener("keydown", key, true);
    wrap.querySelector('[data-v="0"]').onclick = () => done(false);
    wrap.querySelector('[data-v="1"]').onclick = ok;
    wrap.onclick = (e) => { if (e.target === wrap) done(false); };
    (inp || wrap.querySelector(danger ? '[data-v="0"]' : '[data-v="1"]')).focus();
  });
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !document.querySelector(".modal-wrap")) closeDrawer(); });
window.addEventListener("hashchange", () => closeDrawer(true));

// ---------- visuals ----------
function hexLevel(level, max = 10) {
  const L = Math.max(0, Math.min(max, Number(level) || 0));
  let cells = "";
  for (let i = 1; i <= max; i++) cells += `<span class="hc ${i <= L ? "on" : ""} ${i <= L && i >= 8 ? "hot" : ""}" style="--i:${i}"></span>`;
  return `<div class="lvl" role="img" aria-label="${esc(t("ef_level"))} ${L} / ${max}">${cells}</div>`;
}
function ring(v, label, size = 72) {
  const r = 27, C = 2 * Math.PI * r;
  const has = v != null && isFinite(v);
  const p = has ? Math.max(0, Math.min(1, Number(v))) : 0;
  const cls = !has ? "none" : p >= 0.85 ? "hot" : p >= 0.6 ? "warm" : "cool";
  return `<svg class="ring ${cls}" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${esc(label)} ${has ? Math.round(p * 100) + "%" : "—"}"><circle class="trk" cx="32" cy="32" r="${r}"/><circle class="val" cx="32" cy="32" r="${r}" stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${(C * (1 - p)).toFixed(2)}" transform="rotate(-90 32 32)"/><text x="32" y="36" text-anchor="middle">${has ? Math.round(p * 100) + "%" : "—"}</text></svg>`;
}
function qbar(q) {
  if (q == null || !isFinite(q)) return `<span class="faint">—</span>`;
  const p = Math.max(0, Math.min(1, Number(q)));
  return `<div class="qcell" title="${pctTxt(p)}"><div class="qbar"><i class="${p < 0.5 ? "lo" : p < 0.75 ? "mid" : ""}" style="width:${(p * 100).toFixed(0)}%"></i></div><span class="num">${pctTxt(p)}</span></div>`;
}
const splitBadge = (s) => `<span class="split sp-${esc(s)}">${esc(t("split_" + s))}</span>`;
const itemBadge = (s) => badge("it-" + s, t("ist_" + s));

// ======================================================================
// Eval Factory
// ======================================================================
const EVAL_GATES = ["structure", "dedupe", "solvable", "anti_gaming", "discriminative", "flake", "critic", "quality"];
const SPLITS = ["public", "private", "canary"];
const ITEM_STATUSES = ["active", "reserve", "pending", "rejected", "retired"];
const evs = { suite: null, split: "", status: "", suites: [] };

function syncEvalHash() {
  const q = new URLSearchParams();
  if (evs.suite) q.set("suite", evs.suite);
  if (evs.split) q.set("split", evs.split);
  if (evs.status) q.set("status", evs.status);
  history.replaceState(null, "", "#/evals" + (q.toString() ? "?" + q : ""));
}

function suiteCard(s) {
  const c = s.counts || { total: 0, by_status: {}, by_split_status: {} };
  const bs = c.by_status || {}, bss = c.by_split_status || {};
  const act = SPLITS.map((sp) => bss[sp + ":active"] || 0);
  const actTot = act.reduce((a, b) => a + b, 0);
  const seg = SPLITS.map((sp, i) => (act[i] ? `<i class="sp-${sp}" style="flex:${act[i]}" title="${esc(t("split_" + sp))}: ${nf(act[i])}"></i>` : "")).join("");
  const name = state.lang === "ar" && s.name_ar ? s.name_ar : s.name;
  const sel = evs.suite === s.id;
  return `<article class="card suite ${sel ? "sel" : ""} ${s.status === "paused" ? "paused" : ""}" data-id="${esc(s.id)}" aria-pressed="${sel}">
    <div class="suite-top">
      <div class="hex sm">${esc(glyph(s.role))}</div>
      <div class="suite-nm"><div class="nm" dir="auto">${esc(name)}</div><div class="faint mono">${esc(s.id)} · ${esc(roleLabel(s.role))}</div></div>
      ${ring(s.saturation, t("ef_saturation"))}
    </div>
    ${s.description ? `<div class="suite-desc muted" dir="auto">${esc(s.description)}</div>` : ""}
    <div class="suite-lvl"><span class="faint">${t("ef_level")}</span>${hexLevel(s.level)}<b class="num">${nf(s.level)}</b></div>
    <div class="splitbar" role="img" aria-label="${esc(t("ef_active_by_split"))}">${seg || '<i class="none" style="flex:1"></i>'}</div>
    <div class="suite-counts">
      ${ITEM_STATUSES.filter((st) => bs[st]).map((st) => `<span class="cnt it-${st}"><b class="num">${nf(bs[st])}</b> ${esc(t("ist_" + st))}</span>`).join("") || `<span class="faint">${t("ef_no_items")}</span>`}
      <span class="spacer"></span><span class="faint num">${nf(actTot)}/${nf(c.total || 0)}</span>
    </div>
    <div class="row suite-actions">
      <button class="btn sm" data-act="sat" data-id="${esc(s.id)}">${t("ef_check_sat")}</button>
      <button class="btn sm" data-act="run" data-id="${esc(s.id)}">${t("ef_run")}</button>
      ${s.saturated_at ? `<span class="badge pending" title="${esc(when(s.saturated_at))}">${t("ef_saturated")}</span>` : ""}
    </div>
  </article>`;
}

async function renderEvals() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  evs.suite = q.get("suite") || evs.suite;
  evs.split = q.has("split") ? q.get("split") : evs.split;
  evs.status = q.has("status") ? q.get("status") : evs.status;
  const sub = t("ef_sub");
  shell("evals", t("nav_evals"), sub, `<div class="grid g4">${'<div class="skeleton" style="height:90px"></div>'.repeat(4)}</div><div class="suites" style="margin-top:16px">${'<div class="skeleton" style="height:230px"></div>'.repeat(3)}</div>`);
  topActions().innerHTML = `<button class="btn sm" id="flakyBtn">${t("ef_retire_flaky")}</button><button class="btn sm primary" id="seedEvBtn">${t("ef_seed")}</button>`;
  document.getElementById("seedEvBtn").onclick = async (ev) => {
    if (!(await dialog({ title: t("ef_seed"), body: esc(t("ef_seed_confirm")), confirm: t("ef_seed") }))) return;
    await busy(ev.currentTarget, async () => {
      try {
        await startJob("/api/evals/seed", {}, (j) => {
          const r = j.result || {};
          if (j.status === "done") toast(`${t("ef_seeded")} · ${nf(r.created ?? 0)} / ${nf(r.active ?? 0)} ${t("ist_active")}${j.stopped ? " · " + tOr("job_stop_" + j.stopped, j.stopped) : ""}`, !!j.stopped);
          if ((location.hash || "").startsWith("#/evals")) renderEvals();
        });
      } catch (e) { actErr(e); }
    });
  };
  document.getElementById("flakyBtn").onclick = async (ev) => {
    if (!(await dialog({ title: t("ef_retire_flaky"), body: esc(t("ef_flaky_confirm")), confirm: t("ef_retire_flaky"), danger: true }))) return;
    await busy(ev.currentTarget, async () => {
      try { const r = await apiSoft("/api/evals/retire-flaky", { method: "POST", body: evs.suite ? { suite_id: evs.suite } : {} }); toast(`${t("ef_flaky_done")} · ${nf(r.retired ?? (Array.isArray(r.items) ? r.items.length : 0))}`); renderEvals(); } catch (e) { actErr(e); }
    });
  };
  let suites;
  try { ({ suites } = await apiSoft("/api/evals/suites")); suites = suites || []; } catch (e) {
    if (e instanceof AuthError) throw e;
    content().innerHTML = failCard(e, "evals");
    bindRetry(content());
    return;
  }
  evs.suites = suites;
  if (!suites.length) {
    content().innerHTML = `<div class="card empty hive-empty">${HIVE_ART}<div class="t">${t("ef_empty_t")}</div><div class="muted">${t("ef_empty")}</div><button class="btn primary" style="margin-top:14px" id="seedEmpty">${t("ef_seed")}</button></div>`;
    document.getElementById("seedEmpty").onclick = () => document.getElementById("seedEvBtn").click();
    return;
  }
  if (!evs.suite || !suites.some((s) => s.id === evs.suite)) evs.suite = suites[0].id;
  const tot = (st) => suites.reduce((a, s) => a + ((s.counts && s.counts.by_status && s.counts.by_status[st]) || 0), 0);
  const sat = suites.filter((s) => s.saturation != null);
  const avgSat = sat.length ? sat.reduce((a, s) => a + s.saturation, 0) / sat.length : null;
  content().innerHTML = `
    <div class="grid g4">
      <div class="card stat"><div class="label">${t("ef_suites")}</div><div class="value">${nf(suites.length)}</div></div>
      <div class="card stat"><div class="label">${t("ef_active_items")}</div><div class="value">${nf(tot("active"))} <small>+ ${nf(tot("reserve"))} ${t("ist_reserve")}</small></div></div>
      <div class="card stat"><div class="label">${t("ef_rejected_retired")}</div><div class="value">${nf(tot("rejected"))} <small>/ ${nf(tot("retired"))}</small></div></div>
      <div class="card stat"><div class="label">${t("ef_avg_sat")}</div><div class="value">${pctTxt(avgSat)}</div></div>
    </div>
    <div class="suites" style="margin-top:16px" id="suiteGrid">${suites.map(suiteCard).join("")}</div>
    <section class="card" style="margin-top:16px" id="itemsCard"></section>`;
  const grid = document.getElementById("suiteGrid");
  bindClick(grid, ".suite", (el) => { evs.suite = el.dataset.id; grid.querySelectorAll(".suite").forEach((x) => { x.classList.toggle("sel", x === el); x.setAttribute("aria-pressed", x === el); }); syncEvalHash(); loadItems(); });
  grid.querySelectorAll("button[data-act=sat]").forEach((b) => (b.onclick = () => checkSaturation(b)));
  grid.querySelectorAll("button[data-act=run]").forEach((b) => (b.onclick = () => runSuite(b)));
  syncEvalHash();
  loadItems();
}

async function checkSaturation(btn) {
  await busy(btn, async () => {
    try {
      await startJob(`/api/evals/suites/${encodeURIComponent(btn.dataset.id)}/saturation`, { ladder: true }, (j) => {
        const r = j.result || {};
        if (j.status === "done" && r.pass_rate != null) toast(`${t("ef_saturation")}: ${pctTxt(r.pass_rate)} (n=${nf(r.n)})${r.saturated ? " · " + t("ef_saturated") : ""}${r.ladder ? ` · ${t("ef_laddered")} ${nf(r.ladder.from_level)}→${nf(r.ladder.level)}` : ""}`);
        if ((location.hash || "").startsWith("#/evals")) renderEvals();
      });
    } catch (e) { actErr(e); }
  });
}

async function runSuite(btn) {
  const id = btn.dataset.id;
  const agent = await dialog({ title: t("ef_run"), body: esc(t("ef_run_body")), confirm: t("ef_run_go"), input: { placeholder: t("ef_agent_ph"), dir: "ltr", fallback: "" } });
  if (agent === false) return;
  await busy(btn, async () => {
    try {
      const r = await apiSoft(`/api/evals/suites/${encodeURIComponent(id)}/run`, { method: "POST", body: agent ? { agent_id: agent } : {} });
      const rows = (r.results || []).slice(0, 200).map((x) => `<tr class="click" data-id="${esc(x.item_id)}"><td class="mono">${esc(short(x.item_id))}</td><td>${x.pass ? badge("ok", t("pass")) : badge("failed", t("fail"))}</td><td class="num">${pctTxt(x.score)}</td><td class="num">${nf(x.difficulty)}</td></tr>`).join("");
      const body = openDrawer(`
        <div class="dr-head"><div class="hex">${esc(glyph(r.role))}</div><div><div class="eyebrow">${t("ef_run_result")}</div><h2 class="dr-title mono">${esc(r.suite_id)}</h2></div></div>
        <div class="run-sum">${ring(r.pass_rate, t("ef_pass_rate"), 96)}<dl class="kv"><dt>${t("ef_genome")}</dt><dd class="mono">${esc(r.genome_id)}</dd><dt>${t("ef_source")}</dt><dd>${esc(t("src_" + r.genome_source))}</dd><dt>${t("ef_passed")}</dt><dd class="num">${nf(r.passed)} / ${nf(r.n)}</dd><dt>${t("ef_excluded")}</dt><dd class="num">${nf(r.excluded_own_lineage || 0)}</dd><dt>${t("llm_calls")}</dt><dd class="num">${nf(r.llm_calls)}</dd></dl></div>
        ${r.role_matches_suite === false ? `<div class="note warn">${t("ef_role_mismatch")}</div>` : ""}
        ${rows ? `<div class="tbl-wrap"><table class="table"><thead><tr><th>${t("ef_item")}</th><th>${t("col_status")}</th><th>${t("ef_score")}</th><th>${t("ef_difficulty")}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="empty">${t("ef_no_private")}</div>`}`, t("ef_run_result"));
      bindClick(body, "tr.click", (el) => openItem(el.dataset.id));
      toast(`${t("ef_pass_rate")}: ${pctTxt(r.pass_rate)}`);
    } catch (e) { actErr(e); }
  });
}

async function loadItems() {
  const card = document.getElementById("itemsCard");
  if (!card) return;
  const s = evs.suites.find((x) => x.id === evs.suite);
  const chips = (key, vals, labelFn) => `<div class="seg" role="group" aria-label="${esc(t("ef_filter_" + key))}">${["", ...vals].map((v) => `<button class="${evs[key] === v ? "on" : ""}" data-k="${key}" data-v="${esc(v)}" aria-pressed="${evs[key] === v}">${esc(v ? labelFn(v) : t("all"))}</button>`).join("")}</div>`;
  card.innerHTML = `<div class="items-head"><h2>${t("ef_items")} <span class="hint mono">${esc(s ? s.id : "")}</span></h2><div class="row">${chips("split", SPLITS, (v) => t("split_" + v))}${chips("status", ITEM_STATUSES, (v) => t("ist_" + v))}</div></div><div id="itemsBody"><div class="skeleton" style="height:180px"></div></div>`;
  card.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { evs[b.dataset.k] = b.dataset.v; syncEvalHash(); loadItems(); }));
  const qs = new URLSearchParams();
  if (evs.status) qs.set("status", evs.status);
  if (evs.split) qs.set("split", evs.split);
  const body = document.getElementById("itemsBody");
  try {
    const { items = [] } = await apiSoft(`/api/evals/suites/${encodeURIComponent(evs.suite)}/items?${qs}`);
    if (!body.isConnected) return;
    if (!items.length) { body.innerHTML = `<div class="empty">${t("ef_no_items_filter")}</div>`; return; }
    body.innerHTML = `<div class="tbl-wrap"><table class="table items"><thead><tr><th>${t("ef_item")}</th><th>${t("col_task")}</th><th>${t("ef_split")}</th><th>${t("col_status")}</th><th>${t("ef_difficulty")}</th><th>${t("ef_quality")}</th><th>${t("ef_checks")}</th><th>${t("col_when")}</th></tr></thead><tbody>
      ${items.map((it) => `<tr class="click" data-id="${esc(it.id)}"><td class="mono">${esc(short(it.id))}</td><td class="trunc" dir="auto" title="${esc(it.task)}">${esc(it.task)}</td><td>${splitBadge(it.split)}</td><td>${itemBadge(it.status)}</td><td><span class="diff d${Math.min(10, Math.max(1, Math.round(it.difficulty || 1)))}">${nf(it.difficulty)}</span></td><td>${qbar(it.quality)}</td><td class="num">${nf(it.checks || 0)}${it.flakes ? ` <span class="flk" title="${esc(t("ef_flakes"))}">⚡${nf(it.flakes)}</span>` : ""}</td><td class="faint nowrap">${esc(ago(it.created_at))}</td></tr>`).join("")}
    </tbody></table></div><div class="faint" style="margin-top:8px;font-size:12px">${nf(items.length)} ${t("ef_items_n")}</div>`;
    bindClick(body, "tr.click", (el) => openItem(el.dataset.id));
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    body.innerHTML = failCard(e, "evals");
    bindRetry(body, loadItems);
  }
}

function normGates(v) {
  const list = [];
  if (v && Array.isArray(v.gates)) for (const g of v.gates) list.push({ gate: g.gate, pass: g.pass, reason: g.reason });
  else if (v && v.stages) for (const [gate, s] of Object.entries(v.stages)) list.push({ gate, pass: s ? s.ok ?? s.pass : null, reason: s ? s.detail ?? s.reason : null });
  const by = Object.fromEntries(list.map((g) => [g.gate, g]));
  const out = EVAL_GATES.map((g) => by[g] || { gate: g, pass: null, reason: null });
  for (const g of list) if (!EVAL_GATES.includes(g.gate)) out.push(g);
  return out;
}
function gatePipeline(gates) {
  const st = (g) => (g.pass === true ? "pass" : g.pass === false ? "fail" : "skip");
  const nodes = gates.map((g, i) => `<li class="gp-node ${st(g)}" style="--i:${i}"><span class="gp-hex" aria-hidden="true">${g.pass === true ? "✓" : g.pass === false ? "✕" : i + 1}</span><span class="gp-lbl">${esc(t("gate_" + g.gate))}</span><span class="sr">${esc(t("gs_" + st(g)))}</span></li>`).join("");
  const reasons = gates.map((g) => `<div class="gp-row ${st(g)}"><span class="gp-dot"></span><b>${esc(t("gate_" + g.gate))}</b><span class="gp-st">${esc(t("gs_" + st(g)))}</span><div class="gp-why" dir="auto">${esc(g.reason || (g.pass == null ? t("gate_not_run") : "—"))}</div></div>`).join("");
  return `<ol class="gp" aria-label="${esc(t("ef_pipeline"))}">${nodes}</ol><div class="gp-list">${reasons}</div>`;
}

async function openItem(id) {
  const body = openDrawer(`<div class="skeleton" style="height:300px"></div>`, t("ef_item"));
  let d;
  try { d = await apiSoft(`/api/evals/items/${encodeURIComponent(id)}`); } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    body.innerHTML = failCard(e, "evals"); bindRetry(body, () => openItem(id)); return;
  }
  const it = d.item || {};
  const v = d.validation || it.validation || null;
  const gates = normGates(v);
  const passN = gates.filter((g) => g.pass === true).length;
  const results = d.results || [];
  const passRate = results.length ? results.filter((r) => r.pass).length / results.length : null;
  body.innerHTML = `
    <div class="dr-head"><div class="hex">${esc(glyph(it.role))}</div><div style="min-width:0"><div class="eyebrow">${t("ef_item")} · ${esc(roleLabel(it.role))}</div><h2 class="dr-title mono">${esc(it.id)}</h2><div class="row" style="margin-top:6px">${itemBadge(it.status)}${splitBadge(it.split)}<span class="diff d${Math.min(10, Math.max(1, Math.round(it.difficulty || 1)))}">${t("ef_difficulty")} ${nf(it.difficulty)}</span></div></div></div>
    <div class="dr-stats">
      <div><div class="label">${t("ef_quality")}</div>${qbar(it.quality ?? (v && v.quality))}</div>
      <div><div class="label">${t("ef_gates_passed")}</div><b class="num">${nf(passN)} / ${nf(EVAL_GATES.length)}</b></div>
      <div><div class="label">${t("ef_outcome")}</div>${v ? itemBadge(v.outcome) : "—"}</div>
      <div><div class="label">${t("ef_pass_rate")}</div><b class="num">${pctTxt(passRate)}</b> <span class="faint">(${nf(results.length)})</span></div>
    </div>
    <h3 class="dr-h">${t("ef_pipeline")}</h3>
    ${v ? gatePipeline(gates) : `<div class="empty">${t("ef_no_validation")}</div>`}
    ${v && v.reason ? `<div class="note ${v.outcome === "rejected" ? "bad" : ""}" dir="auto">${esc(v.reason)}</div>` : ""}
    ${it.status_reason ? `<div class="note" dir="auto"><b>${t("ef_status_reason")}:</b> ${esc(it.status_reason)}</div>` : ""}
    <h3 class="dr-h">${t("col_task")}</h3><div class="task-box" dir="auto">${esc(it.task)}</div>
    ${it.inputs && Object.keys(it.inputs).length ? `<h3 class="dr-h">${t("ef_inputs")}</h3><pre class="json">${pretty(it.inputs)}</pre>` : ""}
    <div class="grid g2 dr-two"><div><h3 class="dr-h">${t("ef_reference")}</h3><pre class="json ref">${esc(it.reference ?? "—")}</pre></div><div><h3 class="dr-h">${t("ef_checker")} ${it.checker && it.checker.type ? `<span class="tier">${esc(it.checker.type)}</span>` : ""}</h3><pre class="json">${pretty(it.checker)}</pre></div></div>
    ${(it.tags || []).length ? `<div class="chip-row" style="margin-top:10px">${it.tags.map((x) => `<span class="tag">#${esc(x)}</span>`).join("")}</div>` : ""}
    <h3 class="dr-h">${t("ef_results")} <span class="hint">${nf(results.length)}</span></h3>
    ${results.length ? `<div class="tbl-wrap"><table class="table"><thead><tr><th>${t("ef_genome")}</th><th>${t("ef_context")}</th><th>${t("col_status")}</th><th>${t("ef_score")}</th><th>${t("col_when")}</th></tr></thead><tbody>${results.slice(0, 100).map((r) => `<tr><td class="mono">${esc(short(r.genome_id))}</td><td class="faint">${esc(r.context || "")}</td><td>${r.pass ? badge("ok", t("pass")) : badge("failed", t("fail"))}</td><td class="num">${pctTxt(r.score)}</td><td class="faint">${esc(ago(r.at))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${t("ef_no_results")}</div>`}
    <div class="faint mono dr-foot">${esc(it.author || "")}${it.author_lineage ? " · " + esc(it.author_lineage) : ""} · ${esc(when(it.created_at))}${v && v.llm_calls != null ? ` · ${nf(v.llm_calls)} LLM` : ""}</div>
    ${it.status !== "retired" ? `<div class="dr-actions"><button class="btn danger" id="retireBtn">${t("ef_retire")}</button></div>` : ""}`;
  const rb = body.querySelector("#retireBtn");
  if (rb) rb.onclick = async () => {
    const reason = await dialog({ title: t("ef_retire"), body: esc(t("ef_retire_body")), confirm: t("ef_retire"), danger: true, input: { placeholder: t("ef_reason_ph"), fallback: "retired by owner" } });
    if (reason === false) return;
    await busy(rb, async () => {
      try { await apiSoft(`/api/evals/items/${encodeURIComponent(id)}/retire`, { method: "POST", body: { reason } }); toast(t("ef_retired")); openItem(id); loadItems(); } catch (e) { actErr(e); }
    });
  };
}

// ======================================================================
// Evolution
// ======================================================================
const EVO_COLS = ["proposed", "static", "sandbox", "tournament", "gate", "canary", "promoted", "rejected", "lost"];
const EVO_PATH = ["proposed", "static", "sandbox", "tournament", "gate", "canary", "promoted"];
const EVO_FAIL = ["rejected", "lost", "rolled_back"];
const EVO_OPS = ["prompt_rewrite", "strategy_swap", "tool_add", "tool_remove", "model_policy_change", "crossover", "distill", "spawn_role"];
const ALL_ROLES = ["director", "architect", "researcher", "builder", "toolsmith", "evaluator", "critic", "librarian", "auditor"];
const evo = { role: "", genRole: "", genOp: "" };
const stageCol = (p) => {
  const s = p.stage;
  const m = { checked: "static", static: "static", sandboxed: "sandbox", sandbox: "sandbox", rolled_back: "rejected" }[s] || s;
  if (m === "tournament" && p.scores && p.scores.gate_pass != null) return "gate";
  return EVO_COLS.includes(m) ? m : "proposed";
};
const opLabel = (o) => (o ? t("op_" + o) : "—");
const stageLabel = (s) => t("stg_" + s);

function reachedIdx(p) {
  const col = stageCol(p);
  if (EVO_PATH.includes(col)) return EVO_PATH.indexOf(col);
  if (p.stage === "rolled_back") return EVO_PATH.indexOf("canary");
  const sc = p.scores || {};
  if (sc.gate_pass != null) return EVO_PATH.indexOf("gate");
  if (sc.tournament) return EVO_PATH.indexOf("tournament");
  if (sc.sandbox) return EVO_PATH.indexOf("sandbox");
  return EVO_PATH.indexOf("static");
}
function stepper(p) {
  const failed = EVO_FAIL.includes(p.stage);
  const at = reachedIdx(p);
  const done = p.stage === "promoted";
  return `<ol class="stepper" aria-label="${esc(t("evo_pipeline"))}">${EVO_PATH.map((s, i) => {
    const cls = done || i < at ? "done" : i === at ? (failed ? "fail" : "cur") : "todo";
    return `<li class="${cls}"><span class="sx" aria-hidden="true">${cls === "done" ? "✓" : cls === "fail" ? "✕" : i + 1}</span><span class="sl">${esc(stageLabel(s))}</span></li>`;
  }).join("")}</ol>`;
}
function scoreLine(sc) {
  if (!sc) return "";
  const bits = [];
  if (sc.tournament && sc.tournament.win_rate != null) bits.push(`<span title="${esc(t("evo_winrate"))}">★ ${pctTxt(sc.tournament.win_rate)}</span>`);
  if (sc.sandbox && sc.sandbox.public != null && typeof sc.sandbox.public === "number") bits.push(`<span title="${esc(t("evo_sandbox"))}">◇ ${pctTxt(sc.sandbox.public)}</span>`);
  if (sc.risk != null) bits.push(`<span class="${sc.risk > 0.6 ? "bad" : ""}" title="${esc(t("evo_risk"))}">⚠ ${pctTxt(sc.risk)}</span>`);
  return bits.length ? `<div class="kc-scores num">${bits.join("")}</div>` : "";
}

function championCard(r, ratings) {
  const c = r.champion || {};
  const can = r.canary;
  const has = c.rating != null;
  // place champion's interval on a 1000–2000ish scale derived from this role's board
  const mine = ratings.filter((x) => x.role === r.role && x.rating != null);
  const lo = Math.min(1200, ...mine.map((x) => x.rating - 2 * (x.rd || 0))), hi = Math.max(1800, ...mine.map((x) => x.rating + 2 * (x.rd || 0)));
  const pos = (v) => (((v - lo) / (hi - lo || 1)) * 100).toFixed(1);
  const sel = evo.role === r.role;
  return `<article class="card champ ${sel ? "sel" : ""} ${can ? "has-canary" : ""}" data-role="${esc(r.role)}" aria-pressed="${sel}">
    <div class="champ-top"><div class="hex crown">${esc(glyph(r.role))}</div><div style="min-width:0"><div class="nm">${esc(roleLabel(r.role))}</div><div class="faint mono" title="${esc(c.genome_id)}">v${esc(c.version ?? "?")} · ${esc(short(c.genome_id))}</div></div>${r.candidates_count ? `<span class="cand-pill" title="${esc(t("evo_candidates"))}">+${nf(r.candidates_count)}</span>` : ""}</div>
    <div class="champ-rating"><b class="num">${has ? r1(c.rating) : "—"}</b>${has ? `<span class="pm num">± ${r1(c.rd)}</span>` : `<span class="faint">${t("evo_unrated")}</span>`}</div>
    ${has ? `<div class="ci" role="img" aria-label="${esc(t("evo_rating"))} ${r1(c.rating)} ± ${r1(c.rd)}"><span class="ci2" style="inset-inline-start:${pos(c.rating - 2 * c.rd)}%;width:${(pos(c.rating + 2 * c.rd) - pos(c.rating - 2 * c.rd)).toFixed(1)}%"></span><span class="ci1" style="inset-inline-start:${pos(c.rating - c.rd)}%;width:${(pos(c.rating + c.rd) - pos(c.rating - c.rd)).toFixed(1)}%"></span><span class="cid" style="inset-inline-start:${pos(c.rating)}%"></span></div>` : ""}
    ${can ? `<div class="canary"><div class="row" style="gap:6px"><span class="bird" aria-hidden="true"></span><b>${t("evo_canary")}</b><span class="faint num">${nf(can.traffic_pct ?? 0)}% · ${nf(can.obs ?? 0)} ${t("evo_obs")}</span></div><div class="vs num"><span>${t("evo_cand")} <b>${pctTxt(can.candidate_score)}</b></span><span>${t("evo_champ")} <b>${pctTxt(can.champion_score)}</b></span></div><button class="btn sm" data-canary="${esc(can.id)}">${t("evo_eval_canary")}</button></div>` : `<div class="faint champ-foot">${t("evo_no_canary")}</div>`}
  </article>`;
}

function kanban(props) {
  const cols = Object.fromEntries(EVO_COLS.map((c) => [c, []]));
  for (const p of props) cols[stageCol(p)].push(p);
  return `<div class="kanban" role="list">${EVO_COLS.map((c) => `
    <section class="kcol ${c} ${["promoted", "rejected", "lost"].includes(c) ? "term" : ""}" role="listitem" aria-label="${esc(stageLabel(c))}">
      <header><span class="kdot"></span>${esc(stageLabel(c))}<span class="kn num">${nf(cols[c].length)}</span></header>
      <div class="kbody">${cols[c].slice(0, 40).map((p) => `
        <div class="kcard" data-id="${esc(p.id)}" aria-label="${esc(opLabel(p.operator))} ${esc(roleLabel(p.role))}">
          <div class="kc-top"><span class="hex xs">${esc(glyph(p.role))}</span><span class="op">${esc(opLabel(p.operator))}</span></div>
          <div class="kc-id mono">${esc(short(p.genome_id || p.id))}</div>
          ${scoreLine(p.scores)}
          <div class="kc-foot">${p.stage === "rolled_back" ? badge("rejected", stageLabel("rolled_back")) : ""}<span class="faint">${esc(ago(p.updated_at || p.created_at))}</span></div>
        </div>`).join("") || `<div class="kempty">—</div>`}${cols[c].length > 40 ? `<div class="kempty">+${nf(cols[c].length - 40)}</div>` : ""}</div>
    </section>`).join("")}</div>`;
}

function leaderboardHtml(ratings, champs) {
  if (!ratings.length) return `<div class="empty">${t("evo_no_ratings")}</div>`;
  const champIds = new Set(champs.map((r) => r.champion && r.champion.genome_id));
  const groups = {};
  for (const r of ratings) (groups[r.role] = groups[r.role] || []).push(r);
  return Object.entries(groups).map(([role, rows]) => {
    rows.sort((a, b) => (b.conservative ?? -1e9) - (a.conservative ?? -1e9) || b.rating - a.rating);
    const lo = Math.min(...rows.map((x) => x.rating - 2 * (x.rd || 0))), hi = Math.max(...rows.map((x) => x.rating + 2 * (x.rd || 0)));
    const span = hi - lo || 1;
    const pos = (v) => (((v - lo) / span) * 100).toFixed(2);
    return `<div class="lb-group"><div class="lb-role"><span class="hex xs">${esc(glyph(role))}</span>${esc(roleLabel(role))}<span class="faint num">${nf(rows.length)}</span><span class="spacer"></span><span class="faint num lb-scale">${r1(lo)} — ${r1(hi)}</span></div>
      ${rows.slice(0, 12).map((r, i) => `<div class="lb-row ${champIds.has(r.genome_id) ? "is-champ" : ""}">
        <span class="lb-rank num">${i + 1}</span>
        <div class="lb-id"><div class="mono" title="${esc(r.genome_id)}">${esc(short(r.genome_id))} <span class="faint">v${esc(r.version ?? "?")}</span></div><div>${champIds.has(r.genome_id) ? badge("champion", t("st_champion")) : badge(r.status, tOr("st_" + r.status, r.status))}</div></div>
        <div class="lb-bar" role="img" aria-label="${esc(t("evo_rating"))} ${r1(r.rating)} ± ${r1(r.rd)}"><span class="w2" style="inset-inline-start:${pos(r.rating - 2 * r.rd)}%;width:${(pos(r.rating + 2 * r.rd) - pos(r.rating - 2 * r.rd)).toFixed(2)}%"></span><span class="w1" style="inset-inline-start:${pos(r.rating - r.rd)}%;width:${(pos(r.rating + r.rd) - pos(r.rating - r.rd)).toFixed(2)}%"></span><span class="fill" style="width:${pos(r.rating)}%"></span><span class="dot" style="inset-inline-start:${pos(r.rating)}%"></span><span class="cons" style="inset-inline-start:${pos(r.conservative ?? r.rating - 2 * r.rd)}%" title="${esc(t("evo_conservative"))}"></span></div>
        <div class="lb-num num"><b>${r1(r.rating)}</b><span class="faint"> ±${r1(r.rd)}</span><div class="faint lb-sub">${t("evo_cons_short")} ${r1(r.conservative)} · ${nf(r.matches || 0)} ${t("evo_matches_short")}</div></div>
      </div>`).join("")}</div>`;
  }).join("");
}

function banditHtml(ops) {
  if (!ops.length) return `<div class="empty">${t("evo_no_ops")}</div>`;
  const best = ops.reduce((a, o) => ((o.mean ?? 0) > (a.mean ?? 0) ? o : a), ops[0]);
  const maxTrials = Math.max(1, ...ops.map((o) => o.trials || 0));
  return `<div class="bandit">${ops.map((o) => {
    const a = o.alpha || 1, b = o.beta || 1, m = o.mean ?? a / (a + b);
    const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
    const l = Math.max(0, m - sd), h = Math.min(1, m + sd);
    return `<div class="bd-row ${o.id === best.id && (o.trials || 0) > 0 ? "best" : ""}"><div class="bd-nm">${esc(opLabel(o.id))}<span class="faint mono">${esc(o.id)}</span></div>
      <div class="bd-bar" role="img" aria-label="${esc(opLabel(o.id))} ${pctTxt(m)}, ${nf(o.trials || 0)} ${esc(t("evo_trials"))}"><i class="fill" style="width:${(m * 100).toFixed(1)}%"></i><i class="wh" style="inset-inline-start:${(l * 100).toFixed(1)}%;width:${((h - l) * 100).toFixed(1)}%"></i><i class="half"></i></div>
      <div class="bd-num num"><b>${pctTxt(m)}</b><span class="trials"><i style="width:${(((o.trials || 0) / maxTrials) * 100).toFixed(0)}%"></i></span><span class="faint">${nf(o.trials || 0)} ${t("evo_trials")}${o.wins != null ? ` · ${nf(o.wins)} ${t("evo_wins")}` : ""}</span></div></div>`;
  }).join("")}<div class="faint bd-legend">${t("evo_bandit_legend")}</div></div>`;
}

function promotionsHtml(proms, champs) {
  if (!proms.length) return `<div class="empty">${t("evo_no_promotions")}</div>`;
  const cur = Object.fromEntries(champs.map((r) => [r.role, r.champion && r.champion.genome_id]));
  return `<div class="ptl">${proms.slice(0, 40).map((p) => {
    const target = p.from_genome && p.from_genome !== cur[p.role] && p.kind !== "canary_start" ? p.from_genome : null;
    return `<div class="pt ${esc(p.kind)}"><div class="pt-h"><span class="pk ${esc(p.kind)}">${esc(t("pk_" + p.kind))}</span><span class="hex xs">${esc(glyph(p.role))}</span><span>${esc(roleLabel(p.role))}</span><span class="spacer"></span><span class="faint" title="${esc(when(p.at))}">${esc(ago(p.at))}</span></div>
      <div class="pt-flow mono"><span title="${esc(p.from_genome || "")}">${esc(short(p.from_genome))}</span><span class="arr" aria-hidden="true">→</span><span title="${esc(p.to_genome || "")}">${esc(short(p.to_genome))}</span><span class="faint"> · ${esc(p.actor || "")}</span></div>
      ${p.reason ? `<div class="muted pt-why" dir="auto">${esc(p.reason)}</div>` : ""}
      ${target ? `<button class="btn sm ghost rb" data-role="${esc(p.role)}" data-to="${esc(target)}">↶ ${t("evo_rollback_to")} <span class="mono">${esc(short(target))}</span></button>` : ""}
    </div>`;
  }).join("")}</div>`;
}

function notesHtml(notes) {
  if (!notes.length) return `<div class="empty">${t("evo_no_notes")}</div>`;
  return notes.slice(0, 10).map((n) => `<div class="mem"><div class="row"><span class="pk ${esc(n.outcome === "promoted" ? "promote" : n.outcome === "rolled_back" ? "auto_rollback" : "lost")}">${esc(stageLabel(n.outcome))}</span><span class="faint">${esc(roleLabel(n.role))} · ${esc(opLabel(n.operator))}</span>${n.delta != null ? `<span class="num ${n.delta >= 0 ? "pos" : "neg"}">${n.delta >= 0 ? "+" : ""}${nf(Math.round(n.delta * 10) / 10)}</span>` : ""}<span class="spacer"></span><span class="w">${esc(ago(n.at))}</span></div><div dir="auto" class="note-txt">${esc(n.note)}</div></div>`).join("");
}

async function renderEvolution() {
  shell("evolution", t("nav_evolution"), t("evo_sub"), `<div class="skeleton" style="height:70px"></div><div class="champs" style="margin-top:16px">${'<div class="skeleton" style="height:190px"></div>'.repeat(4)}</div><div class="skeleton" style="height:260px;margin-top:16px"></div>`);
  const roleQ = evo.role ? `role=${encodeURIComponent(evo.role)}` : "";
  const [stR, prR, lbR, opR, pmR, ntR, tnR] = await Promise.allSettled([
    apiSoft("/api/evolution/status"),
    apiSoft(`/api/evolution/proposals?limit=200${roleQ ? "&" + roleQ : ""}`),
    apiSoft(`/api/evolution/leaderboard${roleQ ? "?" + roleQ : ""}`),
    apiSoft(`/api/evolution/operators${roleQ ? "?" + roleQ : ""}`),
    apiSoft(`/api/evolution/promotions${roleQ ? "?" + roleQ : ""}`),
    apiSoft(`/api/evolution/notes${roleQ ? "?" + roleQ : ""}`),
    apiSoft(`/api/evolution/tournaments?limit=12${roleQ ? "&" + roleQ : ""}`),
  ]);
  for (const r of [stR, prR, lbR, opR, pmR, ntR, tnR]) if (r.status === "rejected" && r.reason instanceof AuthError) throw r.reason;
  if (stR.status === "rejected") {
    content().innerHTML = failCard(stR.reason, "evolution");
    bindRetry(content());
    return;
  }
  const st = stR.value;
  const champs = st.roles || [];
  const ratings = lbR.status === "fulfilled" ? lbR.value.ratings || [] : [];
  const section = (r, fn) => (r.status === "fulfilled" ? fn(r.value) : failCard(r.reason, "evolution"));
  const roles = champs.length ? champs.map((r) => r.role) : ALL_ROLES;
  if (!evo.genRole || !roles.includes(evo.genRole)) evo.genRole = evo.role || roles[0];

  topActions().innerHTML = `
    <label class="sr" for="genRole">${t("evo_role")}</label><select id="genRole" class="sel-sm">${roles.map((r) => `<option value="${r}" ${r === evo.genRole ? "selected" : ""}>${esc(roleLabel(r))}</option>`).join("")}</select>
    <label class="sr" for="genOp">${t("evo_operator")}</label><select id="genOp" class="sel-sm"><option value="">${t("evo_op_auto")}</option>${EVO_OPS.map((o) => `<option value="${o}" ${o === evo.genOp ? "selected" : ""}>${esc(opLabel(o))}</option>`).join("")}</select>
    <button class="btn sm primary" id="genBtn">${t("evo_run_gen")}</button><button class="btn sm" id="tickBtn">${t("evo_tick")}</button><button class="btn sm" id="replayBtn">▶ ${t("hive_replay")}</button>`;

  const lock = st.lock;
  const lt = st.last_tick;
  content().innerHTML = `
    <div class="hero evo-hero ${st.kill_global ? "danger" : lock ? "busy" : ""}"><span class="pulse"></span>
      <div><div class="t">${st.kill_global ? t("status_killed") : lock ? t("evo_busy") : t("evo_idle")}</div><div class="s">${lock ? `${esc(lock.holder || "")} · ${t("evo_until")} ${esc(when(lock.expires_at))}` : ""}${lt ? `${lock ? " · " : ""}${t("evo_last_tick")} ${esc(ago(lt.at))}${lt.generations != null ? ` · ${nf(Array.isArray(lt.generations) ? lt.generations.length : lt.generations)} ${t("evo_gens")}` : ""}` : `${lock ? " · " : ""}${t("evo_never_ticked")}`}</div></div>
      <div class="spacer"></div>${st.auto != null ? badge(st.auto ? "ok" : "draft", st.auto ? t("evo_auto_on") : t("evo_auto_off")) : ""}
    </div>
    <div class="role-tabs" role="tablist" aria-label="${esc(t("evo_role"))}">${["", ...roles].map((r) => `<button role="tab" aria-selected="${evo.role === r}" class="${evo.role === r ? "on" : ""}" data-role="${r}">${r ? `<span class="hex xs">${esc(glyph(r))}</span>${esc(roleLabel(r))}` : t("evo_all_roles")}</button>`).join("")}</div>
    ${champs.length ? `<div class="champs">${champs.filter((r) => !evo.role || r.role === evo.role).map((r) => championCard(r, ratings)).join("")}</div>` : `<div class="card empty hive-empty">${HIVE_ART}<div class="t">${t("evo_no_champs_t")}</div><div class="muted">${t("evo_no_champs")}</div></div>`}
    <section class="card" style="margin-top:16px"><h2>${t("evo_pipeline")} <span class="hint">${prR.status === "fulfilled" ? nf((prR.value.proposals || []).length) : ""}</span></h2>${section(prR, (v) => ((v.proposals || []).length ? kanban(v.proposals) : `<div class="empty">${t("evo_no_proposals")}</div>`))}</section>
    <div class="grid evo-cols" style="margin-top:16px">
      <section class="card"><h2>${t("evo_leaderboard")} <span class="hint">${t("evo_lb_hint")}</span></h2>${section(lbR, () => leaderboardHtml(ratings, champs))}</section>
      <div class="stack">
        <section class="card"><h2>${t("evo_bandit")} <span class="hint">Beta(α,β)</span></h2>${section(opR, (v) => banditHtml(v.operators || []))}</section>
        <section class="card"><h2>${t("evo_tournaments")}</h2>${section(tnR, (v) => ((v.tournaments || []).length ? `<div class="tn-list">${v.tournaments.map((x) => `<div class="tn" data-id="${esc(x.id)}"><span class="hex xs">${esc(glyph(x.role))}</span><span class="mono">${esc(short(x.id))}</span><span class="faint num">${nf(x.match_count ?? 0)} ${t("evo_matches_short")}</span>${x.status ? badge(x.status === "done" ? "done" : "running", x.status) : ""}<span class="spacer"></span><span class="faint">${esc(ago(x.created_at))}</span></div>`).join("")}</div>` : `<div class="empty">${t("evo_no_tournaments")}</div>`))}</section>
      </div>
    </div>
    <div class="grid g2" style="margin-top:16px;align-items:start">
      <section class="card"><h2>${t("evo_promotions")}</h2>${section(pmR, (v) => promotionsHtml(v.promotions || [], champs))}</section>
      <section class="card"><h2>${t("evo_notes")}</h2>${section(ntR, (v) => notesHtml(v.notes || []))}</section>
    </div>`;
  bindRetry(content(), renderEvolution);
  const c = content();
  c.querySelectorAll(".role-tabs button").forEach((b) => (b.onclick = () => { evo.role = b.dataset.role; if (evo.role) evo.genRole = evo.role; renderEvolution(); }));
  bindClick(c, ".champ", (el) => { evo.role = evo.role === el.dataset.role ? "" : el.dataset.role; if (evo.role) evo.genRole = evo.role; renderEvolution(); });
  bindClick(c, ".kcard", (el) => openProposal(el.dataset.id));
  bindClick(c, ".tn", (el) => openTournament(el.dataset.id));
  c.querySelectorAll("button[data-canary]").forEach((b) => (b.onclick = async () => {
    await busy(b, async () => {
      try { const r = await apiSoft(`/api/evolution/canaries/${encodeURIComponent(b.dataset.canary)}/evaluate`, { method: "POST", body: {} }); toast(`${t("evo_canary")}: ${r.status || (r.canary && r.canary.status) || "✓"}`); renderEvolution(); } catch (e) { actErr(e); }
    });
  }));
  c.querySelectorAll("button.rb").forEach((b) => (b.onclick = () => doRollback(b.dataset.role, b.dataset.to)));
  document.getElementById("replayBtn").onclick = (e) => window.KEXT && KEXT.openHiveReplay(e.currentTarget);
  document.getElementById("genRole").onchange = (e) => (evo.genRole = e.target.value);
  document.getElementById("genOp").onchange = (e) => (evo.genOp = e.target.value);
  document.getElementById("genBtn").onclick = async (ev) => {
    await busy(ev.currentTarget, async () => {
      try {
        const body = { role: evo.genRole };
        if (evo.genOp) body.operator = evo.genOp;
        await startJob("/api/evolution/generation", body, (j) => {
          const g = j.result || {};
          if (j.status === "done" && g.outcome) {
            if (window.KFX) { if (g.outcome === "promoted") { KFX.sound.play("promotion"); KFX.bg.surge(); KFX.confetti({ count: 70 }); } else if (["rejected", "lost", "rolled_back"].includes(g.outcome)) KFX.sound.play("rejection"); }
            if (window.KFX) KFX.toast(`${t("evo_gen_done")} · ${opLabel(g.operator)} → ${tOr("stg_" + g.outcome, g.outcome)}`, { kind: g.outcome === "promoted" ? "ok" : "info", icon: g.outcome === "promoted" ? "promotion" : undefined, sound: false });
            else toast(`${t("evo_gen_done")} · ${opLabel(g.operator)} → ${tOr("stg_" + g.outcome, g.outcome)}`);
          }
          if ((location.hash || "").startsWith("#/evolution")) renderEvolution();
        });
      } catch (e) { actErr(e); }
    });
  };
  document.getElementById("tickBtn").onclick = async (ev) => {
    await busy(ev.currentTarget, async () => {
      try {
        await startJob("/api/evolution/tick", {}, (j) => {
          const s = j.result || {};
          if (j.status === "done") toast(`${t("evo_tick_done")} · ${nf((s.generations || []).length)} ${t("evo_gens")}${s.stopped ? ` · ${s.stopped}` : ""}`);
          if ((location.hash || "").startsWith("#/evolution")) renderEvolution();
        });
      } catch (e) { actErr(e); }
    });
  };
}

async function doRollback(role, to) {
  const ok = await dialog({ title: t("evo_rollback_t"), body: `${esc(t("evo_rollback_body"))}<div class="mono rb-target">${esc(roleLabel(role))} → ${esc(to)}</div>`, confirm: t("evo_rollback_go"), danger: true });
  if (!ok) return;
  try { await apiSoft("/api/evolution/rollback", { method: "POST", body: { role, to_genome_id: to } }); toast(t("evo_rolled_back"), false, "rollback"); closeDrawer(true); renderEvolution(); } catch (e) { actErr(e); }
}

function diffHtml(diff) {
  if (diff == null) return `<div class="empty">${t("evo_no_diff")}</div>`;
  const lines = String(diff).split("\n");
  const add = lines.filter((l) => l.startsWith("+")).length, del = lines.filter((l) => l.startsWith("-")).length;
  return `<div class="diff-head num"><span class="pos">+${nf(add)}</span><span class="neg">−${nf(del)}</span></div><div class="diffv" dir="ltr">${lines.map((l) => `<div class="dl ${l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}"><span class="sg">${l.startsWith("+") ? "+" : l.startsWith("-") ? "−" : " "}</span><span class="tx" dir="auto">${esc(l.replace(/^[+-]\s?/, ""))}</span></div>`).join("")}</div>`;
}
function matchesHtml(matches, myGenome) {
  if (!matches || !matches.length) return `<div class="empty">${t("evo_no_matches")}</div>`;
  let w = 0, l = 0, d = 0;
  const rows = matches.map((m) => {
    const meA = m.a_genome === myGenome, meB = m.b_genome === myGenome;
    const o = Number(m.outcome);
    const mine = meA ? o : meB ? 1 - o : null;
    const res = mine == null ? (o === 0.5 ? "d" : o > 0.5 ? "a" : "b") : mine === 0.5 ? "d" : mine > 0.5 ? "w" : "l";
    if (res === "w") w++; else if (res === "l") l++; else if (res === "d") d++;
    return `<div class="mt ${res}"><span class="mr">${esc(t("mr_" + res))}</span><span class="mono ${meA ? "me" : ""}" title="${esc(m.a_genome)}">${esc(short(m.a_genome))}</span><span class="faint">vs</span><span class="mono ${meB ? "me" : ""}" title="${esc(m.b_genome)}">${esc(short(m.b_genome))}</span><span class="faint mono">${esc(short(m.item_id))}</span><span class="spacer"></span><span class="faint">${esc(m.method || "")}${m.agreement != null && m.agreement < 1 ? ` · ${pctTxt(m.agreement)}` : ""}</span></div>`;
  }).join("");
  return `${myGenome ? `<div class="wld num"><span class="pos">${nf(w)} ${t("evo_w")}</span><span class="neg">${nf(l)} ${t("evo_l")}</span><span class="faint">${nf(d)} ${t("evo_d")}</span></div>` : ""}<div class="mt-list">${rows}</div>`;
}

async function openProposal(id) {
  const body = openDrawer(`<div class="skeleton" style="height:300px"></div>`, t("evo_proposal"));
  let d;
  try { d = await apiSoft(`/api/evolution/proposals/${encodeURIComponent(id)}`); } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    body.innerHTML = failCard(e, "evolution"); bindRetry(body, () => openProposal(id)); return;
  }
  const p = d.proposal || {};
  const sc = p.scores || {};
  const terminal = ["promoted", "rejected", "lost", "rolled_back"].includes(p.stage);
  const tr = sc.tournament;
  body.innerHTML = `
    <div class="dr-head"><div class="hex">${esc(glyph(p.role))}</div><div style="min-width:0"><div class="eyebrow">${t("evo_proposal")} · ${esc(roleLabel(p.role))}</div><h2 class="dr-title">${esc(opLabel(p.operator))}</h2><div class="row" style="margin-top:6px">${badge(EVO_FAIL.includes(p.stage) ? "rejected" : p.stage === "promoted" ? "ok" : "running", stageLabel(p.stage))}<span class="faint mono">${esc(p.id)}</span></div></div></div>
    ${stepper(p)}
    <div class="lineage mono"><span title="${esc(p.parent_genome_id || "")}">${esc(short(p.parent_genome_id))}</span><span class="arr" aria-hidden="true">→</span><b title="${esc(p.genome_id || "")}">${esc(short(p.genome_id))}</b>${d.genome && d.genome.version != null ? `<span class="faint"> v${esc(d.genome.version)}</span>` : ""}</div>
    ${(p.reasons || []).length ? `<div class="note ${EVO_FAIL.includes(p.stage) ? "bad" : ""}"><ul class="reasons">${p.reasons.map((r) => `<li dir="auto">${esc(r)}</li>`).join("")}</ul></div>` : ""}
    ${p.note ? `<div class="muted" dir="auto" style="margin:8px 0">${esc(p.note)}</div>` : ""}
    <div class="dr-stats">
      <div><div class="label">${t("evo_risk")}</div><b class="num">${pctTxt(sc.risk)}</b></div>
      <div><div class="label">${t("evo_sandbox")}</div><b class="num">${sc.sandbox && typeof sc.sandbox.public === "number" ? pctTxt(sc.sandbox.public) : "—"}</b>${sc.sandbox && sc.sandbox.canary ? `<div class="faint num" style="font-size:11.5px">${pctTxt(sc.sandbox.canary.candidate)} vs ${pctTxt(sc.sandbox.canary.champion)}</div>` : ""}</div>
      <div><div class="label">${t("evo_winrate")}</div><b class="num">${tr ? pctTxt(tr.win_rate) : "—"}</b>${tr ? `<div class="faint num" style="font-size:11.5px">${nf(tr.wins)}-${nf(tr.losses)}-${nf(tr.draws)} · LB ${pctTxt(tr.wilson_lower)}</div>` : ""}</div>
      <div><div class="label">${t("evo_gate")}</div>${sc.gate_pass == null ? "—" : sc.gate_pass ? badge("ok", t("pass")) : badge("failed", t("fail"))}</div>
    </div>
    <h3 class="dr-h">${t("evo_diff")}</h3>${diffHtml(d.diff)}
    <h3 class="dr-h">${t("evo_matches")} <span class="hint">${nf((d.matches || []).length)}</span></h3>${matchesHtml(d.matches, p.genome_id)}
    ${d.genome ? `<details class="dr-det"><summary>${t("tab_genome")}</summary><pre class="json">${pretty(d.genome)}</pre></details>` : ""}
    ${p.static_report || p.sandbox_report || p.decision ? `<details class="dr-det"><summary>${t("evo_reports")}</summary><pre class="json">${pretty({ static_report: p.static_report, sandbox_report: p.sandbox_report, decision: p.decision })}</pre></details>` : ""}
    <div class="faint dr-foot">${esc(when(p.created_at))} · ${esc(p.proposer || "")}</div>
    ${!terminal ? `<div class="dr-actions"><button class="btn danger" id="rejBtn">${t("evo_reject")}</button></div>` : ""}`;
  const rj = body.querySelector("#rejBtn");
  if (rj) rj.onclick = async () => {
    const reason = await dialog({ title: t("evo_reject"), body: esc(t("evo_reject_body")), confirm: t("evo_reject"), danger: true, input: { placeholder: t("ef_reason_ph"), fallback: "rejected by owner" } });
    if (reason === false) return;
    await busy(rj, async () => {
      try { await apiSoft(`/api/evolution/proposals/${encodeURIComponent(id)}/reject`, { method: "POST", body: { reason } }); toast(t("evo_rejected")); closeDrawer(true); renderEvolution(); } catch (e) { actErr(e); }
    });
  };
}

async function openTournament(id) {
  const body = openDrawer(`<div class="skeleton" style="height:240px"></div>`, t("evo_tournaments"));
  try {
    const d = await apiSoft(`/api/evolution/tournaments/${encodeURIComponent(id)}`);
    const tn = d.tournament || {};
    body.innerHTML = `<div class="dr-head"><div class="hex">${esc(glyph(tn.role))}</div><div><div class="eyebrow">${t("evo_tournaments")} · ${esc(roleLabel(tn.role))}</div><h2 class="dr-title mono">${esc(tn.id)}</h2></div></div>
      ${d.proposal_id ? `<button class="btn sm" id="toProp">${t("evo_open_proposal")}</button>` : ""}
      ${tn.summary ? `<h3 class="dr-h">${t("evo_summary")}</h3><pre class="json">${pretty(tn.summary)}</pre>` : ""}
      <h3 class="dr-h">${t("evo_matches")} <span class="hint">${nf((d.matches || []).length)}</span></h3>${matchesHtml(d.matches, null)}`;
    const tp = body.querySelector("#toProp");
    if (tp) tp.onclick = () => openProposal(d.proposal_id);
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    body.innerHTML = failCard(e, "evolution"); bindRetry(body, () => openTournament(id));
  }
}

// ---------- router ----------
async function route() {
  applyLang();
  const h = (location.hash || "#/overview").replace(/^#\//, "").split("?")[0];
  const [page, id] = h.split("/");
  if (window.KEXT) KEXT.leave();
  try {
    if (page === "agents" && id) await renderDesk(decodeURIComponent(id));
    else if (page === "agents") await renderAgents();
    else if (page === "runs" && id) await renderRun(decodeURIComponent(id));
    else if (page === "runs") await renderRuns();
    else if (page === "approvals") await renderApprovals();
    else if (page === "evals") await renderEvals();
    else if (page === "evolution") await renderEvolution();
    else if (window.KEXT && KEXT.pages[page]) await KEXT.pages[page](id ? decodeURIComponent(id) : undefined);
    else if (page === "kill") await renderKill();
    else if (page === "audit") await renderAudit();
    else if (page === "settings") await renderSettings();
    else await renderOverview();
    resumeJobs();
    if (window.KFX) KFX.countUp(document.getElementById("content"));
  } catch (e) {
    if (e instanceof AuthError) return renderLogin();
    const c = document.getElementById("content");
    if (c) c.innerHTML = `<div class="card empty"><div>${t("error")}: ${esc(e.message)}</div><button class="btn sm" style="margin-top:10px" onclick="location.reload()">${t("refresh")}</button></div>`;
    else toast(e.message, true);
  }
}
window.addEventListener("hashchange", route);
applyLang();
if (window.KFX) KFX.init();
if (window.KEXT) KEXT.init({ shell, api, apiSoft, t, tOr, esc, nf, when, ago, badge, short, pctTxt, ring, glyph, roleLabel, opLabel, pretty, failCard, bindRetry, bindClick, busy, openDrawer, closeDrawer, dialog, startJob, watchJob, actErr, toast, content, topActions, state, AuthError, NotReady, HIVE_ART, I, NAV, route, toggleLang, renderLogin });
route();
