// Khaliya console — P8 Red-Team Arena (#/redteam), P5 Org Memory / KB (#/memory), Judge Court (#/court).
// Classic script loaded after ext.js and before app.js. It plugs into window.KEXT (pages, leave, init, commands),
// so app.js's router, nav, job dock and the command palette pick these pages up with no other wiring.
(() => {
  "use strict";
  if (!window.KEXT) return;
  let K;
  Object.assign(window.I18N.ar, {
    nav_redteam: "ساحة الهجوم", nav_memory: "ذاكرة المنظمة", nav_court: "محكمة الحكّام",
    job_redteam: "حملة هجوم", job_compact: "ضغط الذاكرة", job_probe: "فحص الحكّام",
    nr_body_redteam: "واجهة ساحة الهجوم غير متاحة على الخادم بعد.", nr_body_memory: "واجهة ذاكرة المنظمة غير متاحة على الخادم بعد.", nr_body_court: "واجهة محكمة الحكّام غير متاحة على الخادم بعد.",
    // red-team
    rt_sub: "هجمات عدائية مضبوطة ضد الوكلاء — ما ينجح منها يصبح اختبار تراجع دائم", rt_launch: "أطلق حملة", rt_library: "مكتبة الهجمات",
    rt_attacks: "الهجمات النشطة", rt_of_total: "من أصل", rt_pass: "نسبة الصمود", rt_breaches: "اختراقات مؤكدة", rt_suspected: "مشتبه", rt_rejected_n: "مرفوض", rt_regressions: "اختبارات التراجع",
    rt_last_probe: "آخر فحص", rt_never: "لم يُفحص بعد", rt_radar: "الصمود حسب الفئة", rt_radar_hint: "نسبة الهجمات التي صمد أمامها الوكلاء", rt_no_rates: "لا نتائج فحص بعد. أطلق حملة لرسم الخريطة.",
    rt_agents: "الوكلاء", rt_runs: "محاولات", rt_overall: "الإجمالي", rt_no_agents: "لم يُختبر أي وكيل بعد.", rt_breach_list: "الاختراقات", rt_no_breaches: "لا اختراقات. الخلية صامدة حتى الآن.",
    rt_st_suspected: "مشتبه", rt_st_confirmed: "مؤكد", rt_st_rejected: "مرفوض", rt_contained: "احتوته البوابة", rt_uncontained: "غير محتوى", rt_soft: "ناقد فقط", rt_sev: "الخطورة",
    rt_sev_hi: "عالية", rt_sev_med: "متوسطة", rt_sev_lo: "منخفضة", rt_repro: "إعادة الإنتاج", rt_control: "تشغيل المقارنة", rt_control_clean: "نظيف", rt_control_dirty: "اخترق أيضاً", rt_evidence: "الدليل", rt_final: "الإجابة النهائية", rt_actions: "الأفعال", rt_critic: "الناقد", rt_detectors: "الكواشف",
    rt_regression: "اختبار تراجع", rt_attackers: "المهاجمون", rt_campaigns: "آخر الحملات", rt_no_campaigns: "لا حملات بعد.", rt_generated: "مولّدة", rt_score: "النقاط",
    rt_f_max: "أقصى عدد للهجمات", rt_f_cats: "الفئات (فارغ = الكل)", rt_f_langs: "اللغات (فارغ = الكل)", rt_f_critic: "الناقد", rt_f_gen: "هجمات جديدة يولّدها المهاجم", rt_f_calls: "حد استدعاءات النموذج",
    rt_critic_auto: "تلقائي", rt_critic_always: "دائماً", rt_critic_off: "معطّل", rt_launched: "انطلقت الحملة", rt_done_clean: "انتهت الحملة — لا اختراقات مؤكدة", rt_done_breach: "اختراقات مؤكدة جديدة",
    rt_err_no_targets: "لا وكلاء أبطال لاختبارهم بعد.", rt_err_no_attacks: "لا هجمات نشطة تطابق المرشحات.", rt_err_busy: "حملة أخرى قيد التشغيل.",
    rt_lib_sub: "كل الهجمات بمواصفاتها الكاملة (عرض المالك فقط)", rt_vector: "الناقل", rt_difficulty: "الصعوبة", rt_source: "المصدر", rt_lang: "اللغة", rt_category: "الفئة", rt_spec: "المواصفة", rt_no_attacks: "لا هجمات تطابق المرشحات.",
    rt_src_seed: "بذرة", rt_src_owner: "المالك", rt_src_attacker: "مهاجم", ast_active: "نشطة", ast_candidate: "مرشحة", ast_rejected: "مرفوضة", ast_retired: "متقاعدة",
    rt_c_prompt_injection: "حقن التعليمات", rt_c_tool_poisoning: "تسميم الأدوات", rt_c_budget_evasion: "التحايل على الميزانية", rt_c_approval_bypass: "تجاوز الموافقة", rt_c_eval_gaming: "التلاعب بالتقييم", rt_c_data_exfiltration: "تسريب البيانات", rt_c_constitution_violation: "مخالفة الدستور",
    // memory
    km_sub: "معرفة مشتركة موثوقة، يراجعها الناقد والمالك قبل أن يعتمد عليها الوكلاء", km_new: "مستند جديد", km_compact: "اضغط الذاكرة", km_compacted: "اكتمل ضغط الذاكرة",
    km_trusted: "موثوق", km_pending: "قيد المراجعة", km_untrusted: "غير موثوق", km_rejected: "مرفوض", km_episodic: "ذاكرة الحلقات", km_vectors: "البحث المتجهي", km_on: "مفعّل", km_off: "كلمات فقط",
    km_search: "ابحث في الذاكرة", km_go: "ابحث", km_search_ph: "اكتب سؤالاً أو كلمات…", km_trusted_only: "الموثوق فقط", km_mode: "النمط", mode_keyword: "كلمات مفتاحية", mode_vector: "متجهي", mode_hybrid: "هجين", km_no_hits: "لا نتائج.",
    km_docs: "المستندات", km_no_docs: "لا مستندات تطابق المرشحات.", km_scope: "النطاق", km_scope_all: "كل النطاقات", km_scope_org: "المنظمة", km_kind: "النوع", km_status: "الحالة", km_flags: "تنبيهات", km_conf: "الثقة", km_uses: "استخدامات", km_author: "الكاتب", km_verified: "موثّق",
    kk_doc: "مستند", kk_episode: "حلقة", kk_lesson: "درس", kk_summary: "ملخّص", kk_playbook: "دليل عمل", kms_active: "نشط", kms_archived: "مؤرشف", kms_expired: "منتهي", kms_merged: "مدموج",
    km_reviews: "المراجعات", km_no_reviews: "لا مراجعات بعد.", km_approve: "اعتماد", km_reject: "رفض", km_mark_untrusted: "غير موثوق", km_ask_critic: "اسأل الناقد", km_archive: "أرشفة", km_restore: "استعادة",
    km_notes: "ملاحظة (اختياري)", km_reviewed: "سُجّلت المراجعة", km_critic_said: "حكم الناقد", km_archived_t: "أُرشف المستند", km_restored_t: "استُعيد المستند", km_tags: "وسوم", km_expires: "ينتهي", km_dup: "نسخة من",
    km_f_title: "العنوان", km_f_body: "النص", km_f_tags: "وسوم (مفصولة بفواصل)", km_f_trust: "الثقة", km_f_trust_def: "افتراضي الخادم", km_f_ttl: "مدة البقاء (أيام، فارغ = افتراضي)", km_f_conf: "الثقة (0–1)", km_saved: "حُفظ المستند", km_dup_t: "مستند مكرر — لم يُنشأ جديد", km_merged_t: "دُمج مع مستند قائم",
    km_lessons: "الدروس المستفادة", km_lessons_all: "كل الأدوار", km_no_lessons: "لا دروس موثوقة بعد.", km_body_req: "النص مطلوب",
    // court
    ct_sub: "الحكّام يُحاكَمون أيضاً: ثبات الموضع، التحيّز للذات، الإطالة، واتساق العربية والإنجليزية", ct_probe: "افحص الحكّام", ct_probed: "اكتمل فحص الحكّام",
    ct_judges: "الحكّام", ct_in_panel: "في اللجنة", ct_benched: "موقوف", ct_certified: "معتمد", ct_open: "فحوص يدوية مفتوحة", ct_no_judges: "لا حكّام بعد.", ct_unmeasured: "لم يُقَس بعد",
    ct_rel: "الموثوقية", ct_weight: "الوزن", ct_pos: "ثبات الموضع", ct_self: "التحيّز للذات", ct_lang: "اتساق اللغتين", ct_verb: "تحيّز الإطالة", ct_gold: "دقة الذهب", ct_kappa: "كابا", ct_probes: "فحوص", ct_hist: "١٤ يوماً", ct_target: "الهدف",
    ct_kappa_h: "اتفاق الحكّام مع المالك (كابا كوهين)", ct_no_kappa: "لا تسميات بعد. صنّف بعض الفحوص اليدوية أدناه.", ct_labels: "تسميات",
    ct_spot: "التحكيم اليدوي", ct_spot_hint: "أنت الحَكَم: أي الإجابتين أفضل؟ أحكام الحكّام مخفية حتى تختار", ct_task: "المهمة", ct_criteria: "المعايير", ct_answer: "الإجابة", ct_tie: "تعادل", ct_skip: "تخطَّ",
    ct_spot_empty: "لا فحوص يدوية مفتوحة. تُفتح تلقائياً عند اختلاف الحكّام.", ct_labelled: "سُجّل حكمك", ct_judges_said: "قال الحكّام", ct_remaining: "متبقٍّ",
    ct_weights: "الأوزان الحالية", ct_known: "مقاس", ct_stale: "قديم", ct_neutral: "محايد (١)", ct_no_weights: "لا أوزان بعد.",
    ct_f_judges: "الحكّام (فارغ = اللجنة كلها)", ct_f_kinds: "أنواع الفحص (فارغ = الكل)", ct_f_per: "فحوص لكل حَكَم", ct_f_calls: "حد الاستدعاءات",
    pk_position: "الموضع", pk_verbosity: "الإطالة", pk_gold: "الذهب", pk_lang: "اللغة", pk_self_pref: "التحيّز للذات",
    lab_launch: "ابدأ", lab_filters: "المرشحات", lab_all: "الكل", lab_any: "أي",
  });
  Object.assign(window.I18N.en, {
    nav_redteam: "Red-Team Arena", nav_memory: "Org Memory", nav_court: "Judge Court",
    job_redteam: "Red-team campaign", job_compact: "Memory compaction", job_probe: "Judge probe",
    nr_body_redteam: "The Red-Team API is not on the server yet.", nr_body_memory: "The Org Memory API is not on the server yet.", nr_body_court: "The Judge Court API is not on the server yet.",
    rt_sub: "Controlled adversarial attacks on the agents — every breach becomes a permanent regression test", rt_launch: "Launch campaign", rt_library: "Attack library",
    rt_attacks: "Active attacks", rt_of_total: "of", rt_pass: "Resistance", rt_breaches: "Confirmed breaches", rt_suspected: "suspected", rt_rejected_n: "rejected", rt_regressions: "Regression tests",
    rt_last_probe: "Last probe", rt_never: "never probed", rt_radar: "Resistance by category", rt_radar_hint: "share of attacks the agents withstood", rt_no_rates: "No probe results yet. Launch a campaign to draw the map.",
    rt_agents: "Agents", rt_runs: "runs", rt_overall: "Overall", rt_no_agents: "No agent has been probed yet.", rt_breach_list: "Breaches", rt_no_breaches: "No breaches. The hive is holding so far.",
    rt_st_suspected: "Suspected", rt_st_confirmed: "Confirmed", rt_st_rejected: "Rejected", rt_contained: "Contained by gateway", rt_uncontained: "Not contained", rt_soft: "critic-only", rt_sev: "Severity",
    rt_sev_hi: "high", rt_sev_med: "medium", rt_sev_lo: "low", rt_repro: "Reproduced", rt_control: "Control run", rt_control_clean: "clean", rt_control_dirty: "breached too", rt_evidence: "Evidence", rt_final: "Final answer", rt_actions: "Actions", rt_critic: "Critic", rt_detectors: "Detectors",
    rt_regression: "Regression test", rt_attackers: "Attackers", rt_campaigns: "Recent campaigns", rt_no_campaigns: "No campaigns yet.", rt_generated: "generated", rt_score: "score",
    rt_f_max: "Max attacks", rt_f_cats: "Categories (none = all)", rt_f_langs: "Languages (none = all)", rt_f_critic: "Critic", rt_f_gen: "New attacks to generate", rt_f_calls: "LLM call cap",
    rt_critic_auto: "Auto", rt_critic_always: "Always", rt_critic_off: "Off", rt_launched: "Campaign launched", rt_done_clean: "Campaign finished — no confirmed breaches", rt_done_breach: "New confirmed breaches",
    rt_err_no_targets: "No champion agents to probe yet.", rt_err_no_attacks: "No active attacks match these filters.", rt_err_busy: "Another campaign is running.",
    rt_lib_sub: "Every attack with its full spec (owner view only)", rt_vector: "Vector", rt_difficulty: "Difficulty", rt_source: "Source", rt_lang: "Language", rt_category: "Category", rt_spec: "Spec", rt_no_attacks: "No attacks match these filters.",
    rt_src_seed: "Seed", rt_src_owner: "Owner", rt_src_attacker: "Attacker", ast_active: "Active", ast_candidate: "Candidate", ast_rejected: "Rejected", ast_retired: "Retired",
    rt_c_prompt_injection: "Prompt injection", rt_c_tool_poisoning: "Tool poisoning", rt_c_budget_evasion: "Budget evasion", rt_c_approval_bypass: "Approval bypass", rt_c_eval_gaming: "Eval gaming", rt_c_data_exfiltration: "Data exfiltration", rt_c_constitution_violation: "Constitution",
    km_sub: "Shared, trusted knowledge — reviewed by the critic and the owner before agents rely on it", km_new: "New document", km_compact: "Compact memory", km_compacted: "Memory compaction finished",
    km_trusted: "Trusted", km_pending: "Pending", km_untrusted: "Untrusted", km_rejected: "Rejected", km_episodic: "Episodic", km_vectors: "Vector search", km_on: "on", km_off: "keyword only",
    km_search: "Search memory", km_go: "Search", km_search_ph: "Ask a question or type keywords…", km_trusted_only: "Trusted only", km_mode: "Mode", mode_keyword: "keyword", mode_vector: "vector", mode_hybrid: "hybrid", km_no_hits: "No results.",
    km_docs: "Documents", km_no_docs: "No documents match these filters.", km_scope: "Scope", km_scope_all: "All scopes", km_scope_org: "Org", km_kind: "Kind", km_status: "Status", km_flags: "Flags", km_conf: "Confidence", km_uses: "uses", km_author: "Author", km_verified: "verified",
    kk_doc: "Doc", kk_episode: "Episode", kk_lesson: "Lesson", kk_summary: "Summary", kk_playbook: "Playbook", kms_active: "Active", kms_archived: "Archived", kms_expired: "Expired", kms_merged: "Merged",
    km_reviews: "Reviews", km_no_reviews: "No reviews yet.", km_approve: "Approve", km_reject: "Reject", km_mark_untrusted: "Untrusted", km_ask_critic: "Ask critic", km_archive: "Archive", km_restore: "Restore",
    km_notes: "Note (optional)", km_reviewed: "Review recorded", km_critic_said: "Critic verdict", km_archived_t: "Document archived", km_restored_t: "Document restored", km_tags: "Tags", km_expires: "Expires", km_dup: "Duplicate of",
    km_f_title: "Title", km_f_body: "Body", km_f_tags: "Tags (comma separated)", km_f_trust: "Trust", km_f_trust_def: "Server default", km_f_ttl: "TTL (days, empty = default)", km_f_conf: "Confidence (0–1)", km_saved: "Document saved", km_dup_t: "Duplicate — nothing new created", km_merged_t: "Merged into an existing document",
    km_lessons: "Lessons learned", km_lessons_all: "All roles", km_no_lessons: "No trusted lessons yet.", km_body_req: "Body is required",
    ct_sub: "Judges are judged too: position consistency, self-preference, verbosity and EN/AR agreement", ct_probe: "Run probe", ct_probed: "Judge probe finished",
    ct_judges: "Judges", ct_in_panel: "in panel", ct_benched: "Benched", ct_certified: "Certified", ct_open: "Open spot-checks", ct_no_judges: "No judges yet.", ct_unmeasured: "not measured yet",
    ct_rel: "Reliability", ct_weight: "Weight", ct_pos: "Position", ct_self: "Self-pref", ct_lang: "EN/AR", ct_verb: "Verbosity", ct_gold: "Gold acc.", ct_kappa: "Kappa", ct_probes: "probes", ct_hist: "14 days", ct_target: "target",
    ct_kappa_h: "Judge agreement with the owner (Cohen's kappa)", ct_no_kappa: "No labels yet. Label a few spot-checks below.", ct_labels: "labels",
    ct_spot: "Spot-check labeling", ct_spot_hint: "You are the judge: which answer is better? Judge verdicts stay hidden until you choose", ct_task: "Task", ct_criteria: "Criteria", ct_answer: "Answer", ct_tie: "Tie", ct_skip: "Skip",
    ct_spot_empty: "No open spot-checks. They open automatically when judges disagree.", ct_labelled: "Label recorded", ct_judges_said: "Judges said", ct_remaining: "remaining",
    ct_weights: "Current weights", ct_known: "measured", ct_stale: "stale", ct_neutral: "neutral (1)", ct_no_weights: "No weights yet.",
    ct_f_judges: "Judges (none = whole panel)", ct_f_kinds: "Probe kinds (none = all)", ct_f_per: "Probes per judge", ct_f_calls: "Call cap",
    pk_position: "Position", pk_verbosity: "Verbosity", pk_gold: "Gold", pk_lang: "Language", pk_self_pref: "Self-preference",
    lab_launch: "Start", lab_filters: "Filters", lab_all: "All", lab_any: "Any",
  });

  const ICONS = {
    redteam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l7 4v5c0 4.5-3 8-7 9-4-1-7-4.5-7-9V7z"/><path d="M12 8v5M12 16.2v.3"/></svg>',
    memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M8 9.5h8M8 12.5h8M8 15.5h5"/></svg>',
    court: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3v18M7 21h10M4 7h16"/><path d="M6 7l-3 6a3 3 0 006 0zM18 7l-3 6a3 3 0 006 0z"/></svg>',
  };
  const CATS = ["prompt_injection", "tool_poisoning", "budget_evasion", "approval_bypass", "eval_gaming", "data_exfiltration", "constitution_violation"];
  const ROLES = ["director", "architect", "researcher", "builder", "toolsmith", "evaluator", "critic", "librarian", "auditor"];
  const PROBE_KINDS = ["position", "verbosity", "gold", "lang", "self_pref"];
  const snd = (n) => window.KFX && KFX.sound.play(n);
  const rt = { cats: [], bstatus: "", lib: { category: "", lang: "", source: "", status: "active" } };
  const mem = { trust: "", kind: "", status: "active", scope: "", q: "", sscope: "org", tonly: false, role: "" };
  const court = { queue: [], open: 0, keyOff: null, ro: null };

  // ---------- shared helpers ----------
  const ar = () => K.state.lang === "ar";
  const pct = (x) => K.pctTxt(x);
  const r2 = (x) => (x == null || !isFinite(x) ? "—" : (Math.round(Number(x) * 100) / 100).toFixed(2));
  const tone = (p) => (p == null || !isFinite(p) ? "na" : p >= 0.9 ? "good" : p >= 0.7 ? "mid" : "bad");
  const catFull = (id) => { const c = rt.cats.find((x) => x.id === id); return c ? (ar() ? c.ar || c.en : c.en || c.ar) : K.tOr("rt_c_" + id, id); };
  const catShort = (id) => K.tOr("rt_c_" + id, id);
  const sevKey = (s) => (s >= 0.7 ? "hi" : s >= 0.4 ? "med" : "lo");
  const sevBadge = (s) => `<span class="lbadge sev-${sevKey(Number(s) || 0)}" title="${K.esc(K.t("rt_sev"))} ${r2(s)}">${K.esc(K.t("rt_sev_" + sevKey(Number(s) || 0)))} · ${r2(s)}</span>`;
  const trustBadge = (tr) => `<span class="lbadge tr-${K.esc(tr)}">${K.esc(K.tOr("km_" + tr, tr))}</span>`;
  const bar = (p, extra = "") => (p == null || !isFinite(p) ? `<span class="faint">—</span>` : `<div class="lbar ${tone(p)}" ${extra}><i style="width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></i><span class="num">${pct(p)}</span></div>`);
  const opts = (vals, cur, lab) => vals.map((v) => `<option value="${K.esc(v)}" ${v === cur ? "selected" : ""}>${K.esc(lab(v))}</option>`).join("");
  const sel = (id, vals, cur, lab, aria) => `<select class="sel-sm" id="${id}" aria-label="${K.esc(aria)}">${opts(vals, cur, lab)}</select>`;
  const checks = (name, vals, lab, on = []) => `<div class="lchecks">${vals.map((v) => `<label class="lchk"><input type="checkbox" name="${name}" value="${K.esc(v)}" ${on.includes(v) ? "checked" : ""}/><span>${K.esc(lab(v))}</span></label>`).join("")}</div>`;
  const checked = (root, name) => [...root.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const onPage = (p) => (location.hash || "").replace(/^#\//, "").split(/[/?]/)[0] === p;
  const skel = (h, n = 1) => `<div class="skeleton" style="height:${h}px"></div>`.repeat(n);
  const empty = (msg, extra = "") => `<div class="card empty hive-empty">${K.HIVE_ART}<div class="t">${K.esc(msg)}</div>${extra}</div>`;
  function apiErr(e) {
    if (e && e.data && e.data.code) return K.toast(K.tOr("rt_err_" + e.data.code, e.data.error || e.message), true);
    if (e && e.data && e.data.message && e.status === 400) return K.toast(e.data.message, true);
    K.actErr(e);
  }
  function stat(label, value, sub, cls = "") {
    return `<div class="card stat ${cls}"><div class="label">${K.esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="faint lsub">${sub}</div>` : ""}</div>`;
  }

  // ======================================================================
  // Red-Team Arena
  // ======================================================================
  // Judge-reliability reasons come from the API in English; render them in the console language.
  const REASON_AR = [
    [/^no data: position$/, "لا بيانات كافية: ثبات الموضع"],
    [/^no data: self_pref$/, "لا بيانات كافية: التحيّز للذات"],
    [/^benched: /, "موقوف: "],
    [/^below target: /, "دون الهدف: "],
    [/position consistency/g, "ثبات الموضع"],
    [/gold accuracy/g, "دقة الذهب"],
    [/self-preference/g, "التحيّز للذات"],
    [/EN\/AR consistency/g, "اتساق اللغتين"],
    [/verbosity bias/g, "تحيّز الإطالة"],
    [/outside/g, "خارج"],
  ];
  const reasonText = (x) => (K.state.lang === "ar" ? REASON_AR.reduce((a, [re, to]) => a.replace(re, to), String(x)) : String(x));

  function radar(vals) {
    const n = vals.length, W = 360, H = 320, cx = W / 2, cy = H / 2 + 4, R = 112;
    const pt = (i, r) => { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
    let g = "";
    for (const f of [0.25, 0.5, 0.75, 1]) g += `<polygon class="rg" points="${vals.map((_, i) => pt(i, R * f).map((v) => v.toFixed(1)).join(",")).join(" ")}"/>`;
    vals.forEach((_, i) => { const [x, y] = pt(i, R); g += `<line class="rg" x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; });
    const has = vals.some((v) => v.v != null);
    const poly = vals.map((v, i) => pt(i, R * (v.v == null ? 0 : v.v)).map((q) => q.toFixed(1)).join(",")).join(" ");
    const dots = vals.map((v, i) => { if (v.v == null) return ""; const [x, y] = pt(i, R * v.v); return `<circle class="rd ${tone(v.v)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"><title>${K.esc(v.full)}: ${pct(v.v)}</title></circle>`; }).join("");
    const labels = vals.map((v, i) => { const [x, y] = pt(i, R + 26); const anchor = Math.abs(x - cx) < 8 ? "middle" : x > cx ? "start" : "end"; return `<text class="rl" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle">${K.esc(v.label)}<tspan class="rv" x="${x.toFixed(1)}" dy="14">${v.v == null ? "—" : pct(v.v)}</tspan><title>${K.esc(v.full)}</title></text>`; }).join("");
    return `<svg class="lradar" viewBox="0 0 ${W} ${H + 20}" role="img" aria-label="${K.esc(K.t("rt_radar"))}">${g}${has ? `<polygon class="rp" points="${poly}"/>` : ""}${dots}${labels}</svg>`;
  }
  function aggregate(agents) {
    const by = {};
    for (const c of CATS) by[c] = { runs: 0, passed: 0 };
    let runs = 0, passed = 0;
    for (const a of agents || []) {
      runs += a.runs || 0; passed += a.passed || 0;
      for (const [c, r] of Object.entries(a.by_category || {})) { by[c] = by[c] || { runs: 0, passed: 0 }; by[c].runs += r.runs || 0; by[c].passed += r.passed || 0; }
    }
    return { overall: runs ? passed / runs : null, runs, by };
  }
  async function renderRedteam() {
    const { t, esc, nf } = K;
    K.shell("redteam", t("nav_redteam"), t("rt_sub"), `<div class="grid g4">${skel(104, 4)}</div><div class="grid g2" style="margin-top:16px">${skel(380, 2)}</div>`);
    K.topActions().innerHTML = `<button class="btn sm" id="rtLib">☰ ${t("rt_library")}</button><button class="btn sm primary" id="rtLaunch">⚔ ${t("rt_launch")}</button>`;
    document.getElementById("rtLib").onclick = openLibrary;
    document.getElementById("rtLaunch").onclick = openLaunch;
    const [sr, br] = await Promise.allSettled([K.apiSoft("/api/redteam/summary"), K.apiSoft(`/api/redteam/breaches?limit=60${rt.bstatus ? `&status=${rt.bstatus}` : ""}`)]);
    for (const r of [sr, br]) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason;
    if (sr.status === "rejected") { K.content().innerHTML = K.failCard(sr.reason, "redteam"); K.bindRetry(K.content(), renderRedteam); return; }
    const s = sr.value;
    rt.cats = s.categories || rt.cats;
    const breaches = br.status === "fulfilled" ? br.value.breaches || [] : null;
    const agg = aggregate(s.agents);
    const cats = (rt.cats.length ? rt.cats.map((c) => c.id) : CATS);
    const B = s.breaches || {}, A = s.attacks || {}, REG = s.regressions || {};
    const radarVals = cats.map((c) => ({ id: c, label: catShort(c), full: catFull(c), v: agg.by[c] && agg.by[c].runs ? agg.by[c].passed / agg.by[c].runs : null }));
    const catRows = cats.map((c) => { const a = agg.by[c] || { runs: 0 }; return `<div class="lcat"><div class="lcat-h"><span dir="auto" title="${esc(catFull(c))}">${esc(catFull(c))}</span><span class="spacer"></span><span class="faint num">${nf(A.by_category && A.by_category[c] || 0)} ⚔ · ${nf((B.confirmed_by_category || {})[c] || 0)} ✕ · ${nf((REG.by_category || {})[c] || 0)} ↺</span></div>${bar(a.runs ? a.passed / a.runs : null, `title="${nf(a.runs)} ${esc(t("rt_runs"))}"`)}</div>`; }).join("");
    K.content().innerHTML = `
      <div class="grid g4">
        ${stat(t("rt_attacks"), `<span data-count>${nf(A.active || 0)}</span>`, `${esc(t("rt_of_total"))} ${nf(A.total || 0)} · ${Object.entries(A.by_lang || {}).map(([l, n]) => `${esc(l)} ${nf(n)}`).join(" · ")}`)}
        ${stat(t("rt_pass"), agg.overall == null ? "—" : pct(agg.overall), `${nf(agg.runs)} ${esc(t("rt_runs"))} · ${esc(t("rt_last_probe"))}: ${s.last_probe_at ? esc(K.ago(s.last_probe_at)) : esc(t("rt_never"))}`, agg.overall != null && agg.overall < 0.7 ? "lwarn" : "")}
        ${stat(t("rt_breaches"), `<span data-count>${nf(B.confirmed || 0)}</span>`, `${nf(B.suspected || 0)} ${esc(t("rt_suspected"))} · ${nf(B.rejected || 0)} ${esc(t("rt_rejected_n"))}`, B.confirmed ? "lbad" : "")}
        ${stat(t("rt_regressions"), `<span data-count>${nf(REG.total || 0)}</span>`, `<span class="mono">${esc(REG.suite || "")}</span>`)}
      </div>
      <div class="grid lcols" style="margin-top:16px">
        <section class="card"><h2>${t("rt_radar")} <span class="hint">${t("rt_radar_hint")}</span></h2>${agg.runs ? radar(radarVals) : `<div class="empty">${esc(t("rt_no_rates"))}</div>`}</section>
        <section class="card"><h2>${t("rt_category")}</h2><div class="lcats">${catRows}</div><div class="faint lsub" style="margin-top:10px">⚔ ${esc(t("rt_attacks"))} · ✕ ${esc(t("rt_breaches"))} · ↺ ${esc(t("rt_regressions"))}</div></section>
      </div>
      <section class="card" style="margin-top:16px"><h2>${t("rt_agents")}</h2>${agentTable(s.agents || [], cats)}</section>
      <section class="card" style="margin-top:16px"><h2>${t("rt_breach_list")}<span class="spacer"></span><div class="seg" role="tablist" id="bSeg">${["", "suspected", "confirmed", "rejected"].map((x) => `<button role="tab" aria-selected="${rt.bstatus === x}" class="${rt.bstatus === x ? "on" : ""}" data-b="${x}">${esc(x ? t("rt_st_" + x) : t("lab_all"))}</button>`).join("")}</div></h2>
        <div id="bList">${breaches == null ? K.failCard(br.reason, "redteam") : breachList(breaches)}</div></section>
      <div class="grid g2" style="margin-top:16px">
        <section class="card"><h2>${t("rt_campaigns")}</h2>${campaigns(s.campaigns || [])}</section>
        <section class="card"><h2>${t("rt_attackers")}</h2>${attackers(s.attackers || [])}</section>
      </div>`;
    K.content().querySelectorAll("#bSeg [data-b]").forEach((b) => (b.onclick = () => { rt.bstatus = b.dataset.b; renderRedteam(); }));
    K.bindRetry(K.content(), renderRedteam);
    K.content().querySelectorAll("details.lev").forEach((d) => d.addEventListener("toggle", () => d.open && snd("open")));
  }
  function agentTable(agents, cats) {
    const { t, esc, nf } = K;
    if (!agents.length) return `<div class="empty">${esc(t("rt_no_agents"))}</div>`;
    return `<div class="tbl-wrap"><table class="table ltbl"><thead><tr><th>${t("col_agent")}</th><th>${t("rt_overall")}</th>${cats.map((c) => `<th class="lth" title="${esc(catFull(c))}">${esc(catShort(c))}</th>`).join("")}</tr></thead><tbody>
      ${agents.map((a) => `<tr><td><a href="#/agents/${encodeURIComponent(a.agent_id)}"><span class="hex xs">${esc(K.glyph(a.role))}</span> ${esc(K.roleLabel(a.role))}</a><div class="mono faint">${esc(K.short(a.agent_id))}</div></td><td>${bar(a.pass_rate)}<div class="faint num">${nf(a.passed)}/${nf(a.runs)}</div></td>
        ${cats.map((c) => { const r = (a.by_category || {})[c]; return r ? `<td><span class="lcell ${tone(r.pass_rate)}" title="${esc(catFull(c))}: ${nf(r.passed)}/${nf(r.runs)}">${pct(r.pass_rate)}</span></td>` : `<td><span class="lcell na">—</span></td>`; }).join("")}</tr>`).join("")}
    </tbody></table></div>`;
  }
  function breachList(list) {
    const { t, esc, nf } = K;
    if (!list.length) return `<div class="empty">${esc(t("rt_no_breaches"))}</div>`;
    return `<div class="lbreaches">${list.map((b) => {
      const ev = b.evidence || {};
      const acts = Array.isArray(ev.actions) ? ev.actions : [];
      const dets = Array.isArray(b.detectors) ? b.detectors : [];
      return `<article class="lbr st-${esc(b.status)}">
        <div class="row lbr-h"><span class="lbadge bst-${esc(b.status)}">${esc(K.tOr("rt_st_" + b.status, b.status))}</span>${sevBadge(b.severity)}<span class="lbadge ${b.contained ? "ok" : "bad"}">${b.contained ? "🛡 " + esc(t("rt_contained")) : "⚠ " + esc(t("rt_uncontained"))}</span>${b.soft ? `<span class="tag">${esc(t("rt_soft"))}</span>` : ""}<span class="spacer"></span><span class="faint" title="${esc(K.when(b.updated_at))}">${esc(K.ago(b.updated_at))}</span></div>
        <div class="lbr-t" dir="auto"><b>${esc(catFull(b.category))}</b> · <a href="#/agents/${encodeURIComponent(b.agent_id)}">${esc(K.roleLabel(b.role))}</a> <span class="mono faint">${esc(K.short(b.agent_id))}</span></div>
        <div class="faint lbr-m"><span>${esc(t("rt_repro"))}: <b class="num">${nf(b.repro_ok || 0)}/${nf(b.repro_runs || 0)}</b></span><span>${esc(t("rt_control"))}: ${b.control_breach == null ? "—" : b.control_breach ? `<b class="bad">${esc(t("rt_control_dirty"))}</b>` : `<b class="good">${esc(t("rt_control_clean"))}</b>`}</span>${b.regression_id ? `<span>↺ ${esc(t("rt_regression"))} <span class="mono">${esc(K.short(b.eval_item_id || b.regression_id))}</span></span>` : ""}<span class="mono">${esc(K.short(b.attack_id))}</span></div>
        ${b.reason ? `<div class="faint" dir="auto">${esc(b.reason)}</div>` : ""}
        <details class="lev"><summary>${esc(t("rt_evidence"))}</summary>
          ${ev.final ? `<h4>${esc(t("rt_final"))}</h4><div class="lquote" dir="auto">${esc(ev.final)}</div>` : ""}
          ${acts.length ? `<h4>${esc(t("rt_actions"))}</h4><ul class="lacts">${acts.map((a) => `<li><span class="mono">${esc(a.tool)}</span> <span class="lbadge dec-${esc(a.decision)}">${esc(a.decision)}</span><div class="mono faint" dir="ltr">${esc(a.args || "")}</div></li>`).join("")}</ul>` : ""}
          ${dets.length ? `<h4>${esc(t("rt_detectors"))}</h4><ul class="lacts">${dets.map((d) => `<li><span class="mono">${esc(d.detector)}</span> ${sevBadge(d.severity)}<div class="faint" dir="auto">${esc(d.evidence || "")}</div></li>`).join("")}</ul>` : ""}
          ${ev.critic ? `<h4>${esc(t("rt_critic"))}</h4><div class="lquote" dir="auto">${ev.critic.breach ? "✕" : "✓"} ${r2(ev.critic.severity)} — ${esc(ev.critic.rationale || "")}${ev.critic.model ? ` <span class="mono faint">${esc(ev.critic.model)}</span>` : ""}</div>` : ""}
        </details>
      </article>`;
    }).join("")}</div>`;
  }
  function campaigns(list) {
    const { t, esc, nf } = K;
    if (!list.length) return `<div class="empty">${esc(t("rt_no_campaigns"))}</div>`;
    return `<div class="lmini">${list.map((j) => { const r = j.result || {}; const b = r.breaches || {}; return `<div class="row"><span class="badge ${esc(j.status === "done" ? "done" : j.status)}">${esc(K.tOr("job_st_" + j.status, j.status))}</span><span class="faint num">${nf(r.probes || 0)} ⚔ · ${nf(b.confirmed || 0)} ✕ · ${nf(Array.isArray(r.regressions_added) ? r.regressions_added.length : r.regressions_added || 0)} ↺</span><span class="spacer"></span><span class="faint">${esc(K.ago(j.finished_at || j.updated_at || j.created_at))}</span></div>`; }).join("")}</div>`;
  }
  function attackers(list) {
    const { t, esc, nf } = K;
    if (!list.length) return `<div class="empty">—</div>`;
    return `<div class="lmini">${list.map((a, i) => `<div class="row"><span class="num faint">#${i + 1}</span><b dir="auto">${esc(a.name || a.id)}</b><span class="spacer"></span><span class="faint num">${nf(a.generated || 0)} ${esc(t("rt_generated"))} · ${nf(a.confirmed || 0)} ✕ · ${esc(t("rt_score"))} ${r2(a.score)}</span></div>`).join("")}</div>`;
  }
  function openLaunch() {
    const { t, esc } = K;
    const cats = rt.cats.length ? rt.cats.map((c) => c.id) : CATS;
    const body = K.openDrawer(`<div class="dr-head"><span class="tool-ico big" aria-hidden="true">⚔</span><div><h2>${esc(t("rt_launch"))}</h2><div class="faint">${esc(t("rt_sub"))}</div></div></div>
      <form class="lform" id="rtForm">
        <div class="grid g2"><div><label class="f" for="rtMax">${t("rt_f_max")}</label><input id="rtMax" type="number" min="1" max="500" value="24"/></div>
        <div><label class="f" for="rtCritic">${t("rt_f_critic")}</label>${sel("rtCritic", ["auto", "always", "off"], "auto", (v) => t("rt_critic_" + v), t("rt_f_critic"))}</div></div>
        <label class="f">${t("rt_f_cats")}</label>${checks("cat", cats, catFull)}
        <label class="f">${t("rt_f_langs")}</label>${checks("lang", ["en", "ar", "mixed"], (v) => v)}
        <div class="grid g2"><div><label class="f" for="rtGen">${t("rt_f_gen")}</label><input id="rtGen" type="number" min="0" max="20" value="0"/></div>
        <div><label class="f" for="rtCalls">${t("rt_f_calls")}</label><input id="rtCalls" type="number" min="1" max="500" placeholder="—"/></div></div>
        <button class="btn primary block" type="submit" id="rtGo">⚔ ${t("lab_launch")}</button>
      </form>`, t("rt_launch"));
    const f = body.querySelector("#rtForm");
    f.onsubmit = (e) => {
      e.preventDefault();
      const btn = body.querySelector("#rtGo");
      const p = { max_attacks: Number(body.querySelector("#rtMax").value) || 24, critic: body.querySelector("#rtCritic").value };
      const c = checked(f, "cat"); if (c.length) p.categories = c;
      const l = checked(f, "lang"); if (l.length) p.langs = l;
      const g = Number(body.querySelector("#rtGen").value) || 0; if (g > 0) p.generate = g;
      const mc = Number(body.querySelector("#rtCalls").value) || 0; if (mc > 0) p.max_calls = mc;
      K.busy(btn, async () => {
        try {
          await K.startJob("/api/redteam/campaign", p, onCampaignDone);
          K.toast(t("rt_launched")); snd("open"); if (window.KFX) KFX.bg.surge(undefined, undefined, "239,91,91");
          K.closeDrawer();
        } catch (ex) { apiErr(ex); }
      });
    };
  }
  function onCampaignDone(j) {
    const r = j.result || {}, b = r.breaches || {};
    const confirmed = Number(b.confirmed) || 0;
    if (j.status === "done" && confirmed > 0) { snd("rejection"); if (window.KFX) { KFX.flash("red"); KFX.toast(`${K.t("rt_done_breach")}: ${K.nf(confirmed)}`, { kind: "err", sound: false }); } }
    else if (j.status === "done" && window.KFX) KFX.toast(K.t("rt_done_clean"), { kind: "ok", icon: "tool", sound: false });
    if (onPage("redteam")) renderRedteam();
  }
  async function openLibrary() {
    const { t, esc, nf } = K;
    const body = K.openDrawer(skel(60) + `<div style="margin-top:12px">${skel(300)}</div>`, t("rt_library"));
    const L = rt.lib;
    const cats = rt.cats.length ? rt.cats.map((c) => c.id) : CATS;
    const paint = async () => {
      body.innerHTML = `<div class="dr-head"><span class="tool-ico big" aria-hidden="true">☰</span><div><h2>${esc(t("rt_library"))}</h2><div class="faint">${esc(t("rt_lib_sub"))}</div></div></div>
        <div class="row lfilters" role="group" aria-label="${esc(t("lab_filters"))}">
          ${sel("lfCat", [""].concat(cats), L.category, (v) => (v ? catShort(v) : t("rt_category") + ": " + t("lab_any")), t("rt_category"))}
          ${sel("lfLang", ["", "en", "ar", "mixed"], L.lang, (v) => (v ? v : t("rt_lang") + ": " + t("lab_any")), t("rt_lang"))}
          ${sel("lfSrc", ["", "seed", "owner", "attacker"], L.source, (v) => (v ? t("rt_src_" + v) : t("rt_source") + ": " + t("lab_any")), t("rt_source"))}
          ${sel("lfSt", ["", "active", "candidate", "rejected", "retired"], L.status, (v) => (v ? t("ast_" + v) : t("col_status") + ": " + t("lab_any")), t("col_status"))}
        </div><div id="lfList">${skel(260)}</div>`;
      [["lfCat", "category"], ["lfLang", "lang"], ["lfSrc", "source"], ["lfSt", "status"]].forEach(([id, k]) => (body.querySelector("#" + id).onchange = (e) => { L[k] = e.target.value; paint(); }));
      const q = new URLSearchParams(); for (const [k, v] of Object.entries(L)) if (v) q.set(k, v); q.set("limit", "200");
      const box = body.querySelector("#lfList");
      let r;
      try { r = await K.apiSoft("/api/redteam/attacks?" + q); } catch (e) { if (e instanceof K.AuthError) return K.renderLogin(); box.innerHTML = K.failCard(e, "redteam"); K.bindRetry(box, paint); return; }
      if (!box.isConnected) return;
      const list = r.attacks || [];
      box.innerHTML = list.length ? `<div class="faint lsub">${nf(list.length)}</div><div class="llib">${list.map((a) => `<details class="latk"><summary><div class="row"><b dir="auto" class="grow">${esc(a.title)}</b><span class="lbadge ast-${esc(a.status)}">${esc(K.tOr("ast_" + a.status, a.status))}</span></div>
          <div class="row faint lbr-m"><span>${esc(catShort(a.category))}</span><span class="tag">${esc(a.lang)}</span><span class="tag mono">${esc(a.vector)}</span><span class="ldiff" title="${esc(t("rt_difficulty"))} ${a.difficulty}/10"><i style="width:${(Number(a.difficulty) || 0) * 10}%"></i></span><span>${esc(String(a.source).startsWith("attacker") ? t("rt_src_attacker") : K.tOr("rt_src_" + a.source, a.source))}</span></div></summary>
          ${a.spec && a.spec.task ? `<h4>${esc(t("ct_task"))}</h4><div class="lquote" dir="auto">${esc(a.spec.task)}</div>` : ""}
          ${a.spec && a.spec.expected_safe ? `<div class="okbox" dir="auto">${esc(a.spec.expected_safe)}</div>` : ""}
          <h4>${esc(t("rt_spec"))}</h4><pre dir="ltr">${K.pretty(a.spec)}</pre></details>`).join("")}</div>` : `<div class="empty">${esc(t("rt_no_attacks"))}</div>`;
    };
    paint();
  }

  // ======================================================================
  // Org Memory / KB
  // ======================================================================
  async function renderMemory() {
    const { t, esc, nf } = K;
    K.shell("memory", t("nav_memory"), t("km_sub"), `<div class="grid g4">${skel(104, 4)}</div><div style="margin-top:16px">${skel(120)}</div><div class="grid lcols" style="margin-top:16px">${skel(420, 2)}</div>`);
    K.topActions().innerHTML = `<button class="btn sm" id="kmCompact">⟳ ${t("km_compact")}</button><button class="btn sm primary" id="kmNew">+ ${t("km_new")}</button>`;
    document.getElementById("kmNew").onclick = openNewDoc;
    document.getElementById("kmCompact").onclick = (e) => K.busy(e.currentTarget, async () => {
      try { await K.startJob("/api/kb/compact", {}, (j) => { if (j.status === "done" && window.KFX) KFX.toast(K.t("km_compacted"), { kind: "ok", sound: false }); if (onPage("memory")) renderMemory(); }); } catch (ex) { apiErr(ex); }
    });
    const q = new URLSearchParams(); if (mem.scope) q.set("scope", mem.scope); if (mem.trust) q.set("trust", mem.trust); if (mem.kind) q.set("kind", mem.kind); q.set("status", mem.status); q.set("limit", "100");
    const [dr, lr] = await Promise.allSettled([K.apiSoft("/api/kb/docs?" + q), K.apiSoft("/api/kb/lessons" + (mem.role ? `?role=${encodeURIComponent(mem.role)}` : ""))]);
    for (const r of [dr, lr]) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason;
    if (dr.status === "rejected") { K.content().innerHTML = K.failCard(dr.reason, "memory"); K.bindRetry(K.content(), renderMemory); return; }
    const docs = dr.value.docs || [], st = dr.value.stats || {};
    const org = st.org || {}, epi = st.episodic || {};
    const epiN = Object.values(epi).reduce((a, b) => a + b, 0);
    K.content().innerHTML = `
      <div class="grid g4">
        ${stat(t("km_trusted"), `<span data-count>${nf(org.trusted || 0)}</span>`, `${esc(t("km_scope_org"))}`)}
        ${stat(t("km_pending"), `<span data-count>${nf(org.pending || 0)}</span>`, `${nf(org.untrusted || 0)} ${esc(t("km_untrusted"))} · ${nf(org.rejected || 0)} ${esc(t("km_rejected"))}`, org.pending ? "lwarn" : "")}
        ${stat(t("km_episodic"), `<span data-count>${nf(epiN)}</span>`, Object.entries(st.by_status || {}).map(([k, n]) => `${esc(K.tOr("kms_" + k, k))} ${nf(n)}`).join(" · "))}
        ${stat(t("km_vectors"), `<span class="value sm">${st.vectors ? K.badge("ok", t("km_on")) : K.badge("pending", t("km_off"))}</span>`, "")}
      </div>
      <section class="card lsearch" style="margin-top:16px"><h2>${t("km_search")}</h2>
        <form class="row" id="kmSearch" role="search"><input id="kmQ" class="grow" maxlength="300" placeholder="${esc(t("km_search_ph"))}" value="${esc(mem.q)}" dir="auto" aria-label="${esc(t("km_search"))}"/>
          ${sel("kmSScope", ["org", "all"], mem.sscope, (v) => (v === "org" ? t("km_scope_org") : t("km_scope_all")), t("km_scope"))}
          <label class="lchk"><input type="checkbox" id="kmTOnly" ${mem.tonly ? "checked" : ""}/><span>${t("km_trusted_only")}</span></label>
          <button class="btn sm primary" type="submit">${esc(t("km_go"))}</button></form>
        <div id="kmHits"></div></section>
      <div class="grid lcols" style="margin-top:16px">
        <section class="card"><h2>${t("km_docs")} <span class="hint num">${nf(docs.length)}</span></h2>
          <div class="row lfilters">
            <div class="seg" role="tablist" id="kmTrust">${["", "trusted", "pending", "untrusted", "rejected"].map((x) => `<button role="tab" aria-selected="${mem.trust === x}" class="${mem.trust === x ? "on" : ""}" data-v="${x}">${esc(x ? t("km_" + x) : t("lab_all"))}</button>`).join("")}</div>
            ${sel("kmKind", ["", "doc", "episode", "lesson", "summary", "playbook"], mem.kind, (v) => (v ? t("kk_" + v) : t("km_kind") + ": " + t("lab_any")), t("km_kind"))}
            ${sel("kmStatus", ["active", "archived", "expired", "merged"], mem.status, (v) => t("kms_" + v), t("km_status"))}
            ${sel("kmScope", ["", "org"].concat([...new Set(docs.map((d) => d.scope).filter((s) => s && s !== "org"))]).concat(mem.scope && mem.scope !== "org" ? [mem.scope] : []).filter((v, i, a) => a.indexOf(v) === i), mem.scope, (v) => (v ? (v === "org" ? t("km_scope_org") : v) : t("km_scope_all")), t("km_scope"))}
          </div>
          ${docs.length ? `<div class="tbl-wrap"><table class="table"><thead><tr><th>${t("km_f_title")}</th><th>${t("km_kind")}</th><th>${t("km_f_trust")}</th><th>${t("km_conf")}</th><th>${t("col_when")}</th></tr></thead><tbody>
            ${docs.map((d) => `<tr class="click kdoc" data-id="${esc(d.id)}"><td><div class="trunc" dir="auto"><b>${esc(d.title || "—")}</b></div><div class="faint trunc"><span class="mono">${esc(d.scope)}</span> · ${esc(d.author || "")}${(d.flags || []).length ? ` · <span class="lflag">⚑ ${esc(d.flags.join(", "))}</span>` : ""}</div></td><td><span class="tag">${esc(K.tOr("kk_" + d.kind, d.kind))}</span></td><td>${trustBadge(d.trust)}</td><td class="num">${r2(d.confidence)}</td><td class="faint">${esc(K.ago(d.updated_at || d.created_at))}</td></tr>`).join("")}
          </tbody></table></div>` : `<div class="empty">${esc(t("km_no_docs"))}</div>`}
        </section>
        <section class="card"><h2>${t("km_lessons")}</h2>
          ${sel("kmRole", [""].concat(ROLES), mem.role, (v) => (v ? K.roleLabel(v) : t("km_lessons_all")), t("km_lessons"))}
          <div id="kmLessons" style="margin-top:10px">${lr.status === "rejected" ? K.failCard(lr.reason, "memory") : lessons(lr.value.lessons || [])}</div>
        </section>
      </div>`;
    const C = K.content();
    C.querySelectorAll("#kmTrust [data-v]").forEach((b) => (b.onclick = () => { mem.trust = b.dataset.v; renderMemory(); }));
    C.querySelector("#kmKind").onchange = (e) => { mem.kind = e.target.value; renderMemory(); };
    C.querySelector("#kmStatus").onchange = (e) => { mem.status = e.target.value; renderMemory(); };
    C.querySelector("#kmScope").onchange = (e) => { mem.scope = e.target.value; renderMemory(); };
    C.querySelector("#kmRole").onchange = (e) => { mem.role = e.target.value; renderMemory(); };
    C.querySelector("#kmSearch").onsubmit = (e) => { e.preventDefault(); mem.q = C.querySelector("#kmQ").value.trim(); mem.sscope = C.querySelector("#kmSScope").value; mem.tonly = C.querySelector("#kmTOnly").checked; search(); };
    K.bindClick(C, ".kdoc", (el) => openDoc(el.dataset.id));
    K.bindRetry(C, renderMemory);
    if (mem.q) search();
  }
  function lessons(list) {
    const { t, esc } = K;
    if (!list.length) return `<div class="empty">${esc(t("km_no_lessons"))}</div>`;
    // ?role= returns plain strings; no role returns {id,title,body,updated_at} — group the latter by "Lessons: <role> / <op>".
    if (typeof list[0] === "string") return `<ul class="llessons">${list.map((s) => `<li dir="auto">${esc(s)}</li>`).join("")}</ul>`;
    const groups = new Map();
    for (const l of list) { const m = /^Lessons:\s*([^/]+?)\s*\/\s*(.+)$/.exec(l.title || ""); const role = m ? m[1] : "—"; if (!groups.has(role)) groups.set(role, []); groups.get(role).push({ ...l, op: m ? m[2] : l.title }); }
    return [...groups.entries()].map(([role, ls]) => `<div class="lgroup"><h3><span class="hex xs">${esc(K.glyph(role))}</span> ${esc(K.roleLabel(role))} <span class="faint num">${K.nf(ls.length)}</span></h3><ul class="llessons">${ls.map((l) => `<li class="kdoc-l" data-id="${esc(l.id)}"><span class="mono faint">${esc(K.opLabel ? K.opLabel(l.op) : l.op)}</span><div dir="auto">${esc(String(l.body || "").slice(0, 320))}</div></li>`).join("")}</ul></div>`).join("");
  }
  async function search() {
    const { t, esc } = K;
    const box = document.getElementById("kmHits");
    if (!box || !mem.q) return;
    box.innerHTML = skel(80);
    let r;
    try { r = await K.apiSoft(`/api/kb/search?q=${encodeURIComponent(mem.q)}&scope=${encodeURIComponent(mem.sscope)}&k=10${mem.tonly ? "&trusted_only=1" : ""}`); }
    catch (e) { if (e instanceof K.AuthError) return K.renderLogin(); box.innerHTML = K.failCard(e, "memory"); K.bindRetry(box, search); return; }
    if (!box.isConnected) return;
    const hits = r.results || [];
    box.innerHTML = `<div class="row lmode"><span class="faint">${esc(t("km_mode"))}:</span><span class="lbadge mode-${esc(r.mode)}">${esc(K.tOr("mode_" + r.mode, r.mode))}</span><span class="faint num">${K.nf(hits.length)}</span></div>` +
      (hits.length ? `<div class="lhits">${hits.map((h) => `<div class="lhit kdoc" data-id="${esc(h.id)}"><div class="row"><b dir="auto" class="grow">${esc(h.title || "—")}</b>${trustBadge(h.trust)}${h.verified ? `<span class="lbadge ok">✓ ${esc(t("km_verified"))}</span>` : ""}<span class="tag mono">${esc(h.via)}</span><span class="num faint">${(Number(h.score) || 0).toFixed(3)}</span></div><div class="faint lclip" dir="auto">${esc(String(h.body || "").slice(0, 280))}</div></div>`).join("")}</div>` : `<div class="empty">${esc(t("km_no_hits"))}</div>`);
    K.bindClick(box, ".kdoc", (el) => openDoc(el.dataset.id));
    snd(hits.length ? "notify" : "click");
  }
  async function openDoc(id) {
    const { t, esc, nf } = K;
    const body = K.openDrawer(skel(90) + `<div style="margin-top:14px">${skel(220)}</div>`, id);
    let d;
    try { d = await K.apiSoft(`/api/kb/docs/${encodeURIComponent(id)}`); } catch (e) { if (e instanceof K.AuthError) return K.renderLogin(); body.innerHTML = K.failCard(e, "memory"); K.bindRetry(body, () => openDoc(id)); return; }
    const x = d.doc, reviews = d.reviews || [];
    const archived = x.status !== "active";
    body.innerHTML = `
      <div class="dr-head"><span class="tool-ico big" aria-hidden="true">✦</span><div style="min-width:0"><h2 dir="auto">${esc(x.title || "—")}</h2><div class="faint"><span class="mono">${esc(x.scope)}</span> · ${esc(x.author || "")}${x.author_role ? ` (${esc(K.roleLabel(x.author_role))})` : ""} · ${esc(K.when(x.created_at))}</div></div></div>
      <div class="row" style="margin:10px 0">${trustBadge(x.trust)}<span class="tag">${esc(K.tOr("kk_" + x.kind, x.kind))}</span><span class="tag">${esc(K.tOr("kms_" + x.status, x.status))}</span>${(x.flags || []).map((f) => `<span class="lflag">⚑ ${esc(f)}</span>`).join("")}</div>
      <div class="ldoc" dir="auto">${esc(x.body || "")}</div>
      <dl class="kv" style="margin-top:14px"><dt>${t("km_conf")}</dt><dd class="num">${r2(x.confidence)}</dd><dt>${t("km_uses")}</dt><dd class="num">${nf(x.uses || 0)} · ${nf(x.votes || 0)} ▲</dd><dt>${t("km_tags")}</dt><dd>${(x.tags || []).map((g) => `<span class="tag">${esc(g)}</span>`).join(" ") || "—"}</dd><dt>${t("km_expires")}</dt><dd>${esc(x.expires_at ? K.when(x.expires_at) : "—")}</dd>${x.dup_of ? `<dt>${t("km_dup")}</dt><dd class="mono">${esc(x.dup_of)}</dd>` : ""}<dt>${t("rt_source")}</dt><dd>${esc(x.source || "")}</dd><dt>ID</dt><dd class="mono">${esc(x.id)}</dd></dl>
      <h3>${t("km_reviews")}</h3>${reviews.length ? `<ul class="lreviews">${reviews.map((r) => `<li><div class="row"><span class="lbadge rv-${esc(r.verdict)}">${esc(r.verdict)}</span><b>${esc(r.reviewer)}</b>${r.reviewer_role ? `<span class="faint">${esc(K.roleLabel(r.reviewer_role))}</span>` : ""}<span class="tag mono">${esc(r.method)}</span><span class="spacer"></span><span class="faint">${esc(K.ago(r.at))}</span></div>${r.notes ? `<div class="faint" dir="auto">${esc(r.notes)}</div>` : ""}</li>`).join("")}</ul>` : `<div class="faint">${esc(t("km_no_reviews"))}</div>`}
      <div id="kmOut"></div>
      <div class="dr-actions row lrev">
        <button class="btn sm success" data-rv="approve">✓ ${t("km_approve")}</button><button class="btn sm danger" data-rv="reject">✕ ${t("km_reject")}</button><button class="btn sm" data-rv="untrusted">⚑ ${t("km_mark_untrusted")}</button>
        <button class="btn sm" id="kmCritic">⚖ ${t("km_ask_critic")}</button><span class="spacer"></span><button class="btn sm ghost" id="kmArch">${archived ? "↺ " + t("km_restore") : "🗄 " + t("km_archive")}</button>
      </div>`;
    const done = () => { if (onPage("memory")) { renderMemory().then(() => openDoc(id)); } else openDoc(id); };
    body.querySelectorAll("[data-rv]").forEach((b) => (b.onclick = async () => {
      const notes = await K.dialog({ title: `${b.textContent.trim()} — ${x.title || x.id}`, confirm: b.textContent.trim(), danger: b.dataset.rv !== "approve", input: { placeholder: t("km_notes"), fallback: "", dir: "auto" } });
      if (notes === false) return;
      try { await K.apiSoft(`/api/kb/docs/${encodeURIComponent(id)}/review`, { method: "POST", body: { verdict: b.dataset.rv, notes: notes || undefined } }); snd(b.dataset.rv === "approve" ? "done" : "rejection"); K.toast(t("km_reviewed"), false, false); done(); } catch (e) { apiErr(e); }
    }));
    body.querySelector("#kmCritic").onclick = (e) => K.busy(e.currentTarget, async () => {
      try {
        const r = await K.apiSoft(`/api/kb/docs/${encodeURIComponent(id)}/review`, { method: "POST", body: { by: "critic" } });
        const o = r.outcome || {};
        const out = body.querySelector("#kmOut");
        if (out) out.innerHTML = `<div class="${o.verdict === "approve" ? "okbox" : "warnbox"}" dir="auto"><b>${esc(t("km_critic_said"))}:</b> ${esc(o.verdict || "—")} <span class="mono faint">${esc(o.method || "")} · ${esc(o.reviewer || "")}</span>${(o.notes || []).length ? `<div>${esc(o.notes.join("; "))}</div>` : ""}</div>`;
        snd(o.verdict === "approve" ? "done" : o.verdict === "deferred" ? "notify" : "rejection");
        if (o.verdict !== "deferred") setTimeout(done, 1400);
      } catch (ex) { apiErr(ex); }
    });
    body.querySelector("#kmArch").onclick = (e) => K.busy(e.currentTarget, async () => {
      try { await K.apiSoft(`/api/kb/docs/${encodeURIComponent(id)}/archive`, { method: "POST", body: archived ? { restore: true } : {} }); K.toast(t(archived ? "km_restored_t" : "km_archived_t")); done(); } catch (ex) { apiErr(ex); }
    });
  }
  function openNewDoc() {
    const { t, esc } = K;
    const body = K.openDrawer(`<div class="dr-head"><span class="tool-ico big" aria-hidden="true">+</span><div><h2>${esc(t("km_new"))}</h2><div class="faint">${esc(t("km_sub"))}</div></div></div>
      <form class="lform" id="kmForm">
        <label class="f" for="kfTitle">${t("km_f_title")}</label><input id="kfTitle" maxlength="160" dir="auto"/>
        <label class="f" for="kfBody">${t("km_f_body")}</label><textarea id="kfBody" rows="9" maxlength="8000" dir="auto" required></textarea>
        <div class="grid g2"><div><label class="f" for="kfKind">${t("km_kind")}</label>${sel("kfKind", ["doc", "playbook", "lesson", "summary", "episode"], "doc", (v) => t("kk_" + v), t("km_kind"))}</div>
        <div><label class="f" for="kfScope">${t("km_scope")}</label><input id="kfScope" value="org" dir="ltr" class="mono"/></div></div>
        <label class="f" for="kfTags">${t("km_f_tags")}</label><input id="kfTags" dir="auto"/>
        <div class="grid g2"><div><label class="f" for="kfTrust">${t("km_f_trust")}</label>${sel("kfTrust", ["", "trusted", "pending", "untrusted"], "", (v) => (v ? t("km_" + v) : t("km_f_trust_def")), t("km_f_trust"))}</div>
        <div><label class="f" for="kfConf">${t("km_f_conf")}</label><input id="kfConf" type="number" min="0" max="1" step="0.05" placeholder="—"/></div></div>
        <label class="f" for="kfTtl">${t("km_f_ttl")}</label><input id="kfTtl" type="number" min="1" max="3650" placeholder="—"/>
        <button class="btn primary block" type="submit" id="kfGo">${t("save")}</button>
      </form>`, t("km_new"));
    body.querySelector("#kmForm").onsubmit = (e) => {
      e.preventDefault();
      const v = (id) => body.querySelector("#" + id).value.trim();
      if (!v("kfBody")) return K.toast(t("km_body_req"), true);
      const p = { title: v("kfTitle") || undefined, body: v("kfBody"), kind: v("kfKind"), scope: v("kfScope") || "org", tags: v("kfTags") ? v("kfTags").split(/[,،]/).map((s) => s.trim()).filter(Boolean) : [] };
      if (v("kfTrust")) p.trust = v("kfTrust");
      if (v("kfConf") !== "") p.confidence = Number(v("kfConf"));
      if (v("kfTtl") !== "") p.ttl_days = Number(v("kfTtl"));
      K.busy(body.querySelector("#kfGo"), async () => {
        try {
          const r = await K.apiSoft("/api/kb/docs", { method: "POST", body: p });
          K.toast(t(r.status === "duplicate" ? "km_dup_t" : r.status === "merged" ? "km_merged_t" : "km_saved"), false, r.status === "created" ? "done" : "notify");
          if (r.status === "created" && window.KFX) KFX.burst(body.querySelector("#kfGo"), "76,195,138");
          if (onPage("memory")) await renderMemory();
          openDoc(r.id);
        } catch (ex) { apiErr(ex); }
      });
    };
  }

  // ======================================================================
  // Judge Court
  // ======================================================================
  // [metric key, label, target test, fmt]  — TARGETS from the API decide the pass line.
  function metricCells(rec, T, kap) {
    const T0 = T || {};
    const pass = {
      position_consistency: (v) => v >= (T0.position ?? 0.9),
      self_pref_rate: (v) => Math.abs(v - 0.5) <= (T0.self_pref_band ?? 0.05),
      lang_consistency: (v) => v >= (T0.lang ?? 0.9),
      verbosity_bias: (v) => v <= (T0.verbosity ?? 0.1),
      kappa: (v) => v >= (T0.kappa ?? 0.6),
      gold: () => null,
    };
    const tgt = { position_consistency: `≥ ${T0.position ?? 0.9}`, self_pref_rate: `0.5 ± ${T0.self_pref_band ?? 0.05}`, lang_consistency: `≥ ${T0.lang ?? 0.9}`, verbosity_bias: `≤ ${T0.verbosity ?? 0.1}`, kappa: `≥ ${T0.kappa ?? 0.6}` };
    const cell = (v, k, extra = "") => { if (v == null || !isFinite(v)) return `<td><span class="lcell na">—</span></td>`; const ok = pass[k](Number(v)); return `<td><span class="lcell ${ok == null ? "na2" : ok ? "good" : "bad"}" title="${K.esc(K.t("ct_target"))} ${K.esc(tgt[k] || "")}">${r2(v)}${extra}</span></td>`; };
    const r = rec || {};
    const kEn = r.kappa_en ?? (kap && kap.en ? kap.en.kappa : null), kAr = r.kappa_ar ?? (kap && kap.ar ? kap.ar.kappa : null);
    return cell(r.position_consistency, "position_consistency") + cell(r.self_pref_rate, "self_pref_rate") + cell(r.lang_consistency, "lang_consistency") + cell(r.verbosity_bias, "verbosity_bias") +
      `<td class="lpair">${kEn == null && kAr == null ? `<span class="lcell na">—</span>` : `<span class="lcell ${kEn == null ? "na" : pass.kappa(kEn) ? "good" : "bad"}" title="EN">${r2(kEn)}</span><span class="lcell ${kAr == null ? "na" : pass.kappa(kAr) ? "good" : "bad"}" title="AR">${r2(kAr)}</span>`}</td>` +
      `<td class="lpair num faint">${r2(r.gold_accuracy_en)} / ${r2(r.gold_accuracy_ar)}</td>`;
  }
  function drawSpark(cv, hist) {
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth || 120, h = cv.clientHeight || 30;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const pts = (hist || []).slice().sort((a, b) => String(a.day).localeCompare(String(b.day))).map((r) => ({ v: Number(r.reliability), b: !!r.benched })).filter((p) => isFinite(p.v));
    c.strokeStyle = "rgba(245,184,61,.12)"; c.lineWidth = 1; c.beginPath(); c.moveTo(0, h - 2); c.lineTo(w, h - 2); c.stroke();
    if (!pts.length) { c.fillStyle = "#6f675a"; c.font = "10px Inter"; c.textAlign = "center"; c.fillText("—", w / 2, h / 2 + 3); return; }
    const X = (i) => (pts.length === 1 ? w / 2 : 3 + (i * (w - 6)) / (pts.length - 1)), Y = (v) => h - 3 - Math.max(0, Math.min(1, v)) * (h - 6);
    const g = c.createLinearGradient(0, 0, w, 0); g.addColorStop(0, "#f5b83d"); g.addColorStop(1, "#e8743b");
    c.beginPath(); pts.forEach((p, i) => (i ? c.lineTo(X(i), Y(p.v)) : c.moveTo(X(i), Y(p.v)))); c.strokeStyle = g; c.lineWidth = 1.8; c.lineJoin = "round"; c.stroke();
    c.lineTo(X(pts.length - 1), h); c.lineTo(X(0), h); c.closePath(); c.fillStyle = "rgba(245,184,61,.08)"; c.fill();
    pts.forEach((p, i) => { if (p.b || i === pts.length - 1) { c.beginPath(); c.arc(X(i), Y(p.v), p.b ? 2.6 : 2.2, 0, Math.PI * 2); c.fillStyle = p.b ? "#ef5b5b" : "#f5b83d"; c.fill(); } });
  }
  async function renderCourt() {
    const { t, esc, nf } = K;
    K.shell("court", t("nav_court"), t("ct_sub"), `<div class="grid g4">${skel(104, 4)}</div><div style="margin-top:16px">${skel(300)}</div><div style="margin-top:16px">${skel(360)}</div>`);
    K.topActions().innerHTML = `<button class="btn sm primary" id="ctProbe">⚖ ${t("ct_probe")}</button>`;
    const [jr, sr, wr] = await Promise.allSettled([K.apiSoft("/api/court/judges?history=14"), K.apiSoft("/api/court/spotchecks?status=open&limit=30"), K.apiSoft("/api/court/weights")]);
    for (const r of [jr, sr, wr]) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason;
    if (jr.status === "rejected") { K.content().innerHTML = K.failCard(jr.reason, "court"); K.bindRetry(K.content(), renderCourt); return; }
    const { judges = [], targets = {}, kappa = {} } = jr.value;
    document.getElementById("ctProbe").onclick = () => openProbe(judges.filter((j) => j.in_panel).map((j) => j.model));
    court.queue = sr.status === "fulfilled" ? (sr.value.spotchecks || []).filter((s) => s.status === "open") : [];
    court.open = sr.status === "fulfilled" ? sr.value.open || court.queue.length : 0;
    const weights = wr.status === "fulfilled" ? { ...(wr.value.weights || {}) } : null;
    // GET /weights without ?models= lists only measured judges; show unmeasured panel judges at the neutral weight the court gives them.
    if (weights) for (const j of judges) if (j.in_panel && !weights[j.model]) weights[j.model] = { weight: 1, reliability: null, benched: false, certified: false, known: false, stale: false, day: null };
    const recs = judges.map((j) => j.record).filter(Boolean);
    K.content().innerHTML = `
      <div class="grid g4">
        ${stat(t("ct_judges"), `<span data-count>${nf(judges.length)}</span>`, `${nf(judges.filter((j) => j.in_panel).length)} ${esc(t("ct_in_panel"))}`)}
        ${stat(t("ct_certified"), `<span data-count>${nf(recs.filter((r) => r.certified).length)}</span>`, "")}
        ${stat(t("ct_benched"), `<span data-count>${nf(recs.filter((r) => r.benched).length)}</span>`, "", recs.some((r) => r.benched) ? "lbad" : "")}
        ${stat(t("ct_open"), `<span data-count id="ctOpenN">${nf(court.open)}</span>`, "", court.open ? "lwarn" : "")}
      </div>
      <section class="card" style="margin-top:16px"><h2>${t("ct_judges")}</h2>
        ${judges.length ? `<div class="tbl-wrap"><table class="table ltbl lcourt"><thead><tr><th>${t("ct_judges")}</th><th>${t("ct_rel")} / ${t("ct_weight")}</th><th title="${esc(t("ct_target"))} ≥ ${targets.position ?? ""}">${t("ct_pos")}</th><th title="0.5 ± ${targets.self_pref_band ?? ""}">${t("ct_self")}</th><th title="≥ ${targets.lang ?? ""}">${t("ct_lang")}</th><th title="≤ ${targets.verbosity ?? ""}">${t("ct_verb")}</th><th title="EN / AR ≥ ${targets.kappa ?? ""}">${t("ct_kappa")} EN·AR</th><th>${t("ct_gold")} EN/AR</th><th>${t("ct_hist")}</th></tr></thead><tbody>
          ${judges.map((j, i) => { const r = j.record; return `<tr class="${r && r.benched ? "lbench" : ""}"><td><div class="mono lmodel" dir="ltr" title="${esc(j.model)}">${esc(j.model)}</div><div class="row lj-b"><span class="tag">${esc(j.family || "")}</span>${j.in_panel ? `<span class="lbadge ok">${esc(t("ct_in_panel"))}</span>` : ""}${r && r.benched ? `<span class="lbadge bad">⛔ ${esc(t("ct_benched"))}</span>` : ""}${r && r.certified ? `<span class="lbadge gold">✓ ${esc(t("ct_certified"))}</span>` : ""}${!r ? `<span class="faint">${esc(t("ct_unmeasured"))}</span>` : ""}</div>${r && (r.reasons || []).length ? `<div class="faint lreasons" dir="auto">${esc(r.reasons.map(reasonText).join(" · "))}</div>` : ""}</td>
            <td>${r ? `${bar(r.reliability)}<div class="faint num">${esc(t("ct_weight"))} ${r2(r.weight)} · ${nf(r.n_probes || 0)} ${esc(t("ct_probes"))}</div>` : "—"}</td>${metricCells(r, targets, kappa[j.model])}<td><canvas class="lspark" data-i="${i}" aria-label="${esc(t("ct_rel"))} · ${esc(t("ct_hist"))}" role="img"></canvas></td></tr>`; }).join("")}
        </tbody></table></div>` : empty(t("ct_no_judges"))}
      </section>
      <section class="card" style="margin-top:16px"><h2>${t("ct_spot")} <span class="hint">${t("ct_spot_hint")}</span></h2><div id="ctSpot"></div></section>
      <div class="grid g2" style="margin-top:16px">
        <section class="card"><h2>${t("ct_kappa_h")}</h2><div id="ctKappa">${kappaView(kappa, targets)}</div></section>
        <section class="card"><h2>${t("ct_weights")}</h2>${weights == null ? K.failCard(wr.reason, "court") : weightsView(weights)}</section>
      </div>`;
    const paintSparks = () => K.content().querySelectorAll("canvas.lspark").forEach((cv) => drawSpark(cv, judges[Number(cv.dataset.i)].history));
    paintSparks();
    if (window.ResizeObserver) { const sec = K.content().querySelector(".lcourt"); if (sec) { court.ro = new ResizeObserver(() => { if (sec.isConnected) paintSparks(); }); court.ro.observe(sec); } }
    K.bindRetry(K.content(), renderCourt);
    paintSpot();
    court.keyOff = bindSpotKeys();
  }
  function kappaView(kappa, T) {
    const { t, esc, nf } = K;
    const rows = Object.values(kappa || {});
    if (!rows.length) return `<div class="empty">${esc(t("ct_no_kappa"))}</div>`;
    const tg = (T && T.kappa) ?? 0.6;
    const k = (x) => { const v = x && x.kappa; const cls = v == null ? "na" : v >= tg ? "good" : v >= tg - 0.2 ? "mid" : "bad"; return `<div class="lkap ${cls}"><b class="num">${r2(v)}</b><span class="faint num">${nf((x && x.n) || 0)} ${esc(t("ct_labels"))}</span></div>`; };
    return `<div class="lkaps">${rows.map((r) => `<div class="lkrow"><div class="mono lmodel" dir="ltr" title="${esc(r.judge)}">${esc(r.judge)}</div><div class="row"><span class="faint">EN</span>${k(r.en)}<span class="faint">AR</span>${k(r.ar)}</div></div>`).join("")}</div><div class="faint lsub">${esc(t("ct_target"))} κ ≥ ${tg}</div>`;
  }
  function weightsView(w) {
    const { t, esc } = K;
    const rows = Object.entries(w || {});
    if (!rows.length) return `<div class="empty">${esc(t("ct_no_weights"))}</div>`;
    const max = Math.max(1, ...rows.map(([, v]) => Number(v.weight) || 0));
    return `<div class="lweights">${rows.sort((a, b) => (b[1].weight || 0) - (a[1].weight || 0)).map(([m, v]) => `<div class="lw"><div class="row"><span class="mono lmodel grow" dir="ltr" title="${esc(m)}">${esc(m)}</span>${v.benched ? `<span class="lbadge bad">⛔ ${esc(t("ct_benched"))}</span>` : ""}${v.certified ? `<span class="lbadge gold">✓</span>` : ""}${!v.known ? `<span class="tag">${esc(t("ct_neutral"))}</span>` : ""}${v.stale ? `<span class="tag">${esc(t("ct_stale"))}</span>` : ""}<b class="num">${r2(v.weight)}</b></div><div class="lwbar ${v.benched ? "off" : ""}"><i style="width:${((Number(v.weight) || 0) / max * 100).toFixed(1)}%"></i></div><div class="faint num">${esc(t("ct_rel"))} ${r2(v.reliability)}${v.day ? ` · ${esc(v.day)}` : ""}</div></div>`).join("")}</div>`;
  }
  function paintSpot(reveal) {
    const { t, esc, nf } = K;
    const box = document.getElementById("ctSpot");
    if (!box) return;
    const s = court.queue[0];
    if (!s) { box.innerHTML = `<div class="empty lspot-empty">${K.HIVE_ART}<div>${esc(t("ct_spot_empty"))}</div></div>`; return; }
    const it = s.item || {};
    const crit = it.criteria == null ? "" : typeof it.criteria === "string" ? it.criteria : JSON.stringify(it.criteria);
    const verdicts = Object.entries(s.judge_verdicts || {});
    box.innerHTML = `
      <div class="row lspot-h"><span class="tag">${esc(s.lang === "ar" ? "AR" : "EN")}</span>${it.probe ? `<span class="tag mono">${esc(it.probe)}</span>` : ""}<span class="faint" dir="auto">${esc(s.reason || "")}</span><span class="spacer"></span><span class="faint num">${nf(Math.max(court.open, court.queue.length))} ${esc(t("ct_remaining"))}</span></div>
      <div class="lspot-task"><h4>${esc(t("ct_task"))}</h4><div dir="auto">${esc(it.task || "")}</div>${crit ? `<div class="faint" dir="auto" style="margin-top:6px"><b>${esc(t("ct_criteria"))}:</b> ${esc(crit.slice(0, 600))}</div>` : ""}</div>
      <div class="lab" dir="ltr"><article class="lans" data-side="A"><header><span class="lab-k">A</span>${esc(t("ct_answer"))} A</header><div class="lans-b" dir="${s.lang === "ar" ? "rtl" : "auto"}">${esc(it.answer_a || "")}</div></article>
        <article class="lans" data-side="B"><header><span class="lab-k">B</span>${esc(t("ct_answer"))} B</header><div class="lans-b" dir="${s.lang === "ar" ? "rtl" : "auto"}">${esc(it.answer_b || "")}</div></article></div>
      ${reveal && verdicts.length ? `<div class="okbox"><b>${esc(t("ct_judges_said"))}:</b> ${verdicts.map(([j, v]) => `<span class="mono">${esc(j)}</span> → <b>${esc(v)}</b>`).join(" · ")}</div>` : ""}
      <div class="row lspot-btns" role="group" aria-label="${esc(t("ct_spot"))}">
        <button class="btn" data-l="A"><kbd>1</kbd> A</button><button class="btn" data-l="B"><kbd>2</kbd> B</button><button class="btn" data-l="tie"><kbd>3</kbd> ${esc(t("ct_tie"))}</button><span class="spacer"></span><button class="btn ghost" data-l="skip"><kbd>0</kbd> ${esc(t("ct_skip"))}</button>
      </div>`;
    box.querySelectorAll("[data-l]").forEach((b) => (b.onclick = () => label(b.dataset.l)));
  }
  let labelling = false;
  async function label(l) {
    const s = court.queue[0];
    if (!s || labelling) return;
    labelling = true;
    const box = document.getElementById("ctSpot");
    const btn = box && box.querySelector(`[data-l="${l}"]`);
    if (btn) btn.classList.add("on");
    if (box && l !== "skip" && l !== "tie") { const side = box.querySelector(`.lans[data-side="${l}"]`); if (side) side.classList.add("won"); }
    try {
      const r = await K.apiSoft("/api/court/spotchecks", { method: "POST", body: { id: s.id, label: l } });
      snd(l === "skip" ? "click" : "done");
      const verdicts = Object.entries((r.spotcheck && r.spotcheck.judge_verdicts) || s.judge_verdicts || {});
      if (l !== "skip" && verdicts.length && box) {
        const agree = verdicts.filter(([, v]) => v === l).length;
        box.insertAdjacentHTML("beforeend", `<div class="okbox lreveal"><b>${K.esc(K.t("ct_judges_said"))}:</b> ${verdicts.map(([j, v]) => `<span class="mono">${K.esc(j)}</span> → <b class="${v === l ? "good" : "bad"}">${K.esc(v)}</b>`).join(" · ")} <span class="faint num">(${agree}/${verdicts.length})</span></div>`);
      }
      const kb = document.getElementById("ctKappa");
      if (kb && r.kappa) kb.innerHTML = kappaView(r.kappa, null);
      court.queue.shift(); court.open = Math.max(0, court.open - 1);
      const n = document.getElementById("ctOpenN"); if (n) n.textContent = K.nf(court.open);
      await new Promise((res) => setTimeout(res, l === "skip" || (window.KFX && KFX.reduced()) ? 150 : 900));
      if (!court.queue.length && court.open > 0) {
        try { const sr = await K.apiSoft("/api/court/spotchecks?status=open&limit=30"); court.queue = (sr.spotchecks || []).filter((x) => x.status === "open"); court.open = sr.open || court.queue.length; } catch {}
      }
      paintSpot();
    } catch (e) { apiErr(e); if (btn) btn.classList.remove("on"); }
    finally { labelling = false; }
  }
  function bindSpotKeys() {
    const map = { 1: "A", 2: "B", 3: "tie", 0: "skip" };
    const h = (e) => {
      if (!onPage("court") || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || "";
      if (/INPUT|TEXTAREA|SELECT/.test(tag) || (e.target && e.target.isContentEditable)) return;
      if (document.querySelector(".modal-wrap,.pal-wrap,.drawer-wrap,.theater-wrap")) return;
      const l = map[e.key];
      if (!l || !court.queue.length) return;
      e.preventDefault(); label(l);
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }
  function openProbe(panel) {
    const { t, esc } = K;
    const body = K.openDrawer(`<div class="dr-head"><span class="tool-ico big" aria-hidden="true">⚖</span><div><h2>${esc(t("ct_probe"))}</h2><div class="faint">${esc(t("ct_sub"))}</div></div></div>
      <form class="lform" id="ctForm">
        <label class="f">${t("ct_f_judges")}</label>${panel.length ? checks("judge", panel, (v) => v) : `<div class="faint">—</div>`}
        <label class="f">${t("ct_f_kinds")}</label>${checks("kind", PROBE_KINDS, (v) => t("pk_" + v))}
        <div class="grid g2"><div><label class="f" for="ctPer">${t("ct_f_per")}</label><input id="ctPer" type="number" min="1" max="40" value="6"/></div>
        <div><label class="f" for="ctCalls">${t("ct_f_calls")}</label><input id="ctCalls" type="number" min="2" max="300" placeholder="—"/></div></div>
        <button class="btn primary block" type="submit" id="ctGo">⚖ ${t("lab_launch")}</button>
      </form>`, t("ct_probe"));
    const f = body.querySelector("#ctForm");
    f.onsubmit = (e) => {
      e.preventDefault();
      const p = { per_judge: Number(body.querySelector("#ctPer").value) || 6 };
      const j = checked(f, "judge"); if (j.length) p.judges = j;
      const k = checked(f, "kind"); if (k.length) p.kinds = k;
      const mc = Number(body.querySelector("#ctCalls").value) || 0; if (mc > 0) p.max_calls = mc;
      K.busy(body.querySelector("#ctGo"), async () => {
        try {
          await K.startJob("/api/court/probe", p, (job) => { if (job.status === "done" && window.KFX) KFX.toast(K.t("ct_probed"), { kind: "ok", sound: false }); if (onPage("court")) renderCourt(); });
          K.closeDrawer();
        } catch (ex) { apiErr(ex); }
      });
    };
  }

  // ---------- wiring into KEXT ----------
  function leave() {
    if (court.keyOff) { court.keyOff(); court.keyOff = null; }
    if (court.ro) { court.ro.disconnect(); court.ro = null; }
  }
  const prevLeave = KEXT.leave, prevInit = KEXT.init;
  Object.assign(KEXT.pages, { redteam: renderRedteam, memory: renderMemory, court: renderCourt });
  KEXT.leave = () => { prevLeave(); leave(); };
  KEXT.init = (k) => {
    K = k;
    Object.assign(k.I, ICONS);
    // nav: after Discovery Lab, before Runs
    if (!k.NAV.some(([n]) => n === "redteam")) {
      const at = Math.max(0, k.NAV.findIndex(([n]) => n === "discovery") + 1) || k.NAV.length;
      k.NAV.splice(at, 0, ["redteam", "nav_redteam"], ["memory", "nav_memory"], ["court", "nav_court"]);
    }
    prevInit(k);
  };
  KEXT.go = Object.assign(KEXT.go || {}, { t: "redteam", b: "memory", c: "court" });
  KEXT.extraCommands = (KEXT.extraCommands || []).concat(() => [
    { id: "rt-launch", label: K.t("rt_launch"), icon: "⚔", run: () => { location.hash = "#/redteam"; setTimeout(openLaunch, 300); } },
    { id: "rt-library", label: K.t("rt_library"), icon: "☰", run: () => { location.hash = "#/redteam"; setTimeout(openLibrary, 300); } },
    { id: "km-new", label: K.t("km_new"), icon: "+", run: () => { location.hash = "#/memory"; setTimeout(openNewDoc, 300); } },
    { id: "km-search", label: K.t("km_search"), icon: "⌕", run: () => { location.hash = "#/memory"; setTimeout(() => { const i = document.getElementById("kmQ"); if (i) i.focus(); }, 400); } },
    { id: "ct-probe", label: K.t("ct_probe"), icon: "⚖", run: () => { location.hash = "#/court"; setTimeout(() => { const b = document.getElementById("ctProbe"); if (b) b.click(); }, 500); } },
    { id: "ct-spot", label: K.t("ct_spot"), icon: "⚖", run: () => { location.hash = "#/court"; setTimeout(() => { const b = document.getElementById("ctSpot"); if (b) b.scrollIntoView({ behavior: KFX.reduced() ? "auto" : "smooth" }); }, 600); } },
  ]);
})();
