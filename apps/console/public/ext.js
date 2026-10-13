// Khaliya console extensions: Living Hive (#/hive), Tool Forge (#/forge), Discovery Lab (#/discovery),
// Hive Replay launcher, command palette (Ctrl/Cmd+K) and keyboard shortcuts (?).
// Loaded as a classic script before app.js; app.js calls KEXT.init(K) with its helpers.
(() => {
  "use strict";
  Object.assign(window.I18N.ar, {
    nav_hive: "الخلية الحية", nav_forge: "مصهر الأدوات", nav_discovery: "مختبر الاكتشاف",
    hive_sub: "خريطة حية للوكلاء ونبض الأحداث", hive_map: "خريطة الخلية", hive_feed: "نبض الأحداث", hive_live: "مباشر", hive_paused: "متوقف مؤقتاً",
    hive_agents: "الوكلاء", hive_active: "نشطون الآن", hive_events_h: "أحداث آخر ساعة", hive_no_events: "لا أحداث بعد. ستظهر هنا فور حدوثها.", hive_fallback: "عرض مبسّط من قائمة الوكلاء (نبض الخلية لم يصل للخادم بعد)",
    hive_pause: "إيقاف البث", hive_resume: "استئناف البث", hive_replay: "إعادة تشغيل الخلية", hive_activity: "النشاط", hive_task: "المهمة", hive_open: "افتح المكتب",
    forge_sub: "أدوات يصنعها الوكلاء وتمر عبر ٧ بوابات قبل القبول", forge_submit: "قدّم أداة", forge_all: "الكل", fst_admitted: "مقبولة", fst_pending: "قيد الفحص", fst_rejected: "مرفوضة", fst_deprecated: "متقاعدة",
    forge_gates: "بوابات القبول السبع", forge_no_tools: "لا أدوات في المصهر بعد.", forge_uses: "استخدامات", forge_success: "نسبة النجاح", forge_author: "المؤلف", forge_version: "الإصدار",
    forge_run: "تشغيل الأداة", forge_input: "المدخل (JSON)", forge_output: "المخرج", forge_retire: "إحالة للتقاعد", forge_retire_t: "إحالة الأداة للتقاعد؟", forge_retire_b: "لن يتمكن الوكلاء من استخدامها بعد الآن. يُسجَّل في سجل التدقيق.",
    forge_retired: "أُحيلت للتقاعد", forge_code: "الشيفرة", forge_schema: "مخطط المدخل", forge_report: "تقرير القبول", forge_stats: "إحصاءات الفحص",
    forge_f_name: "الاسم (forge.x.y)", forge_f_desc: "الوصف", forge_f_schema: "مخطط المدخل (JSON Schema)", forge_f_code: "الشيفرة (JavaScript، دالة run)", forge_f_tests: "الاختبارات (JSON)",
    forge_submitting: "جارٍ فحص الأداة عبر البوابات…", forge_admitted: "تم قبول الأداة", forge_rejected_t: "رُفضت الأداة", forge_bad_json: "JSON غير صالح في", forge_not_reached: "لم تصل",
    gate_structure: "البنية", gate_static: "الفحص الثابت", gate_author_tests: "اختبارات المؤلف", gate_adversarial: "هجوم عدائي", gate_determinism: "الحتمية", gate_budget: "الميزانية", gate_critic: "الناقد",
    disc_sub: "مسائل قابلة للتحقق آلياً، وبرامج تتطور لتحسين أفضل نتيجة", disc_problems: "المسائل", disc_no_problems: "لا مسائل بعد.", disc_records: "لوحة السجلات",
    disc_disclaimer: "سجلات داخلية تحقَّق منها المُحقِّق آلياً. ليست ادعاءات علمية منشورة، وكل «تفوّق على المعروف» يحتاج مراجعة بشرية.",
    rst_verified: "مُتحقَّق منه", rst_beats_known_needs_review: "يتفوق على المعروف — يحتاج مراجعة", rst_rejected: "مرفوض", rst_candidate: "مرشّح",
    disc_evolve: "طوِّر", disc_gens: "أجيال", disc_reverify: "أعد التحقق", disc_reverify_all: "أعد التحقق من المعلّق", disc_best: "أفضل نتيجة", dc_best: "الأفضل", dc_best_known: "أفضل معروف",
    disc_islands: "الجزر", disc_generation: "الجيل", disc_heatmap: "خريطة النخبة (MAP-Elites)", disc_heat_hint: "صف لكل جزيرة، خلية لكل سلوك", disc_history: "تاريخ أفضل نتيجة", disc_replay: "إعادة وتصدير فيديو",
    disc_statement: "المسألة", disc_source: "المصدر", disc_no_elites: "لا نخبة بعد. شغّل التطور.", disc_no_records: "لا سجلات بعد.", dc_no_history: "لا تاريخ نتائج بعد", disc_vs: "مقارنة بالمعروف",
    vs_below: "أقل", vs_matches: "يساوي", vs_beats: "يتفوق", vs_unknown: "غير معروف", disc_verif: "تحققات", disc_repro: "قابل للتكرار", dc_min: "الأقل أفضل", dc_max: "الأعلى أفضل",
    disc_new_record: "سجل مُتحقَّق منه!", disc_evolved: "اكتمل التطور", bk_proven_optimal: "مثالي مُثبت", bk_best_known: "أفضل منشور", bk_derived: "مشتق", bk_conjectured: "مُخمَّن", bk_computed: "محسوب محلياً", bk_unverified: "غير مؤكد",
    job_forge: "فحص أداة", job_discovery: "تطوير مسألة", job_reverify: "إعادة تحقق",
    rp_hive_title: "إعادة تشغيل الخلية", rp_disc_title: "إعادة الاكتشاف", rp_play: "تشغيل", rp_pause: "إيقاف مؤقت", rp_scrub: "الخط الزمني", rp_speed: "السرعة", rp_captions: "ترجمة",
    rp_export: "تصدير فيديو WebM", rp_saved: "تم حفظ الفيديو", rp_no_rec: "هذا المتصفح لا يدعم تسجيل الفيديو من اللوحة", rec_recording: "يسجّل", rp_lab: "مختبر التطور", rp_gen: "الجيل",
    rp_demo: "عرض توضيحي — بيانات تجريبية", rp_empty: "لا أحداث تطور بعد", rp_hive_intro: "تطوّر الخلية، جيلاً بعد جيل", rp_disc_intro: "برامج تتطور، ويُتحقَّق منها في كل خطوة",
    rp_c_promo: "ترقية", rp_c_rollback: "تراجع", rp_c_reject: "رُفض", rp_c_proposal: "مقترح", rp_c_newbest: "أفضل نتيجة جديدة", rp_demo_ask: "لا توجد أحداث تطور حقيقية بعد. عرض معاينة ببيانات تجريبية؟", rp_demo_go: "عرض المعاينة",
    snd_title: "الصوت", snd_mute: "كتم الصوت", snd_volume: "مستوى الصوت", snd_ambient: "همهمة الخلية (خلفية)", snd_cats: "الفئات",
    snd_cat_evolution: "التطور", snd_cat_discovery: "الاكتشاف", snd_cat_forge: "المصهر", snd_cat_jobs: "المهام", snd_cat_alerts: "التنبيهات", snd_cat_ui: "نقرات الواجهة",
    snd_t_promotion: "ترقية", snd_t_record: "سجل", snd_t_tool: "أداة", snd_t_rollback: "تراجع", snd_t_rejection: "رفض", snd_t_kill: "إيقاف",
    skip: "تخطَّ", pal_ph: "اكتب أمراً أو صفحة…", pal_none: "لا نتائج", pal_lang: "تبديل اللغة", pal_sound: "إعدادات الصوت", pal_mute: "كتم/تشغيل الصوت", pal_intro: "تشغيل المقدمة", pal_help: "اختصارات لوحة المفاتيح", pal_logout: "خروج", pal_reload: "تحديث الصفحة",
    kb_title: "اختصارات لوحة المفاتيح", kb_palette: "لوحة الأوامر", kb_help: "هذه المساعدة", kb_go: "انتقال إلى…", kb_mute: "كتم الصوت", kb_lang: "تبديل اللغة", kb_esc: "إغلاق النوافذ", kb_then: "ثم",
    hive_jobs: "مهام جارية", forge_duplicate: "هذه الأداة قُدِّمت من قبل", disc_new_candidate: "أفضل نتيجة مرشّحة جديدة (بانتظار إعادة التحقق):", disc_records_n: "سجلات",
    nr_body_hive: "نبض الخلية غير متاح على هذا الخادم حالياً.", nr_body_forge: "واجهة مصهر الأدوات غير متاحة على هذا الخادم حالياً. ستظهر الأدوات هنا فور نشرها.", nr_body_discovery: "واجهة مختبر الاكتشاف غير متاحة على هذا الخادم حالياً. ستظهر المسائل والسجلات هنا فور نشرها.",
    budget_warn: "اقتربت حصة اليوم من الحد", kill_engaged: "مفتاح الإيقاف العام مفعّل", kill_released: "عادت المنظمة للعمل",
  });
  Object.assign(window.I18N.en, {
    nav_hive: "Living Hive", nav_forge: "Tool Forge", nav_discovery: "Discovery Lab",
    hive_sub: "Live map of agents and the event pulse", hive_map: "Hive map", hive_feed: "Event pulse", hive_live: "Live", hive_paused: "Paused",
    hive_agents: "Agents", hive_active: "Active now", hive_events_h: "Events (last hour)", hive_no_events: "No events yet. They appear here as they happen.", hive_fallback: "Simplified view from the agent list (hive pulse not on the server yet)",
    hive_pause: "Pause stream", hive_resume: "Resume stream", hive_replay: "Hive Replay", hive_activity: "Activity", hive_task: "Task", hive_open: "Open desk",
    forge_sub: "Tools built by agents, admitted only through 7 gates", forge_submit: "Submit tool", forge_all: "All", fst_admitted: "Admitted", fst_pending: "Checking", fst_rejected: "Rejected", fst_deprecated: "Retired",
    forge_gates: "The seven admission gates", forge_no_tools: "No tools in the forge yet.", forge_uses: "uses", forge_success: "Success rate", forge_author: "Author", forge_version: "Version",
    forge_run: "Run tool", forge_input: "Input (JSON)", forge_output: "Output", forge_retire: "Retire", forge_retire_t: "Retire this tool?", forge_retire_b: "Agents will no longer be able to use it. Written to the audit log.",
    forge_retired: "Retired", forge_code: "Code", forge_schema: "Input schema", forge_report: "Admission report", forge_stats: "Check statistics",
    forge_f_name: "Name (forge.x.y)", forge_f_desc: "Description", forge_f_schema: "Input schema (JSON Schema)", forge_f_code: "Code (JavaScript, function run)", forge_f_tests: "Tests (JSON)",
    forge_submitting: "Checking the tool through the gates…", forge_admitted: "Tool admitted", forge_rejected_t: "Tool rejected", forge_bad_json: "Invalid JSON in", forge_not_reached: "not reached",
    gate_structure: "Structure", gate_static: "Static scan", gate_author_tests: "Author tests", gate_adversarial: "Adversarial", gate_determinism: "Determinism", gate_budget: "Budget", gate_critic: "Critic",
    disc_sub: "Machine-checkable problems; programs evolve to beat the best score", disc_problems: "Problems", disc_no_problems: "No problems yet.", disc_records: "Records board",
    disc_disclaimer: "Internal records checked by the verifier. Not published scientific claims; every “beats known” needs human review.",
    rst_verified: "Verified", rst_beats_known_needs_review: "Beats known — needs review", rst_rejected: "Rejected", rst_candidate: "Candidate",
    disc_evolve: "Evolve", disc_gens: "generations", disc_reverify: "Re-verify", disc_reverify_all: "Re-verify pending", disc_best: "Best score", dc_best: "Best", dc_best_known: "Best known",
    disc_islands: "Islands", disc_generation: "Generation", disc_heatmap: "Elite map (MAP-Elites)", disc_heat_hint: "row per island, cell per behaviour", disc_history: "Best score history", disc_replay: "Replay & export video",
    disc_statement: "Problem", disc_source: "Source", disc_no_elites: "No elites yet. Run evolution.", disc_no_records: "No records yet.", dc_no_history: "No score history yet", disc_vs: "vs known",
    vs_below: "below", vs_matches: "matches", vs_beats: "beats", vs_unknown: "unknown", disc_verif: "verifications", disc_repro: "reproducible", dc_min: "lower is better", dc_max: "higher is better",
    disc_new_record: "Verified record!", disc_evolved: "Evolution finished", bk_proven_optimal: "proven optimal", bk_best_known: "best published", bk_derived: "derived", bk_conjectured: "conjectured", bk_computed: "computed locally", bk_unverified: "unverified",
    job_forge: "Tool admission", job_discovery: "Problem evolution", job_reverify: "Re-verification",
    rp_hive_title: "Hive Replay", rp_disc_title: "Discovery Replay", rp_play: "Play", rp_pause: "Pause", rp_scrub: "Timeline", rp_speed: "Speed", rp_captions: "Captions",
    rp_export: "Export WebM", rp_saved: "Video saved", rp_no_rec: "This browser can't record canvas video", rec_recording: "Recording", rp_lab: "Evolution lab", rp_gen: "Generation",
    rp_demo: "Demo preview — sample data", rp_empty: "No evolution events yet", rp_hive_intro: "The hive's evolution, generation by generation", rp_disc_intro: "Evolving programs, verified every step",
    rp_c_promo: "Promotion", rp_c_rollback: "Rollback", rp_c_reject: "Rejected", rp_c_proposal: "Proposal", rp_c_newbest: "new best", rp_demo_ask: "No real evolution events yet. Show a preview with sample data?", rp_demo_go: "Show preview",
    snd_title: "Sound", snd_mute: "Mute", snd_volume: "Volume", snd_ambient: "Hive hum (ambient)", snd_cats: "Categories",
    snd_cat_evolution: "Evolution", snd_cat_discovery: "Discovery", snd_cat_forge: "Forge", snd_cat_jobs: "Jobs", snd_cat_alerts: "Alerts", snd_cat_ui: "UI ticks",
    snd_t_promotion: "Promote", snd_t_record: "Record", snd_t_tool: "Tool", snd_t_rollback: "Rollback", snd_t_rejection: "Reject", snd_t_kill: "Kill",
    skip: "Skip", pal_ph: "Type a command or page…", pal_none: "No results", pal_lang: "Switch language", pal_sound: "Sound settings", pal_mute: "Mute / unmute", pal_intro: "Play intro", pal_help: "Keyboard shortcuts", pal_logout: "Log out", pal_reload: "Reload page",
    kb_title: "Keyboard shortcuts", kb_palette: "Command palette", kb_help: "This help", kb_go: "Go to…", kb_mute: "Mute sound", kb_lang: "Switch language", kb_esc: "Close dialogs", kb_then: "then",
    hive_jobs: "Running jobs", forge_duplicate: "This tool was already submitted", disc_new_candidate: "New best candidate (awaiting re-verification):", disc_records_n: "records",
    nr_body_hive: "The hive pulse isn't available on this server right now.", nr_body_forge: "The Tool Forge API isn't available on this server right now. Tools will show up here once it's deployed.", nr_body_discovery: "The Discovery Lab API isn't available on this server right now. Problems and records will show up here once it's deployed.",
    budget_warn: "Today's quota is close to its cap", kill_engaged: "Global kill switch engaged", kill_released: "The organization is running again",
  });

  let K = null;
  const hive = { timer: 0, raf: 0, since: null, feed: [], paused: false, agents: [], flows: [], hover: null, fallback: false, seen: new Set() };
  const forge = { status: "" };
  const reduced = () => window.KFX && KFX.reduced();
  const snd = (n) => window.KFX && KFX.sound.play(n);

  function leave() { clearTimeout(hive.timer); hive.timer = 0; cancelAnimationFrame(hive.raf); hive.raf = 0; }

  // ---------- event → cue mapping ----------
  function cueFor(kind, sev, announce) {
    const k = String(kind || "").toLowerCase();
    if (k.includes("breach")) return k.includes("reject") ? "done" : sev === "critical" ? "kill" : "rejection";
    if (k.includes("reject") || k.includes("lost")) return "rejection";
    if (k.includes("needs_review") || k === "new_record" || k.includes("candidate")) return "notify"; // never celebrated (honesty rule)
    if (k.includes("record")) return announce === false ? "notify" : "record";
    if (k.includes("rollback")) return "rollback";
    if (k.includes("promot")) return "promotion";
    if (k.includes("kill")) return sev === "critical" ? "kill" : "done";
    if (k.includes("budget") || k.includes("quota") || k.includes("cap")) return "budget";
    if (k.includes("tool") && (k.includes("admit") || k.includes("accept"))) return announce === false ? "notify" : "tool";
    if (k.includes("fail") || k.includes("error")) return "failed";
    if (k.includes("done") || k.includes("complete") || k.includes("finish")) return "done";
    return sev === "high" || sev === "critical" || sev === "warn" || sev === "warning" ? "notify" : sev === "success" ? "done" : null;
  }
  const KIND_COLOR = { record: "gold", promotion: "amber", rollback: "blue", rejection: "red", failed: "red", kill: "red", budget: "warn", tool: "green", done: "green", notify: "amber" };
  function refHref(ref) {
    if (!ref) return null;
    if (typeof ref === "object") {
      if (ref.problem_id) return `#/discovery/${encodeURIComponent(ref.problem_id)}`;
      if (ref.type === "tool" && (ref.name || ref.id)) return `#/forge?tool=${encodeURIComponent(ref.name || ref.id)}`;
      if (ref.type === "kill") return "#/kill";
      if (ref.type === "redteam" || ref.type === "breach" || ref.type === "attack" || ref.type === "campaign") return "#/redteam";
      if (ref.type === "kb" || ref.type === "doc" || ref.type === "memory") return "#/memory";
      if (ref.type === "court" || ref.type === "judge" || ref.type === "spotcheck") return "#/court";
      if (ref.type === "budget" || ref.type === "governor") return "#/overview";
      ref = ref.type && ref.id ? `${ref.type}:${ref.id}` : ref.href || ref.url || null;
    }
    if (!ref || typeof ref !== "string") return null;
    if (ref.startsWith("#/")) return ref;
    const [k, ...rest] = ref.split(":"); const id = encodeURIComponent(rest.join(":"));
    if (!id) return null;
    return { agent: `#/agents/${id}`, run: `#/runs/${id}`, tool: `#/forge?tool=${id}`, forge: `#/forge?tool=${id}`, problem: `#/discovery/${id}`, discovery: `#/discovery/${id}`, record: null, proposal: "#/evolution", genome: "#/evolution", approval: "#/approvals", redteam: "#/redteam", breach: "#/redteam", attack: "#/redteam", kb: "#/memory", doc: "#/memory", court: "#/court", judge: "#/court", spotcheck: "#/court" }[k] || null;
  }

  // ======================================================================
  // Living Hive
  // ======================================================================
  function normAgent(a) {
    const act = a.activity ?? a.load ?? a.pulse ?? (a.busy || a.running || a.status === "running" || a.current_task ? 0.85 : a.status === "champion" ? 0.35 : 0.15);
    return { id: a.id, role: a.role, name: a.name || a.id, status: a.status, killed: !!a.killed || a.status === "retired", activity: Math.max(0, Math.min(1, Number(act) || 0)), parent: a.parent_id || a.parent || a.lineage_parent || null, task: a.current_task || a.task || null, elo: a.rating ?? a.elo ?? null, champion: a.status === "champion" || a.champion };
  }
  const RING = (() => { const out = [[0, 0]]; const dirs = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]; for (let r = 1; r < 6; r++) { let q = -r, s = r; for (let d = 0; d < 6; d++) for (let i = 0; i < r; i++) { out.push([q, s]); q += dirs[d][0]; s += dirs[d][1]; } } return out; })();
  const ROLE_ORDER = ["director", "architect", "researcher", "builder", "toolsmith", "evaluator", "critic", "librarian", "auditor"];

  async function renderHive() {
    leave();
    const { t, esc, nf } = K;
    K.shell("hive", t("nav_hive"), t("hive_sub"), `<div class="grid g4">${'<div class="skeleton" style="height:96px"></div>'.repeat(4)}</div><div class="grid hive-cols" style="margin-top:16px"><div class="skeleton" style="height:480px"></div><div class="skeleton" style="height:480px"></div></div>`);
    let pulse;
    try { pulse = await fetchPulse(); } catch (e2) { if (e2 instanceof K.AuthError) throw e2; K.content().innerHTML = K.failCard(e2, "hive"); K.bindRetry(K.content(), renderHive); return; }
    hive.feed = []; hive.since = null; hive.seen = new Set();
    K.topActions().innerHTML = `<span class="live-pill ${hive.paused ? "off" : ""}" id="livePill"><i></i>${t(hive.paused ? "hive_paused" : "hive_live")}</span>
      <button class="btn sm" id="hivePause">${t(hive.paused ? "hive_resume" : "hive_pause")}</button>
      <button class="btn sm primary" id="hiveReplay">▶ ${t("hive_replay")}</button>`;
    K.content().innerHTML = `
      <div class="grid g4" id="hiveStats"></div>
      ${hive.fallback ? `<div class="faint hive-note">${esc(t("hive_fallback"))}</div>` : ""}
      <div class="grid hive-cols" style="margin-top:16px">
        <section class="card hive-map-card"><h2>${t("hive_map")} <span class="hint" id="hiveCount"></span></h2>
          <div class="hive-stage"><canvas id="hiveCv" role="img" aria-label="${esc(t("hive_map"))}"></canvas><div class="hive-tip" id="hiveTip" hidden></div></div>
          <div class="hive-legend" id="hiveLegend" aria-label="${esc(t("hive_agents"))}"></div>
        </section>
        <section class="card hive-feed-card"><h2>${t("hive_feed")} <span class="hint num" id="feedN"></span></h2><ol class="feed" id="hiveFeed" aria-live="polite" aria-relevant="additions"></ol></section>
      </div>`;
    document.getElementById("hivePause").onclick = () => { hive.paused = !hive.paused; renderHivePausedUi(); if (!hive.paused) poll(); };
    document.getElementById("hiveReplay").onclick = (e) => openHiveReplay(e.currentTarget);
    await loadEvents(true);
    applyPulse(pulse);
    startMap();
    hive.timer = setTimeout(poll, 5000);
  }
  /** Cells come from /api/agents (per-agent); the pulse adds org-wide counts. Either may be missing. */
  async function fetchPulse() {
    const [pr, ar] = await Promise.allSettled([K.apiSoft("/api/hive/pulse"), K.api("/api/agents")]);
    for (const r of [pr, ar]) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason;
    if (pr.status === "rejected" && ar.status === "rejected") throw ar.reason;
    const p = pr.status === "fulfilled" ? pr.value : {};
    hive.fallback = pr.status === "rejected";
    const list = Array.isArray(p.agents) ? p.agents : ar.status === "fulfilled" ? ar.value.agents || [] : [];
    return { ...p, cells: list, counts: Array.isArray(p.agents) ? null : p.agents || null };
  }
  function renderHivePausedUi() {
    const p = document.getElementById("livePill"), b = document.getElementById("hivePause");
    if (p) { p.className = "live-pill " + (hive.paused ? "off" : ""); p.innerHTML = `<i></i>${K.t(hive.paused ? "hive_paused" : "hive_live")}`; }
    if (b) b.textContent = K.t(hive.paused ? "hive_resume" : "hive_pause");
  }
  function applyPulse(p) {
    const { t, esc, nf } = K;
    const prev = new Map(hive.agents.map((a) => [a.id, a]));
    const list = (p.cells || (Array.isArray(p.agents) ? p.agents : [])).map(normAgent).sort((a, b) => (ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role)) || String(a.id).localeCompare(String(b.id)));
    list.forEach((a, i) => { a.ax = RING[i] || [i, 0]; const o = prev.get(a.id); a.phase = o ? o.phase : Math.random() * 6.28; });
    hive.agents = list;
    const active = p.jobs && p.jobs.active != null ? p.jobs.active : list.filter((a) => !a.killed && a.activity >= 0.5).length;
    const evH = p.events_last_hour ?? hive.feed.filter((e) => Date.now() - (e.ts || 0) < 3600e3).length;
    const st = document.getElementById("hiveStats");
    if (st) st.innerHTML = `
      <div class="card stat"><div class="label">${t("hive_agents")}</div><div class="value">${nf(p.counts && p.counts.live != null ? p.counts.live : list.filter((a) => !a.killed).length)}</div></div>
      <div class="card stat"><div class="label">${t(p.jobs ? "hive_jobs" : "hive_active")}</div><div class="value">${nf(active)}</div></div>
      <div class="card stat"><div class="label">${t("hive_events_h")}</div><div class="value">${nf(evH)}</div></div>
      <div class="card stat ${p.kill_global ? "kill-on" : ""}"><div class="label">${t("nav_kill")}</div><div class="value sm">${p.kill_global ? K.badge("killed", t("status_killed")) : K.badge("ok", t("status_running"))}</div></div>`;
    if (window.KFX) KFX.countUp(st);
    const c = document.getElementById("hiveCount"); if (c) c.textContent = nf(list.length);
    const lg = document.getElementById("hiveLegend");
    if (lg) {
      lg.innerHTML = list.map((a) => `<a href="#/agents/${encodeURIComponent(a.id)}" class="hl ${a.killed ? "off" : ""}" data-id="${esc(a.id)}"><span class="hex xs">${esc(K.glyph(a.role))}</span>${esc(K.state.lang === "ar" ? K.roleLabel(a.role) : a.name)}<i style="--a:${a.activity.toFixed(2)}"></i></a>`).join("") || `<div class="empty">${t("seed_empty")}</div>`;
      lg.querySelectorAll(".hl").forEach((el) => { el.onmouseenter = el.onfocus = () => (hive.hover = el.dataset.id); el.onmouseleave = el.onblur = () => (hive.hover = null); });
    }
    if (reduced()) drawMap(performance.now());
  }
  async function loadEvents(first) {
    let r;
    try { r = await K.apiSoft(`/api/hive/events?limit=${first ? 40 : 30}${hive.since ? `&since=${encodeURIComponent(hive.since)}` : ""}`); }
    catch (e) { if (e instanceof K.AuthError) throw e; if (first) paintFeed(); return; }
    const items = (r.items || r.events || []).filter((x) => x && !hive.seen.has(x.id ?? `${x.ts}:${x.kind}:${x.title_en}`));
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const it of items) {
      hive.seen.add(it.id ?? `${it.ts}:${it.kind}:${it.title_en}`);
      hive.feed.unshift(it);
      if (!first) react(it);
    }
    if (r.next_since != null) hive.since = r.next_since; else if (items.length) hive.since = items[items.length - 1].ts;
    hive.feed = hive.feed.slice(0, 80);
    paintFeed(first ? 0 : items.length);
  }
  function paintFeed(fresh = 0) {
    const el = document.getElementById("hiveFeed"); if (!el) return;
    const { t, esc, nf } = K;
    document.getElementById("feedN").textContent = hive.feed.length ? nf(hive.feed.length) : "";
    if (!hive.feed.length) { el.innerHTML = `<li class="feed-empty">${window.HIVE_ART_HTML || ""}<div>${t("hive_no_events")}</div></li>`; return; }
    el.innerHTML = hive.feed.map((e, i) => {
      const cue = cueFor(e.kind, e.severity, e.announce) || "info", href = refHref(e.ref);
      const title = (K.state.lang === "ar" ? e.title_ar || e.title_en : e.title_en || e.title_ar) || e.kind;
      const inner = `<span class="fe-dot ${KIND_COLOR[cue] || ""}" aria-hidden="true"></span><div class="fe-b"><div class="fe-t" dir="auto">${esc(title)}</div><div class="fe-m"><span class="mono">${esc(e.kind || "")}</span>${e.severity ? `<span class="sev ${esc(e.severity)}">${esc(e.severity)}</span>` : ""}<span class="spacer"></span><span title="${esc(K.when(e.ts))}">${esc(K.ago(e.ts))}</span></div></div>`;
      return `<li class="fe ${i < fresh ? "new" : ""}">${href ? `<a href="${esc(href)}">${inner}</a>` : `<div>${inner}</div>`}</li>`;
    }).join("");
  }
  function react(e) {
    const cue = cueFor(e.kind, e.severity, e.announce);
    if (cue) snd(cue);
    const title = (K.state.lang === "ar" ? e.title_ar || e.title_en : e.title_en || e.title_ar) || e.kind;
    const big = ["record", "promotion", "rollback", "kill", "budget", "tool"].includes(cue) || e.severity === "high" || e.severity === "critical" || e.severity === "warning";
    if (big && window.KFX) KFX.toast(title, { kind: cue === "kill" || cue === "rejection" || cue === "failed" ? "err" : cue === "budget" || e.severity === "warning" ? "warn" : cue === "record" ? "record" : "ok", icon: ["record", "promotion", "rollback", "tool", "kill"].includes(cue) ? cue : undefined, sound: false });
    if (cue === "record" && e.announce !== false && window.KFX) KFX.confetti();
    if (cue === "kill" && window.KFX) KFX.shake();
    // map flow toward referenced agent
    const ref = typeof e.ref === "string" ? e.ref : (e.ref && e.ref.type === "agent" && e.ref.id) || "";
    const target = hive.agents.find((a) => ref && (ref === a.id || ref.endsWith(":" + a.id))) || (e.role && hive.agents.find((a) => a.role === e.role));
    if (target) hive.flows.push({ to: target.id, from: target.parent, t0: performance.now(), col: cue === "rollback" ? "106,168,255" : cue === "rejection" || cue === "failed" ? "239,91,91" : "245,184,61" });
    if (window.KFX && (cue === "promotion" || cue === "record")) KFX.bg.surge(undefined, undefined, "245,184,61");
  }
  async function poll() {
    clearTimeout(hive.timer);
    if (!document.getElementById("hiveCv") || hive.paused) return;
    if (!document.hidden) {
      try {
        applyPulse(await fetchPulse());
        await loadEvents(false);
      } catch (e) { if (e instanceof K.AuthError) return; }
    }
    if (document.getElementById("hiveCv") && !hive.paused) hive.timer = setTimeout(poll, 5000);
  }
  // ---- map renderer ----
  let mapGeom = null;
  function startMap() {
    const cv = document.getElementById("hiveCv"); if (!cv) return;
    const fit = () => { const r = cv.parentElement.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1); cv.width = r.width * dpr; cv.height = r.height * dpr; cv.style.width = r.width + "px"; cv.style.height = r.height + "px"; mapGeom = { w: r.width, h: r.height, dpr }; };
    fit();
    if (window.ResizeObserver) new ResizeObserver(() => { if (cv.isConnected) { fit(); if (reduced()) drawMap(performance.now()); } }).observe(cv.parentElement);
    const tip = document.getElementById("hiveTip");
    cv.onmousemove = (ev) => {
      const r = cv.getBoundingClientRect(), x = ev.clientX - r.left, y = ev.clientY - r.top;
      const a = hitAgent(x, y);
      hive.hover = a ? a.id : null; cv.style.cursor = a ? "pointer" : "default";
      if (a) { const { esc, t } = K; tip.hidden = false; tip.innerHTML = `<b>${esc(K.state.lang === "ar" ? K.roleLabel(a.role) : a.name)}</b><div class="mono faint">${esc(a.id)}</div><div>${K.badge(a.killed ? "killed" : a.status, a.killed ? t("killed") : undefined)}</div><div class="faint">${t("hive_activity")}: ${Math.round(a.activity * 100)}%${a.elo != null ? ` · ${Math.round(a.elo)} Elo` : ""}</div>${a.task ? `<div class="tip-task" dir="auto">${esc(String(a.task).slice(0, 120))}</div>` : ""}`; tip.style.left = Math.min(r.width - 230, x + 14) + "px"; tip.style.top = Math.min(r.height - 110, y + 14) + "px"; }
      else tip.hidden = true;
      if (reduced()) drawMap(performance.now());
    };
    cv.onmouseleave = () => { hive.hover = null; tip.hidden = true; };
    cv.onclick = (ev) => { const r = cv.getBoundingClientRect(); const a = hitAgent(ev.clientX - r.left, ev.clientY - r.top); if (a) location.hash = "#/agents/" + encodeURIComponent(a.id); };
    if (reduced()) { drawMap(performance.now()); return; }
    const loop = (ts) => { if (!cv.isConnected) return; if (!document.hidden) drawMap(ts); hive.raf = requestAnimationFrame(loop); };
    hive.raf = requestAnimationFrame(loop);
  }
  function bounds() {
    if (!hive.agents.length) return { cx: 0, cy: 0, w: 1, h: 1 };
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const a of hive.agents) { const [q, r] = a.ax, x = Math.sqrt(3) * (q + r / 2), y = 1.5 * r; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0 + Math.sqrt(3), h: y1 - y0 + 2 };
  }
  function cellR() { if (!mapGeom) return 40; const b = bounds(); return Math.max(18, Math.min(64, (mapGeom.w - 40) / b.w, (mapGeom.h - 50) / b.h)); }
  function cellXY(a) { const R = cellR(), b = bounds(), [q, r] = a.ax; return [mapGeom.w / 2 + R * (Math.sqrt(3) * (q + r / 2) - b.cx), mapGeom.h / 2 + R * (1.5 * r - b.cy)]; }
  function hitAgent(x, y) { if (!mapGeom) return null; const R = cellR(); return hive.agents.find((a) => { const [cx, cy] = cellXY(a); return Math.hypot(cx - x, cy - y) < R * 0.86; }) || null; }
  function drawMap(ts) {
    const cv = document.getElementById("hiveCv"); if (!cv || !mapGeom) return;
    const c = cv.getContext("2d"), { w, h, dpr } = mapGeom, R = cellR(), T = ts / 1000;
    c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const byId = new Map(hive.agents.map((a) => [a.id, a]));
    // lineage edges
    c.lineWidth = 1.2;
    for (const a of hive.agents) { const p = a.parent && byId.get(a.parent); if (!p) continue; const [x1, y1] = cellXY(p), [x2, y2] = cellXY(a); c.strokeStyle = "rgba(245,184,61,0.22)"; c.setLineDash([4, 5]); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); }
    c.setLineDash([]);
    // cells
    for (const a of hive.agents) {
      const [x, y] = cellXY(a), sel = hive.hover === a.id;
      const rate = 0.6 + a.activity * 3.2, beat = reduced() ? 0.5 : 0.5 + 0.5 * Math.sin(T * rate + a.phase);
      const glow = a.killed ? 0 : a.activity * (0.45 + 0.55 * beat);
      c.save();
      if (!a.killed) { c.shadowColor = `rgba(245,184,61,${0.25 + glow * 0.6})`; c.shadowBlur = 6 + glow * 26 + (sel ? 16 : 0); }
      KVID.hexPath(c, x, y, R * 0.9 * (sel ? 1.05 : 1));
      if (a.killed) c.fillStyle = "rgba(58,51,38,0.9)";
      else { const g = c.createLinearGradient(x - R, y - R, x + R, y + R); g.addColorStop(0, `rgba(245,184,61,${0.18 + glow * 0.55})`); g.addColorStop(1, `rgba(232,116,59,${0.12 + glow * 0.45})`); c.fillStyle = g; }
      c.fill(); c.shadowBlur = 0;
      c.strokeStyle = a.killed ? "rgba(111,103,90,0.7)" : sel ? "#ffe2a3" : `rgba(245,184,61,${0.4 + glow * 0.5})`; c.lineWidth = sel ? 2.4 : 1.4; c.stroke();
      c.restore();
      c.font = `700 ${Math.round(R * 0.5)}px "IBM Plex Sans Arabic", Inter, sans-serif`; c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = a.killed ? "#6f675a" : glow > 0.55 ? "#1a1208" : "#f3ede2";
      c.fillText(K.glyph(a.role), x, y - (R > 34 ? R * 0.08 : 0));
      if (R > 34) { c.font = `500 ${Math.round(R * 0.2)}px "JetBrains Mono", monospace`; c.fillStyle = a.killed ? "#6f675a" : glow > 0.55 ? "rgba(26,18,8,.75)" : "#a39a89"; c.fillText(Math.round(a.activity * 100) + "%", x, y + R * 0.38); }
      if (a.champion && !a.killed) { c.fillStyle = "#ffd36b"; KVID.hexPath(c, x, y - R * 0.86, R * 0.13); c.fill(); }
    }
    // flows
    const now = performance.now();
    hive.flows = hive.flows.filter((f) => now - f.t0 < 1800);
    for (const f of hive.flows) {
      const to = byId.get(f.to); if (!to) continue;
      const [x2, y2] = cellXY(to), from = f.from && byId.get(f.from), [x1, y1] = from ? cellXY(from) : [w / 2, -10];
      const p = (now - f.t0) / 1800;
      for (let k = 0; k < 12; k++) { const q = Math.max(0, Math.min(1, p * 1.6 - k * 0.04)); if (q <= 0 || q >= 1) continue; c.fillStyle = `rgba(${f.col},${1 - k / 12})`; c.beginPath(); c.arc(x1 + (x2 - x1) * q, y1 + (y2 - y1) * q, 3 - k * 0.15, 0, 7); c.fill(); }
      if (p > 0.6) { const q = (p - 0.6) / 0.4; c.strokeStyle = `rgba(${f.col},${1 - q})`; c.lineWidth = 2.5; KVID.hexPath(c, x2, y2, R * (0.95 + q * 0.7)); c.stroke(); }
    }
    if (!hive.agents.length) { c.fillStyle = "#6f675a"; c.font = '500 15px "IBM Plex Sans Arabic", Inter'; c.textAlign = "center"; c.fillText(K.t("seed_empty"), w / 2, h / 2); }
  }

  // ---------- Hive Replay ----------
  async function openHiveReplay(btn) {
    const run = async () => {
      const [pm, pr, lb] = await Promise.allSettled([K.apiSoft("/api/evolution/promotions"), K.apiSoft("/api/evolution/proposals?limit=300"), K.apiSoft("/api/evolution/leaderboard")]);
      for (const r of [pm, pr, lb]) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason;
      let data = { promotions: pm.status === "fulfilled" ? pm.value.promotions || [] : [], proposals: pr.status === "fulfilled" ? pr.value.proposals || [] : [], ratings: lb.status === "fulfilled" ? lb.value.ratings || [] : [] };
      if (!data.promotions.length && !data.proposals.length) {
        const ok = await K.dialog({ title: K.t("hive_replay"), body: K.esc(K.t("rp_demo_ask")), confirm: K.t("rp_demo_go") });
        if (!ok) return;
        data = KVID.demoHive();
      }
      data.roleLabel = K.roleLabel; data.opLabel = K.opLabel;
      KVID.player(KVID.hiveScene(data));
    };
    try { btn ? await K.busy(btn, run) : await run(); } catch (e) { K.actErr(e); }
  }

  // ======================================================================
  // Tool Forge
  // ======================================================================
  const GATES = ["structure", "static", "author_tests", "adversarial", "determinism", "budget", "critic"];
  const GATE_ICON = { structure: "▦", static: "⌕", author_tests: "✓", adversarial: "⚔", determinism: "≡", budget: "⏱", critic: "◎" };
  function gatePipe(gates, { live = false, legend = false } = {}) {
    const by = new Map((gates || []).map((g) => [g.gate, g]));
    let failed = false;
    return `<ol class="fpipe ${live ? "live" : ""} ${legend ? "legend" : ""}" aria-label="${K.esc(K.t("forge_gates"))}">${GATES.map((g, i) => {
      const r = by.get(g);
      let cls = legend ? "idle" : live ? "scan" : "na", note = "";
      if (!legend && !live) {
        if (failed) { cls = "na"; note = K.t("forge_not_reached"); }
        else if (r) { cls = r.skipped ? "skip" : r.pass ? "pass" : "fail"; if (!r.pass && !r.skipped) failed = true; note = r.reason || (r.warnings && r.warnings.length ? r.warnings.join(" · ") : ""); }
      }
      return `<li class="fg ${cls}" style="--i:${i}"><span class="fg-hex" aria-hidden="true">${GATE_ICON[g]}</span><span class="fg-n">${K.esc(K.t("gate_" + g))}</span>${note ? `<span class="fg-why" dir="auto" title="${K.esc(note)}">${K.esc(note.slice(0, 90))}</span>` : ""}<span class="sr">${K.esc(cls)}</span></li>`;
    }).join("")}</ol>`;
  }
  const toolGates = (x) => (x && (x.report && x.report.gates)) || x.gates || [];
  const toolDesc = (x) => (x.spec && x.spec.description) || x.description || "";
  const rate = (x) => (x.success_rate != null ? x.success_rate : x.uses ? (x.successes || 0) / x.uses : null);

  async function renderForge() {
    leave();
    const { t, esc, nf } = K;
    const q = new URLSearchParams((location.hash.split("?")[1] || ""));
    K.shell("forge", t("nav_forge"), t("forge_sub"), `<div class="skeleton" style="height:120px"></div><div class="tools-grid" style="margin-top:16px">${'<div class="skeleton" style="height:170px"></div>'.repeat(6)}</div>`);
    K.topActions().innerHTML = `<div class="seg" role="tablist">${["", "admitted", "pending", "rejected", "deprecated"].map((s) => `<button role="tab" aria-selected="${forge.status === s}" class="${forge.status === s ? "on" : ""}" data-s="${s}">${t(s ? "fst_" + s : "forge_all")}</button>`).join("")}</div><button class="btn sm primary" id="forgeSubmit">+ ${t("forge_submit")}</button>`;
    K.topActions().querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { forge.status = b.dataset.s; renderForge(); }));
    document.getElementById("forgeSubmit").onclick = openSubmit;
    let r;
    try { r = await K.apiSoft(`/api/forge/tools${forge.status ? `?status=${forge.status}` : ""}`); }
    catch (e) { if (e instanceof K.AuthError) throw e; K.content().innerHTML = `<section class="card forge-hero"><h2>${t("forge_gates")}</h2>${gatePipe([], { legend: true })}</section><div style="margin-top:16px">${K.failCard(e, "forge")}</div>`; K.bindRetry(K.content(), renderForge); return; }
    const tools = r.tools || [];
    const cnt = (s) => tools.filter((x) => x.status === s).length;
    K.content().innerHTML = `
      <section class="card forge-hero"><h2>${t("forge_gates")}<span class="spacer"></span><span class="hint num">${nf(cnt("admitted"))} ${t("fst_admitted")} · ${nf(cnt("pending"))} ${t("fst_pending")} · ${nf(cnt("rejected"))} ${t("fst_rejected")}</span></h2>${gatePipe([], { legend: true })}</section>
      ${tools.length ? `<div class="tools-grid" style="margin-top:16px">${tools.map((x, i) => `
        <article class="card ftool ${esc(x.status)}" data-name="${esc(x.name)}" style="--i:${i}">
          <div class="tool-top"><span class="tool-ico" aria-hidden="true">⚒</span><div style="min-width:0;flex:1"><div class="mono tool-nm" dir="ltr">${esc(x.name)}</div><div class="faint">v${esc(x.version ?? 1)} · ${esc(x.author || "—")}</div></div>${K.badge(x.status === "admitted" ? "ok" : x.status === "pending" ? "pending" : x.status === "rejected" ? "rejected" : "retired", t("fst_" + x.status) || x.status)}</div>
          <div class="muted tool-desc" dir="auto">${esc(toolDesc(x))}</div>
          <div class="gmini" aria-hidden="true">${GATES.map((g) => { const gr = toolGates(x).find((y) => y.gate === g); return `<i class="${gr ? (gr.skipped ? "skip" : gr.pass ? "pass" : "fail") : "na"}" title="${esc(t("gate_" + g))}"></i>`; }).join("")}</div>
          <div class="tool-foot">${K.ring(rate(x), t("forge_success"), 44)}<div><b class="num">${nf(x.uses || 0)}</b> <span class="faint">${t("forge_uses")}</span></div><span class="spacer"></span><span class="faint">${esc(K.ago(x.admitted_at || x.updated_at || x.created_at))}</span></div>
        </article>`).join("")}</div>` : `<div class="card empty hive-empty" style="margin-top:16px">${K.HIVE_ART}<div class="t">${t("forge_no_tools")}</div><button class="btn sm primary" style="margin-top:12px" data-sub>+ ${t("forge_submit")}</button></div>`}`;
    const sb = K.content().querySelector("[data-sub]"); if (sb) sb.onclick = openSubmit;
    K.bindClick(K.content(), ".ftool", (el) => openTool(el.dataset.name));
    if (q.get("tool")) openTool(q.get("tool"));
  }
  async function openTool(name) {
    const { t, esc, nf } = K;
    const body = K.openDrawer(`<div class="skeleton" style="height:90px"></div><div class="skeleton" style="height:200px;margin-top:14px"></div>`, name);
    let d;
    try { d = await K.apiSoft(`/api/forge/tools/${encodeURIComponent(name)}`); } catch (e) { if (e instanceof K.AuthError) return K.renderLogin(); body.innerHTML = K.failCard(e, "forge"); K.bindRetry(body, () => openTool(name)); return; }
    const x = d.tool || d, rep = d.report || x.report || {}, stats = rep.stats || {}, spec = x.spec || {};
    const runs = (d.usage && d.usage.recent_runs) || d.runs || x.runs || [];
    if (rep.gates && rep.gates.length) x.report = rep;
    body.innerHTML = `
      <div class="dr-head"><span class="tool-ico big" aria-hidden="true">⚒</span><div style="min-width:0"><h2 class="mono" dir="ltr">${esc(x.name)}</h2><div class="faint">v${esc(x.version ?? 1)} · ${esc(x.author || "—")} · ${esc(K.when(x.admitted_at || x.created_at))}</div></div></div>
      <div class="row" style="margin:10px 0 4px">${K.badge(x.status === "admitted" ? "ok" : x.status === "pending" ? "pending" : x.status === "rejected" ? "rejected" : "retired", t("fst_" + x.status) || x.status)}${x.status_reason ? `<span class="faint" dir="auto">${esc(x.status_reason)}</span>` : ""}</div>
      <p class="muted" dir="auto">${esc(toolDesc(x))}</p>
      <h3>${t("forge_report")}</h3>${gatePipe(toolGates(x))}
      ${Object.keys(stats).length ? `<div class="fstats">${Object.entries(stats).map(([k, v]) => `<div><span class="faint">${esc(k)}</span><b class="num">${esc(typeof v === "number" ? nf(v) : v)}</b></div>`).join("")}</div>` : ""}
      ${Array.isArray(rep.warnings) && rep.warnings.length ? `<div class="warnbox" dir="auto">${rep.warnings.map(esc).join("<br>")}</div>` : ""}
      <div class="grid g2" style="margin-top:12px"><div class="card mini"><div class="faint">${t("forge_uses")}</div><b class="num big">${nf(x.uses || 0)}</b></div><div class="card mini row">${K.ring(rate(x), t("forge_success"), 56)}<div class="faint">${t("forge_success")}</div></div></div>
      ${x.status === "admitted" ? `<h3>${t("forge_run")}</h3><label class="sr" for="ftIn">${t("forge_input")}</label><textarea id="ftIn" class="code-in" dir="ltr" rows="5" spellcheck="false">${esc(JSON.stringify(sampleInput(spec.input_schema || x.input_schema), null, 2))}</textarea>
        <div class="row" style="margin-top:8px"><button class="btn primary sm" id="ftRun">▶ ${t("forge_run")}</button><span class="spacer"></span><button class="btn danger sm" id="ftRetire">${t("forge_retire")}</button></div><pre class="ft-out" id="ftOut" hidden></pre>` : ""}
      ${spec.input_schema || x.input_schema ? `<h3>${t("forge_schema")}</h3><pre dir="ltr">${K.pretty(spec.input_schema || x.input_schema)}</pre>` : ""}
      ${x.code ? `<h3>${t("forge_code")}</h3><pre dir="ltr" class="codeblock">${esc(x.code)}</pre>` : ""}
      ${runs.length ? `<h3>${t("nav_runs")}</h3><div class="ft-runs">${runs.slice(0, 12).map((r) => `<div class="row"><span class="dotx ${r.ok || r.success ? "ok" : "bad"}"></span><span class="mono faint">${esc(r.caller || r.agent_id || "")}</span><span class="spacer"></span><span class="faint num">${esc(r.ms != null ? nf(r.ms) + "ms" : "")}</span><span class="faint">${esc(K.ago(r.at || r.created_at))}</span></div>`).join("")}</div>` : ""}`;
    const run = body.querySelector("#ftRun");
    if (run) run.onclick = () => K.busy(run, async () => {
      let input; try { input = JSON.parse(body.querySelector("#ftIn").value || "null"); } catch { return K.toast(`${t("forge_bad_json")} ${t("forge_input")}`, true); }
      const out = body.querySelector("#ftOut");
      try { const r = await K.apiSoft(`/api/forge/tools/${encodeURIComponent(x.name)}/run`, { method: "POST", body: { input } }); out.hidden = false; out.className = "ft-out " + (r.ok === false || r.error ? "bad" : "ok"); out.innerHTML = K.pretty(r); snd(r.ok === false || r.error ? "failed" : "done"); }
      catch (e) { out.hidden = false; out.className = "ft-out bad"; out.textContent = (e.data && JSON.stringify(e.data, null, 2)) || e.message; snd("failed"); if (e instanceof K.AuthError) K.renderLogin(); }
    });
    const ret = body.querySelector("#ftRetire");
    if (ret) ret.onclick = async () => {
      if (!(await K.dialog({ title: t("forge_retire_t"), body: esc(t("forge_retire_b")), confirm: t("forge_retire"), danger: true }))) return;
      try { await K.apiSoft(`/api/forge/tools/${encodeURIComponent(x.name)}/retire`, { method: "POST", body: {} }); K.toast(t("forge_retired")); K.closeDrawer(); renderForge(); } catch (e) { K.actErr(e); }
    };
  }
  function sampleInput(s) {
    if (!s || typeof s !== "object") return {};
    if (s.type === "object" || s.properties) { const o = {}; for (const [k, v] of Object.entries(s.properties || {})) o[k] = sampleInput(v); return o; }
    return s.type === "string" ? "" : s.type === "number" || s.type === "integer" ? 0 : s.type === "boolean" ? false : s.type === "array" ? [] : null;
  }
  function openSubmit() {
    const { t, esc } = K;
    const body = K.openDrawer(`
      <div class="dr-head"><span class="tool-ico big" aria-hidden="true">⚒</span><h2>${t("forge_submit")}</h2></div>
      <form id="fsForm" class="fs-form">
        <label>${t("forge_f_name")}<input id="fsName" dir="ltr" required pattern="^forge(\\.[a-z][a-z0-9_]{0,30}){1,4}$" placeholder="forge.text.slugify"/></label>
        <label>${t("forge_f_desc")}<input id="fsDesc" dir="auto" required/></label>
        <label>${t("forge_f_schema")}<textarea id="fsSchema" class="code-in" dir="ltr" rows="4" spellcheck="false">{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}</textarea></label>
        <label>${t("forge_f_code")}<textarea id="fsCode" class="code-in" dir="ltr" rows="7" spellcheck="false">function run(input) {\n  return String(input.text).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n}</textarea></label>
        <label>${t("forge_f_tests")}<textarea id="fsTests" class="code-in" dir="ltr" rows="4" spellcheck="false">[{"input":{"text":"Hello World"},"expect":"hello-world"}]</textarea></label>
        <button class="btn primary" id="fsGo">${t("forge_submit")}</button>
      </form>
      <div id="fsPipe" style="margin-top:16px"></div>`, t("forge_submit"));
    body.querySelector("#fsForm").onsubmit = async (e) => {
      e.preventDefault();
      const P = (id, label) => { try { return JSON.parse(body.querySelector(id).value); } catch { throw new Error(`${t("forge_bad_json")} ${label}`); } };
      let spec;
      try { spec = { name: body.querySelector("#fsName").value.trim(), description: body.querySelector("#fsDesc").value.trim(), input_schema: P("#fsSchema", t("forge_f_schema")), code: body.querySelector("#fsCode").value, tests: P("#fsTests", t("forge_f_tests")), author: "owner" }; }
      catch (ex) { return K.toast(ex.message, true); }
      const pipe = body.querySelector("#fsPipe");
      pipe.innerHTML = `<div class="faint">${t("forge_submitting")}</div>${gatePipe([], { live: true })}`;
      const btn = body.querySelector("#fsGo");
      const finish = (res) => {
        if (res && res.duplicate) { if (pipe.isConnected) pipe.innerHTML = `<div class="warnbox" dir="auto">${esc(t("forge_duplicate"))} · ${esc((res.tool && res.tool.status) || "")}</div>${gatePipe((res.tool && res.tool.gates) || [])}`; return; }
        const rep = (res && (res.report || (res.tool && res.tool.report))) || res || {};
        const ok = (rep.status || res.status) === "admitted";
        if (pipe.isConnected) pipe.innerHTML = `<div class="${ok ? "okbox" : "warnbox"}" dir="auto">${ok ? t("forge_admitted") : t("forge_rejected_t")}${rep.reason ? " · " + esc(rep.reason) : ""}</div>${gatePipe(rep.gates || [])}`;
        snd(ok ? "tool" : "rejection");
        if (ok && window.KFX) KFX.burst(pipe.querySelector(".fg:last-child"), "76,195,138");
        if ((location.hash || "").startsWith("#/forge")) setTimeout(renderForge, 600);
      };
      await K.busy(btn, async () => {
        try {
          const job = await K.startJob("/api/forge/submit", spec, (j) => { if (j.status === "done") finish(j.result || {}); else if (pipe.isConnected) { pipe.innerHTML = `<div class="warnbox mono" dir="auto">${esc(j.error || j.status)}</div>`; snd("failed"); } });
          if (!job) return;
        } catch (ex) { pipe.innerHTML = ""; K.actErr(ex); }
      });
    };
  }

  // ======================================================================
  // Discovery Lab
  // ======================================================================
  const REC_ST = ["verified", "beats_known_needs_review", "rejected", "candidate"];
  const recBadge = (s) => `<span class="rbadge ${K.esc(s)}">${K.esc(K.tOr("rst_" + s, s))}</span>`;
  const ptitle = (p) => (K.state.lang === "ar" ? p.title_ar || p.title_en : p.title_en || p.title_ar) || p.id;
  const pbest = (p) => p.best_score ?? (p.best && p.best.score) ?? (p.best_record && p.best_record.score) ?? null;
  const pknown = (p) => p.best_known_score ?? (p.best_known && p.best_known.score) ?? null;
  const pkstat = (p) => p.best_known_status ?? (p.best_known && p.best_known.status) ?? null;
  const fmtS = (v) => (v == null || !isFinite(v) ? "—" : K.nf(Math.round(Number(v) * 1e4) / 1e4));

  function recordsBoard(recs, probs) {
    const { t, esc, nf } = K;
    const title = new Map((probs || []).map((p) => [p.id, ptitle(p)]));
    return `<div class="rboard">${REC_ST.slice(0, 3).concat(recs.some((r) => r.status === "candidate") ? ["candidate"] : []).map((s) => {
      const rows = recs.filter((r) => r.status === s);
      return `<section class="rcol ${s}"><header>${recBadge(s)}<span class="num faint">${nf(rows.length)}</span></header>${rows.slice(0, 20).map((r) => `<a class="rcard" href="#/discovery/${encodeURIComponent(r.problem_id)}"><div class="row"><b class="num">${fmtS(r.score)}</b><span class="spacer"></span>${r.vs_known ? `<span class="vs ${esc(r.vs_known)}">${esc(K.tOr("vs_" + r.vs_known, r.vs_known))}</span>` : ""}</div><div class="faint" dir="auto">${esc(title.get(r.problem_id) || (K.state.lang === "ar" ? r.title_ar : r.title_en) || r.problem_id)}</div><div class="faint num">${nf(r.verified_count || 0)}/2 ${t("disc_verif")} · ${esc(K.ago(r.updated_at || r.created_at))}</div></a>`).join("") || `<div class="kempty">—</div>`}</section>`;
    }).join("")}</div><div class="disclaimer">${esc(t("disc_disclaimer"))}</div>`;
  }
  async function renderDiscovery(id) {
    leave();
    if (id) return renderProblem(id);
    const { t, esc, nf } = K;
    K.shell("discovery", t("nav_discovery"), t("disc_sub"), `<div class="probs">${'<div class="skeleton" style="height:180px"></div>'.repeat(6)}</div>`);
    K.topActions().innerHTML = `<button class="btn sm" id="revAll">↻ ${t("disc_reverify_all")}</button>`;
    document.getElementById("revAll").onclick = (e) => reverify(e.currentTarget, null);
    const [pr, rr] = await Promise.allSettled([K.apiSoft("/api/discovery/problems"), K.apiSoft("/api/discovery/records?limit=60")]);
    for (const r of [pr, rr]) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason;
    if (pr.status === "rejected") { K.content().innerHTML = K.failCard(pr.reason, "discovery"); K.bindRetry(K.content(), () => renderDiscovery()); return; }
    const probs = pr.value.problems || [];
    let recs = rr.status === "fulfilled" ? rr.value.records || [] : probs.flatMap((p) => (Array.isArray(p.records) ? p.records : []));
    K.content().innerHTML = `
      ${probs.length ? `<div class="probs">${probs.map((p, i) => {
        const best = pbest(p), known = pknown(p);
        const pct = best != null && known ? Math.max(0, Math.min(1, p.direction === "min" ? known / best : best / known)) : null;
        return `<article class="card prob" data-id="${esc(p.id)}" style="--i:${i}">
          <div class="row"><span class="fam">${esc(p.family || "")}</span><span class="spacer"></span><span class="dir" title="${esc(t(p.direction === "min" ? "dc_min" : "dc_max"))}">${p.direction === "min" ? "↓" : "↑"}</span>${p.status && p.status !== "active" ? K.badge(p.status === "paused" ? "pending" : "rejected", p.status) : ""}</div>
          <h3 dir="auto">${esc(ptitle(p))}</h3>
          <div class="prob-nums"><div><div class="faint">${t("disc_best")}</div><b class="num big">${fmtS(best)}</b></div><div><div class="faint">${t("dc_best_known")}</div><b class="num">${fmtS(known)}</b>${pkstat(p) ? `<div class="faint bk">${esc(K.tOr("bk_" + pkstat(p), pkstat(p)))}</div>` : ""}</div></div>
          ${pct != null ? `<div class="prog"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>` : ""}
          <div class="faint num prob-foot">${t("disc_generation")} ${nf(p.generation || 0)} · ${t("disc_islands")} ${nf(p.islands || 0)}${p.records && p.records.total != null ? ` · ${nf(p.records.total)} ${t("disc_records_n")}` : p.records_count != null ? ` · ${nf(p.records_count)} ${t("disc_records_n")}` : ""}${p.job ? ` · <span class="run-dot"></span>${nf(p.job.done || 0)}/${nf(p.job.total || 0)}` : ""}</div>
        </article>`;
      }).join("")}</div>` : `<div class="card empty hive-empty">${K.HIVE_ART}<div class="t">${t("disc_no_problems")}</div></div>`}
      <section class="card" style="margin-top:16px"><h2>${t("disc_records")}</h2>${recs.length ? recordsBoard(recs, probs) : `<div class="empty">${t("disc_no_records")}</div><div class="disclaimer">${esc(t("disc_disclaimer"))}</div>`}</section>`;
    K.bindClick(K.content(), ".prob", (el) => (location.hash = "#/discovery/" + encodeURIComponent(el.dataset.id)));
  }
  function normHistory(d) {
    const h = d.history || d.score_history || d.best_history || d.generations || [];
    if (!Array.isArray(h)) return [];
    return h.map((x, i) => (typeof x === "number" ? { gen: i, best: x } : { gen: x.generation ?? x.gen ?? x.g ?? i, best: x.best ?? x.best_score ?? x.score ?? x.max })).filter((x) => x.best != null && isFinite(x.best)).map((x) => ({ gen: x.gen, best: Number(x.best) }));
  }
  function normElites(d, p) {
    const out = [];
    const isl = Array.isArray(d.islands) ? d.islands : [];
    isl.forEach((it, i) => (it.elites || it.cells || []).forEach((e) => out.push({ ...e, island: e.island ?? it.island ?? it.id ?? i })));
    (d.elites || []).forEach((e) => out.push(e));
    const cellIdx = (c) => { if (c == null) return 0; if (typeof c === "number") return c; const m = String(c).match(/(\d+)(?!.*\d)/); return m ? Number(m[1]) : 0; };
    const nIsl = Math.max(Number(p.islands) || 0, isl.length, ...out.map((e) => Number(e.island) + 1 || 1), out.length ? 1 : 0);
    const zb = (d.heatmap_axes && d.heatmap_axes.z_buckets) || 4, xb = (d.heatmap_axes && d.heatmap_axes.x_buckets) || 5;
    const structured = out.some((e) => e.length_bucket != null || e.behaviour != null);
    const idx = (e) => (structured ? (Number(e.length_bucket) || 0) * zb + (Number(e.behaviour) || 0) : cellIdx(e.cell ?? e.bucket ?? e.niche));
    return { cols: structured ? xb * zb : null, cells: out.filter((e) => e.valid !== false).map((e) => ({ island: Number(e.island) || 0, cell: idx(e), score: e.score == null ? null : Number(e.score), id: e.program_id || e.id, gen: e.generation, op: e.operator })), islands: nIsl };
  }
  function heatmap(el, dir) {
    const { t, esc } = K;
    if (!el.cells.length) return `<div class="empty">${t("disc_no_elites")}</div>`;
    const cols = Math.max(el.cols || 8, ...el.cells.map((c) => c.cell + 1)), rows = Math.max(1, el.islands);
    const sc = el.cells.filter((c) => c.score != null && isFinite(c.score)).map((c) => c.score);
    const lo = Math.min(...sc), hi = Math.max(...sc);
    const norm = (v) => (v == null || !isFinite(v) ? 0 : hi === lo ? 1 : dir === "min" ? (hi - v) / (hi - lo) : (v - lo) / (hi - lo));
    const R = 15, w = R * Math.sqrt(3), h = R * 1.5, W = cols * w + w / 2 + 8, H = rows * h + R + 8;
    const map = new Map(el.cells.map((c) => [c.island + ":" + c.cell, c]));
    let s = "";
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = 4 + w / 2 + c * w + (r & 1 ? w / 2 : 0), y = 4 + R + r * h, e = map.get(r + ":" + c);
      const pts = [0, 1, 2, 3, 4, 5].map((k) => { const a = Math.PI / 6 + (k * Math.PI) / 3; return `${(x + (R - 1.5) * Math.cos(a)).toFixed(1)},${(y + (R - 1.5) * Math.sin(a)).toFixed(1)}`; }).join(" ");
      if (e) { const n = norm(e.score); s += `<polygon class="hm on ${n > 0.92 ? "top" : ""}" points="${pts}" style="--n:${n.toFixed(3)};--d:${((r * cols + c) * 18) % 900}ms"><title>${esc(t("disc_islands"))} ${r} · cell ${c} · ${fmtS(e.score)}${e.gen != null ? ` · ${t("disc_generation")} ${e.gen}` : ""}${e.op ? ` · ${e.op}` : ""}</title></polygon>`; }
      else s += `<polygon class="hm" points="${pts}"/>`;
    }
    const labels = Array.from({ length: rows }, (_, r) => `<text x="-18" y="${4 + R + r * h + 4}" class="hm-l">${r}</text>`).join("");
    return `<div class="hm-wrap"><svg viewBox="-24 0 ${W + 24} ${H}" class="heat" role="img" aria-label="${esc(t("disc_heatmap"))}">${labels}${s}</svg><div class="hm-scale"><span>${fmtS(dir === "min" ? hi : lo)}</span><i></i><span>${fmtS(dir === "min" ? lo : hi)}</span></div></div>`;
  }
  function historyChart(hist, known, dir) {
    const { t } = K;
    if (hist.length < 2) return `<div class="empty">${t("dc_no_history")}</div>`;
    const W = 640, H = 220, L = 46, R = 10, T = 14, B = 26;
    const vals = hist.map((x) => x.best).concat(known != null && isFinite(known) ? [known] : []);
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = (hi - lo || 1) * 0.1;
    const X = (i) => L + (i / (hist.length - 1)) * (W - L - R), Y = (v) => T + (1 - (v - lo + pad) / (hi - lo + 2 * pad)) * (H - T - B);
    const pts = hist.map((x, i) => `${X(i).toFixed(1)},${Y(x.best).toFixed(1)}`).join(" ");
    let best = null; const marks = [];
    hist.forEach((x, i) => { if (best == null || (dir === "min" ? x.best < best : x.best > best)) { if (best != null) marks.push(`<polygon class="hmk" points="${[0, 1, 2, 3, 4, 5].map((k) => { const a = Math.PI / 6 + (k * Math.PI) / 3; return `${(X(i) + 5 * Math.cos(a)).toFixed(1)},${(Y(x.best) + 5 * Math.sin(a)).toFixed(1)}`; }).join(" ")}" style="--d:${(i / hist.length) * 1.4}s"><title>${t("disc_generation")} ${x.gen}: ${fmtS(x.best)}</title></polygon>`); best = x.best; } });
    const grid = [0, 0.5, 1].map((f) => { const v = lo - pad + (hi - lo + 2 * pad) * f, y = Y(v); return `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" class="hg"/><text x="${L - 6}" y="${y + 4}" class="hl" text-anchor="end">${fmtS(v)}</text>`; }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="hist" role="img" aria-label="${K.esc(t("disc_history"))}">${grid}
      ${known != null && isFinite(known) ? `<line x1="${L}" x2="${W - R}" y1="${Y(known)}" y2="${Y(known)}" class="hk"/><text x="${W - R}" y="${Y(known) - 5}" class="hkl" text-anchor="end">${K.esc(t("dc_best_known"))} ${fmtS(known)}</text>` : ""}
      <polygon class="harea" points="${L},${H - B} ${pts} ${X(hist.length - 1)},${H - B}"/><polyline class="hline" points="${pts}" pathLength="1"/>${marks.join("")}
      <text x="${L}" y="${H - 6}" class="hl">${hist[0].gen}</text><text x="${W - R}" y="${H - 6}" class="hl" text-anchor="end">${hist[hist.length - 1].gen}</text></svg>`;
  }
  async function renderProblem(id) {
    const { t, esc, nf } = K;
    K.shell("discovery", t("nav_discovery"), `<a href="#/discovery">← ${t("back")}</a>`, `<div class="skeleton" style="height:120px"></div><div class="grid g2" style="margin-top:16px"><div class="skeleton" style="height:260px"></div><div class="skeleton" style="height:260px"></div></div>`);
    let d;
    try { d = await K.apiSoft(`/api/discovery/problems/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof K.AuthError) throw e; K.content().innerHTML = K.failCard(e, "discovery"); K.bindRetry(K.content(), () => renderProblem(id)); return; }
    const p = d.problem || d, hist = normHistory(d.history || d.score_history ? d : p), el = normElites(d, p), recs = d.records || p.records || [];
    const best = pbest(p) ?? (hist.length ? hist.reduce((b, x) => (b == null || (p.direction === "min" ? x.best < b : x.best > b) ? x.best : b), null) : null);
    const known = pknown(p), stat = pkstat(p), src = p.best_known_source ?? (p.best_known && p.best_known.source);
    document.querySelector(".topbar h1").textContent = ptitle(p);
    K.topActions().innerHTML = `<label class="sr" for="gens">${t("disc_gens")}</label><input id="gens" type="number" min="1" max="50" value="5" class="num-in" aria-label="${esc(t("disc_gens"))}"/><button class="btn sm primary" id="evolveBtn">⟳ ${t("disc_evolve")}</button><button class="btn sm" id="revBtn">↻ ${t("disc_reverify")}</button><button class="btn sm" id="replayBtn">▶ ${t("disc_replay")}</button>`;
    K.content().innerHTML = `
      <section class="card prob-hero"><div class="ph-main"><div class="row"><span class="fam">${esc(p.family || "")}</span><span class="dir">${p.direction === "min" ? "↓ " + t("dc_min") : "↑ " + t("dc_max")}</span><span class="faint num">${t("disc_generation")} ${nf(p.generation || 0)} · ${t("disc_islands")} ${nf(el.islands || p.islands || 0)}</span></div>
        <div class="muted ph-st" dir="auto">${esc((K.state.lang === "ar" ? p.statement_ar || p.statement_en : p.statement_en || p.statement_ar) || "")}</div></div>
        <div class="ph-nums"><div><div class="faint">${t("disc_best")}</div><b class="num huge" data-count>${fmtS(best)}</b></div><div><div class="faint">${t("dc_best_known")}</div><b class="num big">${fmtS(known)}</b>${stat ? `<div class="faint bk">${esc(K.tOr("bk_" + stat, stat))}</div>` : ""}</div></div>
        ${src ? `<div class="faint ph-src" dir="auto">${t("disc_source")}: ${esc(src)}</div>` : ""}</section>
      <div class="grid g2" style="margin-top:16px;align-items:start">
        <section class="card"><h2>${t("disc_heatmap")} <span class="hint">${t("disc_heat_hint")}</span></h2>${heatmap(el, p.direction)}</section>
        <section class="card"><h2>${t("disc_history")}</h2>${historyChart(hist, known, p.direction)}</section>
      </div>
      <section class="card" style="margin-top:16px"><h2>${t("disc_records")}</h2>${recs.length ? `<div class="tbl-wrap"><table class="table"><thead><tr><th>${t("dc_best")}</th><th>${t("col_status")}</th><th>${t("disc_vs")}</th><th>${t("disc_verif")}</th><th>${t("disc_repro")}</th><th>${t("col_when")}</th></tr></thead><tbody>${recs.map((r) => `<tr><td class="num"><b>${fmtS(r.score)}</b></td><td>${recBadge(r.status)}${r.status_reason ? `<div class="faint" dir="auto">${esc(r.status_reason)}</div>` : ""}</td><td>${r.vs_known ? `<span class="vs ${esc(r.vs_known)}">${esc(K.tOr("vs_" + r.vs_known, r.vs_known))}</span>` : "—"}</td><td class="num">${nf(r.verified_count || 0)}/2</td><td>${r.reproducible == null ? "—" : r.reproducible ? "✓" : "✕"}</td><td class="faint">${esc(K.ago(r.updated_at || r.created_at))}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">${t("disc_no_records")}</div>`}<div class="disclaimer">${esc(t("disc_disclaimer"))}</div></section>`;
    if (window.KFX) KFX.countUp(K.content());
    document.getElementById("replayBtn").onclick = () => {
      let h = hist, demo = false;
      if (h.length < 2) { demo = true; let b = known ? known * 0.6 : 10; h = Array.from({ length: 40 }, (_, i) => ({ gen: i, best: (b = b + (Math.random() < 0.3 ? Math.random() * (known ? known * 0.03 : 1) : 0)) })); }
      KVID.player(KVID.discoveryScene({ title: ptitle(p), direction: p.direction, history: h, best_known: known, best_known_label: stat ? K.tOr("bk_" + stat, stat) : "", demo }));
    };
    document.getElementById("evolveBtn").onclick = (e) => K.busy(e.currentTarget, async () => {
      const generations = Math.max(1, Math.min(50, Number(document.getElementById("gens").value) || 5));
      const before = best;
      try {
        await K.startJob(`/api/discovery/problems/${encodeURIComponent(id)}/evolve`, { generations }, (j) => {
          const res = j.result || {};
          const nb = typeof res.best === "object" && res.best ? res.best.score : res.best;
          const sb = typeof res.start_best === "object" && res.start_best ? res.start_best.score : res.start_best ?? before;
          const improved = nb != null && (sb == null || (p.direction === "min" ? nb < sb : nb > sb));
          // a fresh best is only a *candidate* until re-verified twice: acknowledge, never celebrate
          if (j.status === "done" && improved && window.KFX) { snd("promotion"); KFX.bg.surge(); KFX.toast(`${K.t("disc_new_candidate")} ${fmtS(nb)}`, { kind: "info", sound: false }); }
          if ((location.hash || "").startsWith("#/discovery/" + encodeURIComponent(id))) renderProblem(id);
        });
      } catch (ex) { K.actErr(ex); }
    });
    document.getElementById("revBtn").onclick = (e) => reverify(e.currentTarget, id);
  }
  async function reverify(btn, id) {
    await K.busy(btn, async () => {
      try {
        await K.startJob("/api/discovery/reverify", id ? { problem_id: id } : {}, (j) => {
          const r = j.result || {}, n = (r.counts && r.counts.verified) || 0;
          if (j.status === "done" && n > 0) { snd("record"); if (window.KFX) { KFX.confetti(); KFX.toast(`${K.t("disc_new_record")} (${K.nf(n)})`, { kind: "record", sound: false }); } }
          if ((location.hash || "").startsWith("#/discovery")) id ? renderProblem(id) : renderDiscovery();
        });
      } catch (e) { K.actErr(e); }
    });
  }

  // ======================================================================
  // Command palette + shortcuts
  // ======================================================================
  const GO = { o: "overview", h: "hive", a: "agents", e: "evolution", v: "evals", f: "forge", d: "discovery", r: "runs", p: "approvals", k: "kill", l: "audit", s: "settings" };
  function commands() {
    const t = K.t;
    const nav = K.NAV.map(([k, label]) => ({ id: "go:" + k, label: t(label), hint: `g ${Object.keys(GO).find((x) => GO[x] === k) || ""}`, icon: K.I[k] || "", run: () => (location.hash = "#/" + k) }));
    return nav.concat([
      { id: "replay", label: t("hive_replay"), icon: "▶", run: () => openHiveReplay() },
      { id: "forge-submit", label: t("forge_submit"), icon: "⚒", run: () => { location.hash = "#/forge"; setTimeout(openSubmit, 300); } },
      { id: "lang", label: t("pal_lang"), hint: "L", icon: "🌐", run: () => K.toggleLang() },
      { id: "mute", label: t("pal_mute"), hint: "M", icon: "🔈", run: () => toggleMute() },
      { id: "sound", label: t("pal_sound"), icon: "🎚", run: () => KFX.soundPanel(document.getElementById("sndBtn")) },
      { id: "intro", label: t("pal_intro"), icon: "✦", run: () => KVID.intro({ force: true }) },
      { id: "help", label: t("pal_help"), hint: "?", icon: "⌨", run: () => help() },
      { id: "reload", label: t("pal_reload"), icon: "↻", run: () => K.route() },
    ]).concat((window.KEXT.extraCommands || []).flatMap((f) => { try { return f() || []; } catch { return []; } }));
  }
  function toggleMute() { const m = KFX.sound.toggleMute(); KFX.toast(m ? "🔇 " + K.t("snd_mute") : "🔊 " + K.t("snd_title"), { kind: "info", sound: false }); }
  function palette() {
    if (document.querySelector(".pal-wrap")) return;
    const prev = document.activeElement, all = commands();
    const wrap = document.createElement("div"); wrap.className = "pal-wrap";
    wrap.innerHTML = `<div class="pal" role="dialog" aria-modal="true" aria-label="${K.esc(K.t("kb_palette"))}"><input class="pal-in" role="combobox" aria-expanded="true" aria-controls="palList" aria-autocomplete="list" placeholder="${K.esc(K.t("pal_ph"))}"/><ul class="pal-list" id="palList" role="listbox"></ul><div class="pal-foot faint"><kbd>↑↓</kbd> <kbd>Enter</kbd> <kbd>Esc</kbd></div></div>`;
    document.body.appendChild(wrap); requestAnimationFrame(() => wrap.classList.add("open"));
    snd("open");
    const inp = wrap.querySelector("input"), ul = wrap.querySelector("ul");
    let sel = 0, items = all;
    const norm = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[\u064B-\u065F]/g, "");
    const paint = () => {
      const q = norm(inp.value.trim());
      items = !q ? all : all.filter((c) => norm(c.label + " " + c.id).includes(q) || q.split(/\s+/).every((w) => norm(c.label + " " + c.id).includes(w)));
      sel = Math.min(sel, Math.max(0, items.length - 1));
      ul.innerHTML = items.length ? items.map((c, i) => `<li role="option" id="pal${i}" aria-selected="${i === sel}" class="${i === sel ? "on" : ""}" data-i="${i}"><span class="pal-ic">${c.icon}</span><span>${K.esc(c.label)}</span>${c.hint ? `<kbd>${K.esc(c.hint)}</kbd>` : ""}</li>`).join("") : `<li class="pal-none">${K.esc(K.t("pal_none"))}</li>`;
      inp.setAttribute("aria-activedescendant", items.length ? "pal" + sel : "");
      const on = ul.querySelector(".on"); if (on) on.scrollIntoView({ block: "nearest" });
    };
    const close = () => { wrap.remove(); document.removeEventListener("keydown", key, true); if (prev && prev.focus && prev.isConnected) prev.focus(); };
    const go = (i) => { const c = items[i]; if (!c) return; close(); c.run(); };
    const key = (e) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); sel = (sel + 1) % Math.max(1, items.length); paint(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = (sel - 1 + items.length) % Math.max(1, items.length); paint(); }
      else if (e.key === "Enter") { e.preventDefault(); go(sel); }
    };
    document.addEventListener("keydown", key, true);
    inp.oninput = () => { sel = 0; paint(); };
    ul.onclick = (e) => { const li = e.target.closest("[data-i]"); if (li) go(Number(li.dataset.i)); };
    ul.onmousemove = (e) => { const li = e.target.closest("[data-i]"); if (li && Number(li.dataset.i) !== sel) { sel = Number(li.dataset.i); paint(); } };
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    paint(); inp.focus();
  }
  function help() {
    const t = K.t;
    const row = (keys, label) => `<div class="kb-row"><span>${label}</span><span>${keys}</span></div>`;
    K.dialog({
      title: t("kb_title"),
      body: `<div class="kb">${row("<kbd>Ctrl</kbd>/<kbd>⌘</kbd> + <kbd>K</kbd>", t("kb_palette"))}${row("<kbd>?</kbd>", t("kb_help"))}${row("<kbd>M</kbd>", t("kb_mute"))}${row("<kbd>L</kbd>", t("kb_lang"))}${row("<kbd>Esc</kbd>", t("kb_esc"))}
        <div class="kb-sep">${t("kb_go")}</div>${Object.entries(GO).map(([k, p]) => row(`<kbd>G</kbd> ${t("kb_then")} <kbd>${k.toUpperCase()}</kbd>`, t("nav_" + p))).join("")}</div>`,
      confirm: t("close"),
    });
  }
  let gPending = 0;
  function onKey(e) {
    const tag = (e.target && e.target.tagName) || "";
    const typing = /INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable);
    if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) { e.preventDefault(); palette(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector(".modal-wrap,.pal-wrap,.theater-wrap,.intro")) return;
    if (!document.querySelector(".shell")) return;
    if (gPending && GO[e.key.toLowerCase()]) { e.preventDefault(); gPending = 0; location.hash = "#/" + GO[e.key.toLowerCase()]; return; }
    gPending = 0;
    if (e.key === "?") { e.preventDefault(); help(); }
    else if (e.key === "g" || e.key === "G") { gPending = 1; setTimeout(() => (gPending = 0), 1200); }
    else if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "l" || e.key === "L") K.toggleLang();
  }

  window.KEXT = {
    pages: { hive: renderHive, forge: renderForge, discovery: renderDiscovery },
    go: GO, extraCommands: [],
    leave, openHiveReplay, cueFor,
    init(k) { K = k; document.addEventListener("keydown", onKey); },
  };
})();
