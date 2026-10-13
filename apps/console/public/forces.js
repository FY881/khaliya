// Khaliya console — P16 Agent Studio (#/studio, #/studio/<design id>) and the Army (#/army).
// Classic script loaded after labs.js and before app.js. Plugs into window.KEXT (pages, leave, init, go, extraCommands)
// the same way labs.js does, so the router, nav, command palette and g-shortcuts pick these pages up.
(() => {
  "use strict";
  if (!window.KEXT) return;
  let K;
  Object.assign(window.I18N.ar, {
    nav_studio: "استوديو الوكلاء", nav_army: "الجيش",
    job_studio: "تصميم وكلاء", job_mission: "مهمة الجيش",
    nr_body_studio: "واجهة استوديو الوكلاء غير متاحة على الخادم بعد.", nr_body_army: "واجهة الجيش غير متاحة على الخادم بعد.",
    // studio
    st_sub: "موجزات خدمات تتحول إلى وكلاء مُقيَّمين: المهندس يصمم، ثلاثة أذرع تتنافس، والترقية فقط لمن يتفوق بأمان",
    st_design: "صمّم", st_design_all: "صمّم الكل", st_view: "عرض التصميم", st_briefs: "الموجزات", st_promoted: "مُرقّى", st_rejected: "مرفوض", st_failed: "فشل", st_inflight: "قيد العمل", st_none: "لم يُصمَّم بعد",
    st_tasks: "مهام", st_safety_tasks: "أمان", st_safety: "مستوى الأمان", sl_standard: "عادي", sl_elevated: "مرتفع", sl_strict: "صارم",
    ds_designing: "يصمّم", ds_evaluating: "يقيّم", ds_promoted: "مُرقّى", ds_rejected: "مرفوض", ds_failed: "فشل",
    st_all_t: "تصميم كل الموجزات؟", st_all_body: "سيُصمَّم ويُقيَّم كل موجز (حتى ٩٠ استدعاء لكل موجز من حصة المختبر). لا يُنشر شيء للعامة.", st_all_go: "ابدأ التصميم",
    st_started: "بدأ التصميم", st_done: "انتهى التصميم",
    st_detail: "تفاصيل التصميم", st_arms: "الأذرع المتنافسة", st_arm: "الذراع", arm_candidate: "المرشح", arm_strong: "الأساس القوي", arm_weak: "الأساس الضعيف",
    st_cap: "القدرة", st_safe: "الأمان", st_tokens: "الرموز", st_decision: "القرار", st_promote_yes: "تمت الترقية", st_promote_no: "لم يُرقَّ", st_reasons: "الأسباب",
    st_genome: "الجينوم", st_version: "الإصدار", st_architect: "المهندس", st_source: "المصدر", st_items: "مهام التقييم المقبولة", st_items_rej: "مهام مرفوضة", st_outcomes: "النتائج لكل مهمة",
    st_history: "إصدارات هذا الموجز", st_back: "كل الموجزات", st_no_design: "لا تقرير بعد — التصميم لم يكتمل.", st_service: "الخدمة", st_suite: "حزمة التقييم", st_job: "المهمة", st_constitution: "الدستور", st_pass: "نجح", st_fail: "فشل",
    // army
    ar_sub: "تسعة أقسام برتب وجوازات وصلاحيات موقّعة؛ كل مهمة بعقد وخطة تراجع، وكل فعل في سلسلة تدقيق مُجزّأة",
    ar_divisions: "الأقسام", ar_agents: "الجنود", ar_passports: "الجوازات الحية", ar_caps: "الصلاحيات الحية", ar_incidents: "حوادث ٧ أيام", ar_missions: "المهام",
    ar_tier_cap: "سقف الطبقة", ar_draft_only: "مسودات فقط فوق السقف", ar_planned: "أدوار مخطّطة", ar_ranks: "الرتب", ar_ladder: "سلّم الاستقلالية",
    ar_no_missions: "لا مهام بعد.", ar_no_passports: "لا جوازات صادرة بعد.", ar_no_caps: "لا صلاحيات صادرة بعد.", ar_goal: "الهدف", ar_autonomy: "الاستقلالية", ar_risk: "الخطر", ar_class: "صنف الفعل",
    ar_matrix: "مصفوفة الموافقات", ar_matrix_hint: "من يوافق على كل صنف فعل عند كل مستوى خطر", ar_forbidden: "ممنوع", ar_two_key: "مفتاحان", ar_step_up: "رمز TOTP جديد",
    ar_audit: "سلسلة التدقيق", ar_verify: "تحقّق من السلسلة", ar_chain_ok: "السلسلة سليمة", ar_chain_bad: "السلسلة مكسورة", ar_checked: "قيود مفحوصة", ar_head: "الرأس", ar_recent: "أحدث القيود", ar_no_audit: "لا قيود بعد.",
    ar_kill: "مفاتيح الإيقاف", ar_kill_ro: "عرض فقط — التحكم من صفحة الإيقاف", ar_kill_org: "المنظمة", ar_kill_div: "أقسام", ar_kill_msn: "مهام", ar_kill_agents: "وكلاء", ar_on: "مُفعّل", ar_off: "مُطفأ",
    ar_rank: "الرتبة", ar_division: "القسم", ar_expires: "ينتهي", ar_revoked: "ملغى", ar_live: "حي", ar_calls: "استدعاءات", ar_tools: "الأدوات", ar_mission: "المهمة", ar_revocations: "قائمة الإلغاء",
    pr_operator: "مشغّل", pr_support: "دعم", pr_onboarding: "تهيئة العملاء", pr_compliance: "امتثال", pr_redteam: "الفريق الأحمر", pr_blueteam: "الفريق الأزرق", pr_forensics: "تحقيق جنائي", pr_finance: "مالية", pr_teacher: "معلّم",
    ms_draft: "مسودة", ms_approved: "معتمدة", ms_running: "تعمل", ms_verifying: "تحقّق", ms_done: "اكتملت", ms_failed: "فشلت", ms_rolled_back: "تراجع",
    ap_auto: "تلقائي", ap_court: "المحكمة", ap_security_council: "مجلس الأمن", ap_owner: "المالك", ap_customer: "العميل", ap_human_lawyer: "محامٍ",
    ac_think_memory: "تفكير وذاكرة", ac_sandbox_code: "كود في الحاوية", ac_evolution: "التطور", ac_customer_reply: "رد على عميل", ac_customer_action: "فعل للعميل", ac_external_comms: "تواصل خارجي", ac_money: "المال", ac_publish: "النشر", ac_data_export: "تصدير بيانات", ac_external_read: "قراءة خارجية", ac_constitution: "الدستور", ac_bylaws_change: "تعديل اللوائح", ac_core_change: "تعديل النواة",
  });
  Object.assign(window.I18N.en, {
    nav_studio: "Agent Studio", nav_army: "The Army",
    job_studio: "Studio design", job_mission: "Army mission",
    nr_body_studio: "The Agent Studio API is not on the server yet.", nr_body_army: "The Army API is not on the server yet.",
    st_sub: "Service briefs become evaluated agents: the architect designs, three arms compete, and only a safe winner is promoted",
    st_design: "Design", st_design_all: "Design all", st_view: "View design", st_briefs: "Briefs", st_promoted: "Promoted", st_rejected: "Rejected", st_failed: "Failed", st_inflight: "In flight", st_none: "not designed yet",
    st_tasks: "tasks", st_safety_tasks: "safety", st_safety: "Safety level", sl_standard: "Standard", sl_elevated: "Elevated", sl_strict: "Strict",
    ds_designing: "Designing", ds_evaluating: "Evaluating", ds_promoted: "Promoted", ds_rejected: "Rejected", ds_failed: "Failed",
    st_all_t: "Design every brief?", st_all_body: "Each brief is designed and evaluated (up to 90 calls per brief from the lab share). Nothing is published.", st_all_go: "Start designing",
    st_started: "Design started", st_done: "Design finished",
    st_detail: "Design detail", st_arms: "Competing arms", st_arm: "Arm", arm_candidate: "Candidate", arm_strong: "Strong baseline", arm_weak: "Weak baseline",
    st_cap: "Capability", st_safe: "Safety", st_tokens: "Tokens", st_decision: "Decision", st_promote_yes: "Promoted", st_promote_no: "Not promoted", st_reasons: "Reasons",
    st_genome: "Genome", st_version: "Version", st_architect: "Architect", st_source: "Source", st_items: "Admitted eval tasks", st_items_rej: "Rejected tasks", st_outcomes: "Per-task outcomes",
    st_history: "Versions of this brief", st_back: "All briefs", st_no_design: "No report yet — the design has not finished.", st_service: "Service", st_suite: "suite", st_job: "job", st_constitution: "constitution", st_pass: "pass", st_fail: "fail",
    ar_sub: "Nine divisions with ranks, passports and signed capabilities; every mission has a contract and a rollback plan, every act lands in a hash-chained audit",
    ar_divisions: "Divisions", ar_agents: "Soldiers", ar_passports: "Live passports", ar_caps: "Live capabilities", ar_incidents: "Incidents (7d)", ar_missions: "Missions",
    ar_tier_cap: "Tier cap", ar_draft_only: "drafts only above cap", ar_planned: "Planned roles", ar_ranks: "Ranks", ar_ladder: "Autonomy ladder",
    ar_no_missions: "No missions yet.", ar_no_passports: "No passports issued yet.", ar_no_caps: "No capabilities issued yet.", ar_goal: "Goal", ar_autonomy: "Autonomy", ar_risk: "Risk", ar_class: "Action class",
    ar_matrix: "Approval matrix", ar_matrix_hint: "who approves each action class at each risk tier", ar_forbidden: "forbidden", ar_two_key: "two-key", ar_step_up: "fresh TOTP",
    ar_audit: "Audit chain", ar_verify: "Verify chain", ar_chain_ok: "Chain intact", ar_chain_bad: "Chain broken", ar_checked: "entries checked", ar_head: "Head", ar_recent: "Recent entries", ar_no_audit: "No entries yet.",
    ar_kill: "Kill switches", ar_kill_ro: "read-only — control them from the Kill page", ar_kill_org: "Org", ar_kill_div: "Divisions", ar_kill_msn: "Missions", ar_kill_agents: "Agents", ar_on: "on", ar_off: "off",
    ar_rank: "Rank", ar_division: "Division", ar_expires: "Expires", ar_revoked: "revoked", ar_live: "live", ar_calls: "calls", ar_tools: "Tools", ar_mission: "Mission", ar_revocations: "Revocation list",
    ms_draft: "Draft", ms_approved: "Approved", ms_running: "Running", ms_verifying: "Verifying", ms_done: "Done", ms_failed: "Failed", ms_rolled_back: "Rolled back",
    ap_auto: "auto", ap_court: "Court", ap_security_council: "Security council", ap_owner: "Owner", ap_customer: "Customer", ap_human_lawyer: "Lawyer",
    ac_think_memory: "Think & memory", ac_sandbox_code: "Sandbox code", ac_evolution: "Evolution", ac_customer_reply: "Customer reply", ac_customer_action: "Customer action", ac_external_comms: "External comms", ac_money: "Money", ac_publish: "Publish", ac_data_export: "Data export", ac_external_read: "External read", ac_constitution: "Constitution", ac_bylaws_change: "Bylaws change", ac_core_change: "Core change",
  });

  // Arabic fallbacks for English prose the API may send without an *_ar twin (older deploys, matrix notes).
  const AR_TXT = {
    "code, Forge tools, Studio agent design": "البرمجة، أدوات المصهر، وتصميم وكلاء الاستوديو",
    "cited research, KB, summaries (external read with approval)": "بحث موثّق بالمصادر، قاعدة المعرفة، والملخّصات (القراءة الخارجية بموافقة)",
    "customer errands: drafts, sheets, files — customer presses execute": "مهام العملاء: مسودات وجداول وملفات — والعميل هو من يضغط تنفيذ",
    "answer customers; never promise prices/refunds outside policy": "الرد على العملاء؛ دون وعود بأسعار أو استرداد خارج السياسة أبدًا",
    "review legal texts, RoPA, deadlines; no legal advice to customers": "مراجعة النصوص القانونية وسجل المعالجة والمواعيد؛ دون تقديم استشارة قانونية للعملاء",
    "attack, defend, investigate (sandbox)": "هجوم ودفاع وتحقيق (داخل الحاوية)",
    "read-only revenue/cost/margins; any money movement = two-key": "قراءة فقط للإيرادات والتكاليف والهوامش؛ وأي حركة مال = مفتاحان",
    "evaluate, judge, audit (protected lineages, art. 6)": "تقييم وتحكيم وتدقيق (سلالات محمية، المادة 6)",
    "turn failure lessons into playbooks and drills": "تحويل دروس الإخفاق إلى أدلة عمل وتدريبات",
    "inside the tenant": "داخل المستأجر", "admission": "القبول", "automatic gate": "بوابة تلقائية", "gate + canary": "بوابة + إطلاق تجريبي", "gate + red-team + judge": "بوابة + فريق أحمر + قاضٍ",
    "L3 + DLP": "L3 + منع تسرّب البيانات", "draft only": "مسودة فقط", "customer consent + security": "موافقة العميل + الأمن", "customer + owner": "العميل + المالك",
    "legal agent + owner": "الوكيل القانوني + المالك", "owner + TOTP": "المالك + TOTP",
    "finance prepares, owner signs with TOTP": "المالية تُحضّر، والمالك يوقّع برمز TOTP", "security + legal + owner": "الأمن + القانون + المالك",
    "customer DSAR + owner": "طلب وصول العميل لبياناته + المالك", "compliance + security + owner": "الامتثال + الأمن + المالك",
  };
  // prefer the server's *_ar field, then the local map, then the English text
  const loc = (o, f) => (!o ? "" : ar() ? o[f + "_ar"] || AR_TXT[o[f]] || o[f] || "" : o[f] || "");
  const locS = (s) => (s && ar() ? AR_TXT[s] || s : s || "");
  let DIVS = [];
  const divName = (id) => { const d = DIVS.find((x) => x.id === id); return d ? (ar() ? d.name_ar || d.name_en : d.name_en || d.name_ar) : id; };
  const prLabel = (r) => K.tOr("pr_" + r, K.tOr("role_" + r, r));

  const ICONS = {
    studio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M9 12l2 2 4-4"/></svg>',
    army: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 8l8-5 8 5M4 13l8-5 8 5M4 18l8-5 8 5"/></svg>',
  };
  const ARMS = ["candidate", "strong", "weak"];
  const RANKS = ["R0", "R1", "R2", "R3", "R4"];
  const ar = () => K.state.lang === "ar";
  const onPage = (p) => (location.hash || "").replace(/^#\//, "").split(/[/?]/)[0] === p;
  const skel = (h, n = 1) => `<div class="skeleton" style="height:${h}px"></div>`.repeat(n);
  const pct = (x) => (x == null || !isFinite(x) ? "—" : Math.round(Number(x) * 100) + "%");
  const tone = (p) => (p == null || !isFinite(p) ? "na" : p >= 0.9 ? "good" : p >= 0.7 ? "mid" : "bad");
  const bar = (p) => (p == null || !isFinite(p) ? `<span class="faint">—</span>` : `<div class="lbar ${tone(p)}" dir="ltr"><i style="width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></i><span class="num">${pct(p)}</span></div>`);
  const ltr = (s) => `<span dir="ltr" class="num">${s}</span>`;
  const stat = (label, value, sub, cls = "") => `<div class="card stat ${cls}"><div class="label">${K.esc(label)}</div><div class="value">${value}</div>${sub ? `<div class="faint lsub">${sub}</div>` : ""}</div>`;
  const dsBadge = (s) => `<span class="lbadge fs-${K.esc(s)}">${K.esc(K.tOr("ds_" + s, s))}</span>`;
  const msBadge = (s) => `<span class="lbadge fm-${K.esc(s)}">${K.esc(K.tOr("ms_" + s, s))}</span>`;
  const slBadge = (s) => `<span class="lbadge fl-${K.esc(s || "standard")}" title="${K.esc(K.t("st_safety"))}">${K.esc(K.tOr("sl_" + s, s || "—"))}</span>`;
  const apLabel = (a) => K.tOr("ap_" + a, a);
  const acLabel = (a) => K.tOr("ac_" + a, a);
  const rate = (p, n) => (n ? p / n : null);
  function apiErr(e) {
    if (e && e.data && (e.data.error || e.data.message)) return K.toast(e.data.error || e.data.message, true);
    K.actErr(e);
  }
  const firstAuth = (rs) => { for (const r of rs) if (r.status === "rejected" && r.reason instanceof K.AuthError) throw r.reason; };

  // ======================================================================
  // Agent Studio
  // ======================================================================
  async function renderStudio(designId) {
    if (designId) return renderDesign(designId);
    const { t, esc, nf } = K;
    K.shell("studio", t("nav_studio"), t("st_sub"), `<div class="grid g4">${skel(104, 4)}</div><div class="grid g3" style="margin-top:16px">${skel(220, 6)}</div>`);
    K.topActions().innerHTML = `<button class="btn sm primary" id="stAll">✦ ${t("st_design_all")}</button>`;
    document.getElementById("stAll").onclick = designAll;
    const [br] = await Promise.allSettled([K.apiSoft("/api/studio/briefs")]);
    firstAuth([br]);
    if (br.status === "rejected") { K.content().innerHTML = K.failCard(br.reason, "studio"); K.bindRetry(K.content(), () => renderStudio()); return; }
    const briefs = br.value.briefs || [];
    const by = (s) => briefs.filter((b) => b.latest_design && b.latest_design.status === s).length;
    const inflight = by("designing") + by("evaluating");
    K.content().innerHTML = `
      <div class="grid g4">
        ${stat(t("st_briefs"), `<span data-count>${nf(briefs.length)}</span>`, `${nf(briefs.filter((b) => b.safety_level === "strict").length)} ${esc(t("sl_strict"))} · ${nf(briefs.reduce((a, b) => a + (b.tasks || 0), 0))} ${esc(t("st_tasks"))}`)}
        ${stat(t("st_promoted"), `<span data-count>${nf(by("promoted"))}</span>`, "", by("promoted") ? "" : "")}
        ${stat(t("st_rejected"), `<span data-count>${nf(by("rejected") + by("failed"))}</span>`, `${nf(by("failed"))} ${esc(t("st_failed"))}`)}
        ${stat(t("st_inflight"), `<span data-count>${nf(inflight)}</span>`, `${nf(briefs.filter((b) => !b.latest_design).length)} ${esc(t("st_none"))}`)}
      </div>
      <div class="sbriefs" style="margin-top:16px">${briefs.map(briefCard).join("") || `<div class="card empty">—</div>`}</div>`;
    K.content().querySelectorAll("[data-design]").forEach((b) => (b.onclick = () => designOne(b.dataset.design, b)));
    K.bindRetry(K.content(), () => renderStudio());
  }
  function briefCard(b) {
    const { t, esc, nf } = K;
    const d = b.latest_design;
    const title = ar() ? b.title_ar || b.title : b.title || b.title_ar;
    const purpose = ar() ? b.purpose_ar || b.purpose : b.purpose || b.purpose_ar;
    return `<article class="card sbrief">
      <div class="row sb-h"><span class="hex xs">${esc(K.glyph(b.role))}</span><b dir="auto" class="sb-t">${esc(title)}</b></div>
      <div class="faint sb-p" dir="auto">${esc(purpose || "")}</div>
      <div class="row sb-m"><span class="tag">${esc(K.roleLabel(b.role))}</span>${slBadge(b.safety_level)}<span class="faint">${ltr(nf(b.tasks || 0))} ${esc(t("st_tasks"))} · ${ltr(nf(b.safety_tasks || 0))} ${esc(t("st_safety_tasks"))}</span></div>
      <div class="row sb-f">${d ? `${dsBadge(d.status)}<span class="faint">v${ltr(nf(d.version))} · ${esc(K.ago(d.updated_at))}</span>` : `<span class="faint">${esc(t("st_none"))}</span>`}<span class="spacer"></span>
        ${d ? `<a class="btn sm ghost" href="#/studio/${encodeURIComponent(d.id)}">${esc(t("st_view"))}</a>` : ""}<button class="btn sm" data-design="${esc(b.id)}">✦ ${esc(t("st_design"))}</button></div>
      <div class="mono faint sb-id" dir="ltr">${esc(b.id)}</div>
    </article>`;
  }
  function onDesignDone(job) {
    if (window.KFX && job && job.status === "done") KFX.toast(K.t("st_done"), { kind: "ok", sound: false });
    if (onPage("studio")) renderStudio((location.hash.split("/")[2] || "").split("?")[0] ? decodeURIComponent(location.hash.split("/")[2].split("?")[0]) : undefined);
  }
  function designOne(id, btn) {
    K.busy(btn, async () => {
      try { await K.startJob(`/api/studio/briefs/${encodeURIComponent(id)}/design`, {}, onDesignDone); K.toast(K.t("st_started")); setTimeout(() => onPage("studio") && renderStudio(), 1500); } catch (e) { apiErr(e); }
    });
  }
  async function designAll() {
    const { t, esc } = K;
    const ok = await K.dialog({ title: t("st_all_t"), body: esc(t("st_all_body")), confirm: t("st_all_go") });
    if (!ok) return;
    try { await K.startJob("/api/studio/design-all", {}, onDesignDone); K.toast(t("st_started")); setTimeout(() => onPage("studio") && renderStudio(), 1500); } catch (e) { apiErr(e); }
  }

  async function renderDesign(id) {
    const { t, esc, nf } = K;
    K.shell("studio", t("st_detail"), t("st_sub"), `${skel(120)}<div class="grid g2" style="margin-top:16px">${skel(260, 2)}</div>`);
    K.topActions().innerHTML = `<a class="btn sm" href="#/studio">← ${t("st_back")}</a>`;
    const [dr, br] = await Promise.allSettled([K.apiSoft(`/api/studio/designs/${encodeURIComponent(id)}`), K.apiSoft("/api/studio/designs")]);
    firstAuth([dr, br]);
    if (dr.status === "rejected") { K.content().innerHTML = K.failCard(dr.reason, "studio"); K.bindRetry(K.content(), () => renderDesign(id)); return; }
    const d = dr.value.design;
    const rep = d.report || {};
    const sc = rep.scores || {};
    const dec = rep.decision || d.decision || null;
    const hist = br.status === "fulfilled" ? (br.value.designs || []).filter((x) => x.brief_id === d.brief_id).sort((a, b) => b.version - a.version) : [];
    const arch = rep.architect || {};
    const items = rep.items || [], rej = rep.rejected_items || [], outs = rep.outcomes || [];
    const armRow = (a) => {
      const s = sc[a];
      const dd = dec && dec[a];
      const cap = dd ? dd.cap_rate : s ? rate(s.cap_pass, s.cap_n) : null;
      const saf = dd ? dd.safety_rate : s ? rate(s.safety_pass, s.safety_n) : null;
      return `<tr class="${a === "candidate" ? "sarm-c" : ""}"><td><b>${esc(t("arm_" + a))}</b></td>
        <td>${bar(cap)}${s ? `<div class="faint">${ltr(`${nf(s.cap_pass)}/${nf(s.cap_n)}`)}</div>` : ""}</td>
        <td>${bar(saf)}${s ? `<div class="faint">${ltr(`${nf(s.safety_pass)}/${nf(s.safety_n)}`)}</div>` : ""}</td>
        <td class="num" dir="ltr">${s ? nf(s.tokens) : "—"}</td></tr>`;
    };
    const keys = [...new Set(outs.map((o) => o.key))];
    const outTable = keys.length ? `<div class="tbl-wrap"><table class="table ltbl"><thead><tr><th>${t("st_tasks")}</th>${ARMS.map((a) => `<th>${esc(t("arm_" + a))}</th>`).join("")}</tr></thead><tbody>${keys.map((k) => `<tr><td class="mono" dir="ltr">${esc(k)}${(items.find((i) => i.key === k) || {}).kind === "safety" ? ` <span class="lbadge fl-strict">${esc(t("st_safety_tasks"))}</span>` : ""}</td>${ARMS.map((a) => { const o = outs.find((x) => x.key === k && x.arm === a); return `<td>${o ? `<span class="lcell ${o.pass ? "good" : "bad"}">${o.pass ? "✓" : "✕"}</span>` : `<span class="lcell na">—</span>`}</td>`; }).join("")}</tr>`).join("")}</tbody></table></div>` : `<div class="empty">—</div>`;
    K.content().innerHTML = `
      <section class="card sdes-h">
        <div class="row" style="gap:10px;flex-wrap:wrap">${dsBadge(d.status)}<b class="mono" dir="ltr">${esc(d.brief_id)}</b><span class="faint">${esc(t("st_version"))} ${ltr("v" + nf(d.version))}</span><span class="spacer"></span><span class="faint" title="${esc(K.when(d.updated_at))}">${esc(K.ago(d.updated_at))}</span></div>
        <div class="faint sdes-ids" dir="ltr"><span>${esc(t("st_genome"))}: <span class="mono">${esc(d.genome_id || "—")}</span></span><span>${esc(t("st_suite"))}: <span class="mono">${esc(d.suite_id || "—")}</span></span><span>${esc(t("st_job"))}: <span class="mono">${esc(d.job_id || "—")}</span></span>${d.promoted ? `<span>${esc(t("st_service"))}: <span class="mono">${esc(d.promoted.service_slug || "")}</span></span>` : ""}</div>
      </section>
      <div class="grid lcols" style="margin-top:16px">
        <section class="card"><h2>${t("st_arms")}</h2>${sc.candidate || dec ? `<div class="tbl-wrap"><table class="table ltbl"><thead><tr><th>${t("st_arm")}</th><th>${t("st_cap")}</th><th>${t("st_safe")}</th><th>${t("st_tokens")}</th></tr></thead><tbody>${ARMS.map(armRow).join("")}</tbody></table></div>` : `<div class="empty">${esc(t("st_no_design"))}</div>`}</section>
        <section class="card sdec ${dec ? (dec.promote ? "yes" : "no") : ""}"><h2>${t("st_decision")}</h2>
          ${dec ? `<div class="sdec-v">${dec.promote ? "✓ " + esc(t("st_promote_yes")) : "✕ " + esc(t("st_promote_no"))}</div>
          <h4>${esc(t("st_reasons"))}</h4><ul class="sdec-r">${(dec.reasons || []).map((r) => `<li dir="auto">${esc(r)}</li>`).join("") || "<li>—</li>"}</ul>` : `<div class="empty">${esc(t("st_no_design"))}</div>`}
          <h4>${esc(t("st_architect"))}</h4><div class="faint">${esc(t("st_source"))}: <span class="mono">${esc(arch.source || "—")}</span>${arch.check ? ` · ${arch.check.ok ? "✓" : "✕"} ${esc(t("st_constitution"))}` : ""}</div>${arch.note ? `<div class="lquote" dir="auto">${esc(arch.note)}</div>` : ""}
        </section>
      </div>
      <section class="card" style="margin-top:16px"><h2>${t("st_outcomes")} <span class="hint">${nf(items.length)} ${esc(t("st_items"))}${rej.length ? ` · ${nf(rej.length)} ${esc(t("st_items_rej"))}` : ""}</span></h2>${outTable}
        ${rej.length ? `<div class="lmini" style="margin-top:10px">${rej.map((r) => `<div class="row"><span class="mono" dir="ltr">${esc(r.key)}</span><span class="spacer"></span><span class="faint" dir="auto">${esc(r.reason || "")}</span></div>`).join("")}</div>` : ""}</section>
      ${hist.length > 1 ? `<section class="card" style="margin-top:16px"><h2>${t("st_history")}</h2><div class="lmini">${hist.map((h) => `<div class="row"><a href="#/studio/${encodeURIComponent(h.id)}">v${ltr(nf(h.version))}</a>${dsBadge(h.status)}<span class="faint mono" dir="ltr">${esc(K.short(h.genome_id || ""))}</span><span class="spacer"></span><span class="faint">${esc(K.ago(h.updated_at))}</span></div>`).join("")}</div></section>` : ""}`;
  }

  // ======================================================================
  // The Army
  // ======================================================================
  async function renderArmy() {
    const { t, esc, nf } = K;
    K.shell("army", t("nav_army"), t("ar_sub"), `<div class="grid g4">${skel(104, 4)}</div><div class="grid g3" style="margin-top:16px">${skel(170, 9)}</div>`);
    K.topActions().innerHTML = `<button class="btn sm" id="arVerify">✓ ${t("ar_verify")}</button>`;
    document.getElementById("arVerify").onclick = (e) => verify(e.currentTarget);
    const rs = await Promise.allSettled([
      K.apiSoft("/api/army/overview"), K.apiSoft("/api/army/matrix"), K.apiSoft("/api/army/missions?limit=30"),
      K.apiSoft("/api/army/passports"), K.apiSoft("/api/army/capabilities"), K.apiSoft("/api/army/audit?limit=12"),
    ]);
    firstAuth(rs);
    const [ov, mx, ms, pp, cp, au] = rs;
    if (ov.status === "rejected") { K.content().innerHTML = K.failCard(ov.reason, "army"); K.bindRetry(K.content(), renderArmy); return; }
    const o = ov.value, C = o.counts || {}, kill = o.kill || {};
    DIVS = o.divisions || [];
    const missions = ms.status === "fulfilled" ? ms.value.missions || [] : [];
    const mcount = Object.values(C.missions || {}).reduce((a, b) => a + (Number(b) || 0), 0) || missions.length;
    K.content().innerHTML = `
      <div class="grid g4">
        ${stat(t("ar_agents"), `<span data-count>${nf(C.agents || 0)}</span>`, `${nf((o.divisions || []).length)} ${esc(t("ar_divisions"))}`)}
        ${stat(t("ar_passports"), `<span data-count>${nf(C.live_passports || 0)}</span>`, `${nf(C.live_capabilities || 0)} ${esc(t("ar_caps"))}`)}
        ${stat(t("ar_missions"), `<span data-count>${nf(mcount)}</span>`, Object.entries(C.missions || {}).map(([k, v]) => `${esc(K.tOr("ms_" + k, k))} ${nf(v)}`).join(" · "))}
        ${stat(t("ar_incidents"), `<span data-count>${nf(C.incidents_7d || 0)}</span>`, `${esc(t("ar_kill"))}: ${kill.org ? `<b class="bad">${esc(t("ar_kill_org"))} ${esc(t("ar_on"))}</b>` : esc(t("ar_off"))}`, C.incidents_7d ? "lwarn" : "")}
      </div>
      <h3 class="fsec">${t("ar_divisions")}</h3>
      <div class="adivs">${(o.divisions || []).map(divCard).join("")}</div>
      <div class="grid lcols" style="margin-top:16px">
        <section class="card"><h2>${t("ar_missions")}</h2>${missionTable(missions)}</section>
        <section class="card"><h2>${t("ar_kill")} <span class="hint">${t("ar_kill_ro")}</span></h2>${killView(kill, o.divisions || [])}</section>
      </div>
      <section class="card" style="margin-top:16px"><h2>${t("ar_matrix")} <span class="hint">${t("ar_matrix_hint")}</span></h2>${mx.status === "fulfilled" ? matrixTable(mx.value) : K.failCard(mx.reason, "army")}</section>
      <div class="grid g2" style="margin-top:16px">
        <section class="card"><h2>${t("ar_ranks")}</h2>${ranksView(o.ranks || [])}</section>
        <section class="card"><h2>${t("ar_ladder")}</h2>${ladderView(o.ladder || [])}</section>
      </div>
      <div class="grid g2" style="margin-top:16px">
        <section class="card"><h2>${t("ar_passports")}</h2>${pp.status === "fulfilled" ? passportTable(pp.value.passports || []) : K.failCard(pp.reason, "army")}</section>
        <section class="card"><h2>${t("ar_caps")}</h2>${cp.status === "fulfilled" ? capTable(cp.value) : K.failCard(cp.reason, "army")}</section>
      </div>
      <section class="card" style="margin-top:16px" id="arAudit"><h2>${t("ar_audit")}<span class="spacer"></span><button class="btn sm" id="arVerify2">✓ ${t("ar_verify")}</button></h2><div id="arChain" class="achain faint">—</div>
        ${au.status === "fulfilled" ? auditList(au.value.entries || []) : K.failCard(au.reason, "army")}</section>`;
    document.getElementById("arVerify2").onclick = (e) => verify(e.currentTarget);
    K.bindRetry(K.content(), renderArmy);
  }
  function divCard(d) {
    const { t, esc, nf } = K;
    const max = Math.max(1, ...RANKS.map((r) => (d.counts || {})[r] || 0));
    return `<article class="card adiv">
      <div class="row"><b dir="auto">${esc(ar() ? d.name_ar || d.name_en : d.name_en || d.name_ar)}</b><span class="spacer"></span><span class="lbadge" dir="ltr" title="${esc(t("ar_tier_cap"))}">T≤${nf(d.tier_cap)}</span></div>
      <div class="faint adiv-m" dir="auto">${esc(loc(d, "mission"))}</div>
      <div class="aranks" dir="ltr">${RANKS.map((r) => { const n = (d.counts || {})[r] || 0; return `<div class="ark ${n ? "on" : ""}" title="${esc(r)}: ${nf(n)}"><i style="height:${Math.round((n / max) * 100)}%"></i><span>${r}</span><b>${nf(n)}</b></div>`; }).join("")}</div>
      <div class="row adiv-f"><span class="faint">${esc(t("ar_agents"))} ${ltr(nf(d.total || 0))}</span>${d.draft_only_above_cap ? `<span class="tag">${esc(t("ar_draft_only"))}</span>` : ""}${(d.planned_roles || []).length ? `<span class="tag" title="${esc(t("ar_planned"))}" dir="auto">+${esc(d.planned_roles.map(prLabel).join(ar() ? "، " : ", "))}</span>` : ""}</div>
    </article>`;
  }
  function missionTable(list) {
    const { t, esc, nf } = K;
    if (!list.length) return `<div class="empty">${esc(t("ar_no_missions"))}</div>`;
    return `<div class="tbl-wrap"><table class="table ltbl"><thead><tr><th>${t("ar_goal")}</th><th>${t("col_status")}</th><th>${t("ar_autonomy")} · ${t("ar_risk")}</th><th>${t("col_when")}</th></tr></thead><tbody>
      ${list.map((m) => `<tr><td><div class="mgoal" dir="auto" title="${esc(m.goal)}">${esc(m.goal)}</div><div class="mono faint" dir="ltr">${esc(K.short(m.id))}${m.job_id ? ` · ${esc(K.short(m.job_id))}` : ""}</div></td><td>${msBadge(m.status)}</td><td><span class="mono" dir="ltr">${esc(m.autonomy)} · R${nf(m.risk_tier)}</span><div class="faint">${esc(acLabel(m.action_class))}</div></td><td class="faint nowrap">${esc(K.ago(m.updated_at || m.created_at))}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  function matrixTable(v) {
    const { t, esc } = K;
    const rows = v.matrix || [];
    if (!rows.length) return `<div class="empty">—</div>`;
    const risks = [0, 1, 2, 3, 4];
    return `<div class="tbl-wrap"><table class="table amatrix"><thead><tr><th>${t("ar_class")}</th>${risks.map((r) => `<th class="num" dir="ltr">R${r}</th>`).join("")}</tr></thead><tbody>
      ${rows.map((r) => `<tr><td><b>${esc(acLabel(r.action_class))}</b>${r.two_key ? ` <span class="lbadge fk">${esc(t("ar_two_key"))}</span>` : ""}<div class="mono faint" dir="ltr">${esc(r.action_class)}</div></td>
        ${risks.map((k) => { const c = (r.cells || []).find((x) => x.risk === k) || {}; if (!c.approvers) return `<td class="amx-no"><span>${esc(t("ar_forbidden"))}</span></td>`; return `<td class="amx ${c.approvers.length === 1 && c.approvers[0] === "auto" ? "auto" : ""}"><div>${c.approvers.map((a) => `<span class="amx-a">${esc(apLabel(a))}</span>`).join(" + ")}</div><div class="amx-f">${c.two_key ? `<span class="amx-k">${esc(t("ar_two_key"))}</span>` : ""}${c.step_up ? `<span class="amx-k su" dir="ltr">TOTP</span>` : ""}</div>${c.note ? `<div class="faint amx-n" dir="auto">${esc(locS(c.note))}</div>` : ""}</td>`; }).join("")}</tr>`).join("")}
    </tbody></table></div><div class="faint lsub"><span class="amx-k">${esc(t("ar_two_key"))}</span> <span class="amx-k su" dir="ltr">TOTP</span> ${esc(t("ar_step_up"))} · <span dir="ltr">L5 ≤ ${esc(String(v.l5_max_days ?? 7))}d</span></div>`;
  }
  function ranksView(ranks) {
    const { esc } = K;
    return `<div class="lmini">${ranks.map((r) => `<div class="row"><span class="lbadge" dir="ltr">${esc(r.rank)}</span><b dir="auto">${esc(ar() ? r.name_ar : r.name_en)}</b><span class="mono faint" dir="ltr">≤${esc(r.max_autonomy)}</span><span class="spacer"></span><span class="faint arule" dir="auto">${esc(loc(r, "rule"))}</span></div>`).join("")}</div>`;
  }
  function ladderView(l) {
    const { esc } = K;
    return `<div class="lmini">${l.map((x) => `<div class="row"><span class="lbadge ${x.owner_only ? "bad" : ""}" dir="ltr">${esc(x.level)}</span><b dir="auto">${esc(ar() ? x.name_ar : x.name_en)}</b><span class="spacer"></span><span class="faint arule" dir="auto" title="${esc((ar() ? "يحتاج موافقة: " : "needs approval: ") + loc(x, "needs_approval"))}">${esc(loc(x, "without_approval"))}</span></div>`).join("")}</div>`;
  }
  function passportTable(list) {
    const { t, esc } = K;
    if (!list.length) return `<div class="empty">${esc(t("ar_no_passports"))}</div>`;
    return `<div class="tbl-wrap"><table class="table ltbl"><thead><tr><th>${t("col_agent")}</th><th>${t("ar_rank")}</th><th>${t("ar_division")}</th><th>${t("ar_autonomy")}</th><th>${t("ar_expires")}</th></tr></thead><tbody>
      ${list.map((p) => `<tr><td class="mono" dir="ltr">${esc(K.short(p.agent_id))}</td><td dir="ltr">${esc(p.rank)}</td><td dir="auto">${esc(divName(p.division))}</td><td class="mono" dir="ltr">${esc(p.autonomy)}</td><td>${p.revoked_at ? `<span class="lbadge bad">${esc(t("ar_revoked"))}</span>` : p.expires_at < Date.now() ? `<span class="faint">${esc(K.ago(p.expires_at))}</span>` : `<span class="lbadge ok">${esc(t("ar_live"))}</span> <span class="faint">${esc(K.when(p.expires_at))}</span>`}</td></tr>`).join("")}
    </tbody></table></div>`;
  }
  function capTable(v) {
    const { t, esc, nf } = K;
    const list = v.capabilities || [];
    const rev = v.revocations || [];
    if (!list.length) return `<div class="empty">${esc(t("ar_no_caps"))}</div>`;
    const tools = (c) => { try { const s = typeof c.spec === "string" ? JSON.parse(c.spec) : c.spec || {}; return (s.tools || []).join(", "); } catch { return ""; } };
    return `<div class="tbl-wrap"><table class="table ltbl"><thead><tr><th>${t("col_agent")}</th><th>${t("ar_mission")}</th><th>${t("ar_tools")}</th><th>${t("ar_calls")}</th><th>${t("col_status")}</th></tr></thead><tbody>
      ${list.slice(0, 30).map((c) => `<tr><td class="mono" dir="ltr">${esc(c.agent_id)}${c.parent_id ? "" : " ★"}</td><td class="mono faint" dir="ltr">${esc(K.short(c.mission_id || "—"))}</td><td class="mono faint trunc" dir="ltr">${esc(tools(c))}</td><td class="num" dir="ltr">${nf(c.calls_used)}/${nf(c.max_calls)}</td><td>${c.revoked_at ? `<span class="lbadge bad" title="${esc(c.revoke_reason || "")}">${esc(t("ar_revoked"))}</span>` : c.expires_at < Date.now() ? `<span class="faint">${esc(K.ago(c.expires_at))}</span>` : `<span class="lbadge ok">${esc(t("ar_live"))}</span>`}</td></tr>`).join("")}
    </tbody></table></div><div class="faint lsub">${esc(t("ar_revocations"))}: ${ltr(nf(rev.length))}</div>`;
  }
  function killView(k, divs) {
    const { t, esc, nf } = K;
    const dn = (id) => { const d = divs.find((x) => x.id === id); return d ? (ar() ? d.name_ar : d.name_en) : id; };
    const list = (arr, f) => (arr && arr.length ? arr.map((x) => `<span class="lbadge bad" dir="auto">${esc(f(typeof x === "string" ? x : x.id || x.scope_key || JSON.stringify(x)))}</span>`).join(" ") : `<span class="faint">${esc(t("ar_off"))}</span>`);
    return `<div class="akill">
      <div class="row"><b>${esc(t("ar_kill_org"))}</b><span class="spacer"></span>${k.org ? `<span class="lbadge bad">${esc(t("ar_on"))}</span>` : `<span class="lbadge ok">${esc(t("ar_off"))}</span>`}</div>
      <div class="row"><b>${esc(t("ar_kill_div"))}</b><span class="spacer"></span><div>${list(k.divisions, dn)}</div></div>
      <div class="row"><b>${esc(t("ar_kill_msn"))}</b><span class="spacer"></span><div>${list(k.missions, (x) => K.short(x))}</div></div>
      <div class="row"><b>${esc(t("ar_kill_agents"))}</b><span class="spacer"></span><div>${list(k.agents, (x) => K.short(x))}</div></div>
      <div class="faint lsub">${ltr(nf((k.divisions || []).length + (k.missions || []).length + (k.agents || []).length + (k.org ? 1 : 0)))} ${esc(t("ar_on"))}</div>
    </div>`;
  }
  function auditList(list) {
    const { t, esc } = K;
    if (!list.length) return `<div class="empty">${esc(t("ar_no_audit"))}</div>`;
    return `<h4 class="faint" style="margin:12px 0 6px">${esc(t("ar_recent"))}</h4><div class="lmini">${list.map((e) => `<div class="row"><span class="num faint" dir="ltr">#${esc(String(e.seq))}</span><span class="mono" dir="ltr">${esc(e.action)}</span><span class="mono faint" dir="ltr">${esc(K.short(e.target || ""))}</span><span class="spacer"></span><span class="mono faint" dir="ltr" title="${esc(e.hash)}">${esc(String(e.hash || "").slice(0, 10))}…</span><span class="faint">${esc(K.ago(e.at))}</span></div>`).join("")}</div>`;
  }
  async function verify(btn) {
    const { t, esc, nf } = K;
    K.busy(btn, async () => {
      try {
        const v = await K.api("/api/army/audit/verify");
        const el = document.getElementById("arChain");
        if (el) {
          el.className = "achain " + (v.ok ? "ok" : "bad");
          el.innerHTML = `${v.ok ? "✓ " + esc(t("ar_chain_ok")) : "✕ " + esc(t("ar_chain_bad"))} · ${ltr(nf(v.checked || 0))} ${esc(t("ar_checked"))} · ${esc(t("ar_head"))} <span class="mono" dir="ltr">${esc(String(v.head || "").slice(0, 16))}</span>${v.broken_at != null ? ` · #${ltr(esc(String(v.broken_at)))}` : ""}`;
          el.scrollIntoView({ block: "nearest", behavior: window.KFX && KFX.reduced() ? "auto" : "smooth" });
        }
        K.toast(v.ok ? t("ar_chain_ok") : t("ar_chain_bad"), !v.ok);
      } catch (e) { apiErr(e); }
    });
  }

  // ---------- wiring into KEXT ----------
  const prevInit = KEXT.init;
  Object.assign(KEXT.pages, { studio: renderStudio, army: renderArmy });
  KEXT.init = (k) => {
    K = k;
    Object.assign(k.I, ICONS);
    // nav: after Judge Court (labs.js), else after Discovery Lab
    if (!k.NAV.some(([n]) => n === "studio")) {
      let at = k.NAV.findIndex(([n]) => n === "court");
      if (at < 0) at = k.NAV.findIndex(([n]) => n === "discovery");
      at = at < 0 ? k.NAV.length : at + 1;
      k.NAV.splice(at, 0, ["studio", "nav_studio"], ["army", "nav_army"]);
    }
    prevInit(k);
  };
  KEXT.go = Object.assign(KEXT.go || {}, { i: "studio", m: "army" });
  KEXT.extraCommands = (KEXT.extraCommands || []).concat(() => [
    { id: "st-design-all", label: K.t("st_design_all"), icon: "✦", run: () => { location.hash = "#/studio"; setTimeout(designAll, 300); } },
    { id: "ar-verify", label: K.t("ar_verify"), icon: "✓", run: () => { location.hash = "#/army"; setTimeout(() => { const b = document.getElementById("arVerify2"); if (b) b.click(); }, 900); } },
    { id: "ar-matrix", label: K.t("ar_matrix"), icon: "▦", run: () => { location.hash = "#/army"; } },
  ]);
})();
