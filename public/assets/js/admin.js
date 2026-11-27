// =========================================================
// لوحة الإدارة العامة (Super Admin) — Supabase Auth + private.admins
// =========================================================
import {
  h, fill, t, initLang, setLang, isEn, tMode, toast, openSheet, confirmDialog, money, moneyText, num, toLatinDigits, oneLine, store as ls, THEMES, MODES, themeById,
  createSb, rpc, friendlyError, copyText, daysLeft, isValidPhone, normalizePhone, waLink,
} from "./common.js";
import { EN } from "./i18n-panel.js";

const root = document.getElementById("app");
const sb = createSb({ persist: true });
let stores = [];
let filter = ls.get("admin_filter", "all", true) || "all";
let query = "";

const MODE_THEME = { order: "theme-restaurant", booking: "theme-chalet", inquiry: "theme-realestate", charity: "theme-charity", legal: "theme-legal" };

initLang(EN);
boot();

/** زر تبديل اللغة (يعيد تحميل اللوحة باللغة الجديدة) */
function langBtn(cls = "hbtn") {
  return h("button", { class: `${cls} lang-btn`, type: "button", "aria-label": isEn() ? "العربية" : "English",
    onClick: () => { setLang(isEn() ? "ar" : "en"); location.reload(); } }, isEn() ? "ع" : "EN");
}

// رابط الدخول من البريد يرجع بالرموز في #hash — نحولها لجلسة ثم ننظف الرابط
async function consumeMagicLink() {
  const hp = new URLSearchParams(location.hash.slice(1));
  if (!hp.get("access_token") && !hp.get("error_description")) return;
  history.replaceState(null, "", location.pathname + location.search);
  if (hp.get("access_token") && hp.get("refresh_token")) {
    const { error } = await sb.auth.setSession({ access_token: hp.get("access_token"), refresh_token: hp.get("refresh_token") });
    if (error) toast(t("رابط الدخول غير صالح أو منتهي"), "error");
  } else toast(t("رابط الدخول غير صالح أو منتهي"), "error");
}

async function boot() {
  try { await consumeMagicLink(); } catch { /* ignore */ }
  const { data } = await sb.auth.getSession();
  if (!data.session) return renderLogin();
  let st = null;
  try { st = await rpc(sb, "admin_status"); } catch { /* ignore */ }
  if (st?.admin && !st.ok) return renderMfaChallenge();
  if (!st?.ok) {
    return fill(root, h("div", { class: "state-screen" }, h("div", { class: "card stack" },
      h("div", { class: "ico" }, "⛔"), h("h1", { text: t("ليست لديك صلاحية المدير") }),
      h("p", { class: "muted", text: t("هذا الحساب غير مضاف لجدول المدراء.") }),
      h("button", { class: "btn", onClick: logout }, t("تسجيل الخروج")))));
  }
  await reload();
}

async function logout() {
  await sb.auth.signOut();
  renderLogin();
}

function renderLogin() {
  const email = h("input", { class: "input", type: "email", autocomplete: "username", dir: "ltr", required: true, placeholder: "admin@example.com", "aria-label": t("البريد الإلكتروني") });
  const pass = h("input", { class: "input", type: "password", autocomplete: "current-password", dir: "ltr", required: true, placeholder: "••••••••", "aria-label": t("كلمة المرور") });
  const err = h("div", { class: "error-text center", role: "alert" });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, t("تسجيل الدخول"));
  const magic = h("button", { class: "btn btn-soft btn-block", type: "button" }, t("📧 أرسل رابط دخول لبريدي"));
  const info = h("div", { class: "muted center", role: "status" });
  const form = h("form", { class: "auth-card" },
    h("h2", { text: t("دخول المدير العام") }),
    h("label", { class: "field" }, h("span", {}, t("البريد الإلكتروني")), h("div", { class: "icon-input" }, h("span", { class: "i", "aria-hidden": "true" }, "✉️"), email)),
    h("label", { class: "field" }, h("span", {}, t("كلمة المرور")), h("div", { class: "icon-input" }, h("span", { class: "i", "aria-hidden": "true" }, "🔒"), pass)),
    err, btn, h("div", { class: "muted center small" }, t("أو بدون كلمة مرور:")), magic, info);
  fill(root, h("div", { class: "auth" },
    h("div", { class: "auth-hero" }, h("div", { class: "auth-lang" }, langBtn()), h("img", { class: "art", src: "/assets/img/login-admin.svg", alt: "" }),
      h("h1", { text: t("لوحة الإدارة") }), h("p", { text: t("تابع كل المتاجر والاشتراكات من مكان واحد") })),
    form));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    btn.disabled = true; err.textContent = "";
    const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
    btn.disabled = false;
    if (error) { err.textContent = t("بيانات الدخول غير صحيحة"); return; }
    boot();
  });
  magic.addEventListener("click", async () => {
    err.textContent = ""; info.textContent = "";
    if (!email.checkValidity() || !email.value.trim()) { err.textContent = t("اكتب بريدك أولاً"); email.focus(); return; }
    magic.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email: email.value.trim(), options: { shouldCreateUser: false, emailRedirectTo: location.origin + location.pathname } });
    magic.disabled = false;
    if (error) { err.textContent = /rate|seconds/i.test(error.message) ? t("انتظر دقيقة ثم أعد المحاولة") : t("تعذر الإرسال — تأكد من البريد"); return; }
    info.textContent = t("✅ أرسلنا رابط الدخول لبريدك — افتحه من نفس الجهاز");
  });
}

async function reload() {
  try {
    stores = await rpc(sb, "admin_list_stores");
  } catch (e) {
    toast(friendlyError(e), "error");
    stores = stores || [];
  }
  render();
}

/* ---------------- الحالة ---------------- */
function statusOf(s) {
  const d = daysLeft(s.expires_at);
  if (!s.is_active) return { key: "stopped", label: t("موقوف"), cls: "badge-danger" };
  if (d <= 0) return { key: "expired", label: t("منتهي"), cls: "badge-danger" };
  if (d <= 7) return { key: "soon", label: t("ينتهي خلال {0} يوم", { 0: d }), cls: "badge-warning" };
  return { key: "active", label: t("نشط • {0} يوم", { 0: d }), cls: "badge-success" };
}

const storeUrl = (s) => `${location.origin}/?store=${s.slug}`;
const manageUrl = (s) => `${location.origin}/manage?store=${s.slug}`;

/* ---------------- الواجهة ---------------- */
function render() {
  const total = stores.length;
  const counts = { active: 0, soon: 0, expired: 0, stopped: 0 };
  let views = 0, orders = 0, revenue = 0;
  for (const s of stores) {
    counts[statusOf(s).key]++;
    views += num(s.stats_30d?.views); orders += num(s.stats_30d?.orders); revenue += num(s.stats_30d?.revenue);
  }

  const header = h("header", { class: "p-header" },
    h("div", { class: "p-top" },
      h("div", { class: "p-logo" }, "🛡️"),
      h("div", { class: "p-title" }, h("h1", { text: t("لوحة الإدارة") }), h("div", { class: "sub", text: t("{0} متجر • {1} نشط", { 0: total, 1: counts.active + counts.soon }) })),
      h("button", { class: "hbtn", type: "button", "aria-label": t("سجل العمليات"), title: t("سجل العمليات"), onClick: auditSheet }, "📜"),
      h("button", { class: "hbtn", type: "button", "aria-label": t("الأمان والتحقق بخطوتين"), title: t("الأمان"), onClick: securitySheet }, "🔐"),
      h("button", { class: "hbtn", type: "button", "aria-label": t("تحديث"), title: t("تحديث"), onClick: reload }, "↻"),
      langBtn(),
      h("button", { class: "hbtn", type: "button", "aria-label": t("تسجيل الخروج"), title: t("خروج"), onClick: logout }, "🚪")),
    h("div", { class: "p-greet", text: t("آخر 30 يوم: {0} زيارة • {1} طلب • {2}", { 0: views, 1: orders, 2: money(revenue) }) }));

  const summary = h("div", { class: "p-stats" },
    h("div", { class: "p-stat" }, h("span", { class: "i" }, "🟢"), h("b", { text: String(counts.active + counts.soon) }), h("span", {}, t("متجر نشط"))),
    h("div", { class: "p-stat" }, h("span", { class: "i" }, "⏳"), h("b", { text: String(counts.soon) }), h("span", {}, t("ينتهي خلال 7 أيام"))),
    h("div", { class: "p-stat" }, h("span", { class: "i" }, "⛔"), h("b", { text: String(counts.expired + counts.stopped) }), h("span", {}, t("منتهي / موقوف"))));

  const tabs = h("div", { class: "status-tabs", role: "tablist" }, [
    ["all", t("الكل"), total], ["active", t("نشط"), counts.active], ["soon", t("ينتهي قريباً"), counts.soon], ["expired", t("منتهي"), counts.expired], ["stopped", t("موقوف"), counts.stopped],
  ].map(([k, l, n]) => h("button", { type: "button", class: filter === k ? "active" : "",
    onClick: () => { filter = k; ls.set("admin_filter", k, true); render(); } }, `${l} (${n})`)));

  const search = h("input", { class: "input", type: "search", placeholder: t("بحث بالاسم أو الرابط أو الجوال..."), value: query, "aria-label": t("بحث") });
  const list = h("div", { class: "stack" });
  const draw = () => {
    const q = oneLine(search.value, 40).toLowerCase();
    query = search.value;
    const rows = stores.filter((s) => (filter === "all" || statusOf(s).key === filter)
      && (!q || s.name.toLowerCase().includes(q) || s.slug.includes(q) || s.whatsapp_phone.includes(q)));
    fill(list, ...(rows.length ? rows.map(storeCard) : [h("div", { class: "card empty-state" }, h("img", { src: "/assets/img/empty.svg", alt: "" }), h("b", {}, t("لا توجد متاجر هنا")))]));
  };
  search.addEventListener("input", draw);
  draw();

  fill(root, header, summary,
    h("main", { class: "p-body" }, tabs, h("div", { class: "search-box" }, h("span", { class: "i", "aria-hidden": "true" }, "🔍"), search), list),
    h("button", { class: "fab", type: "button", onClick: createStoreSheet }, h("span", { class: "plus", "aria-hidden": "true" }, "+"), t("متجر جديد")));
}

function storeCard(s) {
  const st = statusOf(s);
  const theme = themeById(s.theme_style);
  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(friendlyError(e), "error"); } finally { btn.disabled = false; }
  };

  const renew = h("button", { class: "btn btn-primary btn-sm", type: "button" }, t("+30 يوم تجديد"));
  renew.onclick = busy(renew, async () => {
    await rpc(sb, "admin_extend_store", { p_store_id: s.id, p_days: 30 });
    toast(t("تم تجديد «{0}» 30 يوماً ✅", { 0: s.name }), "success");
    await reload();
  });

  const toggle = h("button", { class: `btn btn-sm ${s.is_active ? "btn-danger" : "btn-soft"}`, type: "button" }, s.is_active ? t("⏸️ إيقاف") : t("▶️ تفعيل"));
  toggle.onclick = busy(toggle, async () => {
    if (s.is_active && !(await confirmDialog(t("إيقاف «{0}»؟ سيتوقف الرابط العام فوراً.", { 0: s.name }), { okText: t("إيقاف"), danger: true }))) return;
    await rpc(sb, "admin_set_active", { p_store_id: s.id, p_active: !s.is_active });
    toast(s.is_active ? t("تم الإيقاف") : t("تم التفعيل ✅"), "success");
    await reload();
  });

  const enter = h("button", { class: "btn btn-blue btn-sm", type: "button" }, t("🔧 دخول لوحة التاجر"));
  enter.onclick = busy(enter, async () => {
    const w = window.open("about:blank", "_blank");
    const tok = await rpc(sb, "admin_open_merchant", { p_store_id: s.id });
    const url = `/manage?store=${s.slug}#t=${tok}`;
    if (w) { w.opener = null; w.location.href = url; } else location.href = url;
  });

  const remind = h("button", { class: "btn btn-gold btn-sm", type: "button", onClick: () => copyText(reminderText(s), t("تم نسخ رسالة التذكير ✅")) }, t("📋 نسخ رسالة التذكير"));

  // شريط المدة المتبقية من الاشتراك (نسبة إلى 30 يوماً)
  const d = Math.max(0, daysLeft(s.expires_at));
  const pct = Math.min(100, Math.round((d / 30) * 100));
  const date = new Date(s.expires_at).toLocaleDateString("ar-u-ca-gregory-nu-latn", { dateStyle: "medium" });

  return h("article", { class: "card scard store-card" },
    h("div", { class: "s-head" },
      s.logo_url ? h("img", { class: "s-logo", src: s.logo_url, alt: "" })
                 : h("div", { class: "s-logo", style: { background: theme.primary } }, s.name.charAt(0)),
      h("div", { class: "grow", style: { "min-width": "0" } },
        h("b", { text: s.name, style: { display: "block", "font-size": "16px" } }),
        h("div", { class: "hint", text: `${tMode(s.business_mode).icon} ${tMode(s.business_mode).label} • ${t(theme.label)}` })),
      h("span", { class: `badge ${st.cls}` }, st.label)),
    h("div", { class: "s-lines" },
      h("div", {}, h("span", { class: "k" }, t("🔗 الرابط")), h("a", { href: `/?store=${s.slug}`, target: "_blank", rel: "noopener", text: `/?store=${s.slug}` })),
      h("div", {}, h("span", { class: "k" }, t("📱 واتساب")), h("span", { class: "ltr", text: `+${s.whatsapp_phone}` })),
      h("div", {}, h("span", { class: "k" }, t("📅 ينتهي")), h("span", { text: t("{0} • إجمالي الطلبات {1}", { 0: date, 1: s.stats_all?.orders ?? 0 }) }))),
    h("div", { class: "exp-bar", "aria-label": t("متبقي {0} يوم", { 0: d }) }, h("i", { class: d <= 0 || !s.is_active ? "bad" : d <= 7 ? "warn" : "", style: { width: `${Math.max(4, pct)}%` } })),
    h("div", { class: "mini-stats" },
      h("div", {}, h("b", { text: String(s.stats_30d?.views ?? 0) }), h("span", {}, t("زيارات 30ي"))),
      h("div", {}, h("b", { text: String(s.stats_30d?.orders ?? 0) }), h("span", {}, t("طلبات 30ي"))),
      h("div", {}, h("b", { text: money(s.stats_30d?.revenue ?? 0) }), h("span", {}, t("القيمة")))),
    h("div", { class: "actions" }, renew, toggle, enter, remind,
      h("button", { class: "btn btn-outline btn-sm", type: "button", onClick: () => linksSheet(s) }, t("🔗 الرابط و QR")),
      h("button", { class: "btn btn-outline btn-sm", type: "button", onClick: () => editSheet(s) }, t("✏️ تعديل / PIN"))));
}

function reminderText(s) {
  const d = daysLeft(s.expires_at);
  const date = new Date(s.expires_at).toLocaleDateString("ar-u-ca-gregory-nu-latn", { dateStyle: "long" });
  const st = s.stats_30d || {};
  return [
    `مرحباً 👋`,
    d > 0
      ? `نذكّركم بأن اشتراك «${s.name}» ينتهي خلال ${d} يوم (${date}).`
      : `نود إشعاركم بأن اشتراك «${s.name}» انتهى بتاريخ ${date} وأصبح الرابط متوقفاً.`,
    ``,
    `📊 أداء متجركم خلال آخر 30 يوم:`,
    `👀 الزيارات: ${st.views ?? 0}`,
    `🧾 الطلبات: ${st.orders ?? 0}`,
    `💰 قيمة الطلبات: ${moneyText(st.revenue ?? 0)}`,
    ``,
    `🔗 رابط متجركم: ${storeUrl(s)}`,
    `للتجديد يسعدنا تواصلكم معنا. شكراً لثقتكم 🌟`,
  ].join("\n");
}

/* ---------------- QR ---------------- */
function qrCanvas(text, size = 400) {
  const canvas = h("canvas", { width: String(size), height: String(size), "aria-label": t("رمز QR") });
  if (typeof window.qrcode !== "function") return canvas;
  const qr = window.qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const margin = 2;
  const cell = size / (n + margin * 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (qr.isDark(r, c)) ctx.fillRect(Math.floor((c + margin) * cell), Math.floor((r + margin) * cell), Math.ceil(cell), Math.ceil(cell));
  }
  return canvas;
}

function downloadCanvas(canvas, name) {
  canvas.toBlob((b) => {
    if (!b) return;
    const a = h("a", { href: URL.createObjectURL(b), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, "image/png");
}

function copyField(value) {
  return h("div", { class: "copy-field" }, h("input", { class: "input", value, readonly: true }),
    h("button", { class: "btn btn-soft", type: "button", onClick: () => copyText(value) }, t("نسخ")));
}

function linksSheet(s, pin = null) {
  const canvas = qrCanvas(storeUrl(s));
  const welcome = [
    `أهلاً بكم في منصة المنيو الإلكتروني 🎉`,
    `🏪 ${s.name}`,
    `🔗 رابط متجركم للعملاء: ${storeUrl(s)}`,
    `⚙️ لوحة التحكم: ${manageUrl(s)}`,
    pin ? `🔐 رمز الدخول PIN: ${pin}` : null,
    `📅 الاشتراك ساري حتى: ${new Date(s.expires_at).toLocaleDateString("ar-u-ca-gregory-nu-latn", { dateStyle: "long" })}`,
  ].filter(Boolean).join("\n");

  openSheet({
    title: pin ? t("✅ تم إنشاء المتجر") : s.name,
    body: [
      pin ? h("div", { class: "alert alert-info" }, h("div", {}, h("b", {}, t("رمز PIN: ")), h("b", { class: "ltr", style: { "font-size": "22px", "letter-spacing": "4px" } }, pin),
        h("div", { class: "hint" }, t("احفظ الرمز الآن — لا يمكن عرضه مرة أخرى (يمكن إعادة تعيينه فقط).")))) : null,
      h("div", { class: "qr-wrap" }, canvas,
        h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => downloadCanvas(canvas, `qr-${s.slug}.png`) }, t("⬇️ تحميل QR"))),
      h("div", { class: "field" }, h("span", { class: "label" }, t("رابط المتجر")), copyField(storeUrl(s))),
      h("div", { class: "field" }, h("span", { class: "label" }, t("رابط لوحة التاجر")), copyField(manageUrl(s))),
    ],
    foot: [
      h("button", { class: "btn btn-primary btn-block", type: "button", onClick: () => copyText(welcome, t("تم نسخ رسالة الترحيب ✅")) }, t("📋 نسخ رسالة الترحيب للتاجر")),
      h("a", { class: "btn btn-block", href: waLink(s.whatsapp_phone, welcome), target: "_blank", rel: "noopener" }, t("💬 إرسالها للتاجر عبر واتساب")),
    ],
  });
}

/* ---------------- إنشاء متجر ---------------- */
function createStoreSheet() {
  const name = h("input", { class: "input", maxlength: "80", required: true });
  const slug = h("input", { class: "input", dir: "ltr", maxlength: "40", placeholder: "my-store", pattern: "[a-z0-9-]+" });
  const phone = h("input", { class: "input", type: "tel", dir: "ltr", maxlength: "20", placeholder: "05xxxxxxxx" });
  const btype = h("input", { class: "input", maxlength: "60", placeholder: t("مثال: مطعم برجر") });
  const mode = h("select", { class: "select" }, Object.entries(MODES).map(([k, m]) => h("option", { value: k }, `${m.icon} ${t(m.label)}`)));
  const theme = h("select", { class: "select" }, THEMES.map((th) => h("option", { value: th.id, selected: th.id === "theme-restaurant" }, t(th.label))));
  const pin = h("input", { class: "input", inputmode: "numeric", maxlength: "8", dir: "ltr", placeholder: t("تلقائي (6 أرقام)") });
  let days = 30;
  const daysSeg = h("div", { class: "segmented" }, [[7, t("تجربة 7 أيام")], [30, t("شهر")], [90, t("3 أشهر")], [180, t("6 أشهر")], [365, t("سنة")]].map(([v, l]) =>
    h("label", {}, h("input", { type: "radio", name: "days", checked: v === days, onChange: () => { days = v; } }), h("span", {}, l))));

  mode.addEventListener("change", () => { theme.value = MODE_THEME[mode.value] || theme.value; });
  slug.addEventListener("input", () => { slug.value = slug.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40); });

  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, t("إنشاء المتجر وتوليد الرابط"));
  const sheet = openSheet({
    title: t("متجر جديد"),
    body: [
      h("label", { class: "field" }, h("span", {}, t("اسم المتجر")), name),
      h("label", { class: "field" }, h("span", {}, t("الرابط (بالإنجليزية)")), slug, h("span", { class: "hint ltr", text: `${location.origin}/?store=…` })),
      h("label", { class: "field" }, h("span", {}, t("رقم واتساب الطلبات")), phone),
      h("label", { class: "field" }, h("span", {}, t("وضع التشغيل")), mode),
      h("label", { class: "field" }, h("span", {}, t("القالب")), theme),
      h("label", { class: "field" }, h("span", {}, t("نوع النشاط (اختياري)")), btype),
      h("div", { class: "field" }, h("span", { class: "label" }, t("مدة الاشتراك")), daysSeg),
      h("label", { class: "field" }, h("span", {}, t("رمز PIN (اختياري)")), pin),
    ],
    foot: btn,
  });

  btn.addEventListener("click", async () => {
    const v = { name: oneLine(name.value, 80), slug: slug.value.replace(/^-+|-+$/g, ""), phone: phone.value, pin: pin.value.trim() };
    if (v.name.length < 2) return toast(t("اسم المتجر مطلوب"), "error");
    if (!/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v.slug)) return toast(t("الرابط: 3–40 حرفاً إنجليزياً صغيراً أو أرقام أو -"), "error");
    if (!isValidPhone(v.phone)) return toast(t("رقم الواتساب غير صحيح"), "error");
    if (v.pin && !/^\d{4,8}$/.test(v.pin)) return toast(t("PIN من 4 إلى 8 أرقام"), "error");
    btn.disabled = true;
    try {
      const r = await rpc(sb, "admin_create_store", { p: {
        name: v.name, slug: v.slug, whatsapp_phone: normalizePhone(v.phone), theme_style: theme.value,
        business_mode: mode.value, business_type: oneLine(btype.value, 60), days, pin: v.pin || null,
      } });
      sheet.close();
      await reload();
      linksSheet(r.store, r.pin);
    } catch (e) {
      toast(friendlyError(e), "error");
    } finally { btn.disabled = false; }
  });
}

/* ---------------- تعديل متجر / PIN ---------------- */
function editSheet(s) {
  const name = h("input", { class: "input", value: s.name, maxlength: "80" });
  const phone = h("input", { class: "input", type: "tel", dir: "ltr", value: s.whatsapp_phone, maxlength: "20" });
  const btype = h("input", { class: "input", value: s.business_type || "", maxlength: "60" });
  const mode = h("select", { class: "select" }, Object.entries(MODES).map(([k, m]) => h("option", { value: k, selected: k === s.business_mode }, `${m.icon} ${t(m.label)}`)));
  const theme = h("select", { class: "select" }, THEMES.map((th) => h("option", { value: th.id, selected: th.id === s.theme_style }, t(th.label))));
  const extendDays = h("input", { class: "input", type: "number", min: "1", max: "3660", value: "30", inputmode: "numeric" });

  const saveBtn = h("button", { class: "btn btn-primary btn-block", type: "button" }, t("حفظ"));
  const extBtn = h("button", { class: "btn btn-soft", type: "button" }, t("تمديد"));
  const pinBtn = h("button", { class: "btn btn-danger btn-block", type: "button" }, t("🔐 إعادة تعيين PIN"));

  const sheet = openSheet({
    title: t("تعديل: {0}", { 0: s.name }),
    body: [
      h("label", { class: "field" }, h("span", {}, t("الاسم")), name),
      h("label", { class: "field" }, h("span", {}, t("واتساب")), phone),
      h("label", { class: "field" }, h("span", {}, t("وضع التشغيل")), mode),
      h("label", { class: "field" }, h("span", {}, t("القالب")), theme),
      h("label", { class: "field" }, h("span", {}, t("نوع النشاط")), btype),
      h("div", { class: "field" }, h("span", { class: "label" }, t("تمديد الاشتراك (أيام)")), h("div", { class: "row" }, extendDays, extBtn)),
      pinBtn,
      h("button", { class: "btn btn-outline btn-block", type: "button", style: { color: "var(--danger)", "border-color": "var(--danger)" },
        onClick: () => { sheet.close(); deleteSheet(s); } }, t("🗑️ حذف المتجر نهائياً")),
    ],
    foot: saveBtn,
  });

  saveBtn.addEventListener("click", async () => {
    if (!isValidPhone(phone.value)) return toast(t("رقم الواتساب غير صحيح"), "error");
    saveBtn.disabled = true;
    try {
      await rpc(sb, "admin_update_store", { p_store_id: s.id, p: {
        name: oneLine(name.value, 80), whatsapp_phone: normalizePhone(phone.value), business_mode: mode.value,
        theme_style: theme.value, business_type: oneLine(btype.value, 60) } });
      toast(t("تم الحفظ ✅"), "success");
      sheet.close();
      await reload();
    } catch (e) { toast(friendlyError(e), "error"); } finally { saveBtn.disabled = false; }
  });
  extBtn.addEventListener("click", async () => {
    const d = Math.floor(num(extendDays.value));
    if (!(d >= 1 && d <= 3660)) return toast(t("عدد أيام غير صحيح"), "error");
    try {
      await rpc(sb, "admin_extend_store", { p_store_id: s.id, p_days: d });
      toast(t("تم التمديد {0} يوم ✅", { 0: d }), "success");
      sheet.close();
      await reload();
    } catch (e) { toast(friendlyError(e), "error"); }
  });
  pinBtn.addEventListener("click", async () => {
    if (!(await confirmDialog(t("سيتم توليد رمز جديد وتسجيل خروج التاجر من كل الأجهزة. متابعة؟"), { okText: t("إعادة التعيين"), danger: true }))) return;
    try {
      const p = await rpc(sb, "admin_reset_pin", { p_store_id: s.id, p_pin: null });
      sheet.close();
      openSheet({ title: t("رمز PIN الجديد"), body: h("div", { class: "stack center" },
        h("b", { class: "ltr", style: { "font-size": "28px", "letter-spacing": "6px" }, text: p }),
        h("span", { class: "hint" }, t("أرسله للتاجر — لن يظهر مرة أخرى."))),
        foot: h("button", { class: "btn btn-primary btn-block", type: "button", onClick: () => copyText(p) }, t("نسخ")) });
    } catch (e) { toast(friendlyError(e), "error"); }
  });
}

/* =========================================================
   الحذف النهائي، سجل العمليات، التحقق بخطوتين (TOTP)
   ========================================================= */
function deleteSheet(s) {
  const confirmIn = h("input", { class: "input ltr", placeholder: s.slug, autocomplete: "off", "aria-label": t("اكتب رابط المتجر للتأكيد") });
  const btn = h("button", { class: "btn btn-danger btn-lg btn-block", type: "button", disabled: true }, t("حذف نهائي"));
  confirmIn.addEventListener("input", () => { btn.disabled = confirmIn.value.trim().toLowerCase() !== s.slug; });
  const sheet = openSheet({ title: t("حذف «{0}»", { 0: s.name }), foot: btn, body: [
    h("div", { class: "alert alert-danger" }, h("div", {},
      h("b", {}, t("هذا الإجراء لا يمكن التراجع عنه.")),
      h("div", { class: "small", text: t("سيُحذف المتجر وكل أصنافه وكوبوناته وإحصائياته وسجل طلباته. الصور تُحذف تلقائياً في التنظيف الدوري.") }))),
    h("p", { style: { margin: "0" } }, t("للتأكيد اكتب رابط المتجر: "), h("b", { class: "ltr", text: s.slug })),
    confirmIn,
    h("p", { class: "hint", style: { margin: "0" }, text: t("تبي توقفه مؤقتاً بدل الحذف؟ استخدم زر «إيقاف» في بطاقة المتجر.") }),
  ] });
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      await rpc(sb, "admin_delete_store", { p_store_id: s.id, p_confirm_slug: confirmIn.value.trim() });
      toast(t("تم حذف «{0}» نهائياً", { 0: s.name }), "success");
      sheet.close();
      await reload();
    } catch (e) { toast(friendlyError(e), "error"); btn.disabled = false; }
  });
}

const AUDIT_LABELS = {
  create_store: t("➕ إنشاء متجر"), update_store: t("✏️ تعديل بيانات"), extend: t("📅 تمديد اشتراك"), activate: t("▶️ تفعيل"),
  suspend: t("⏸️ إيقاف"), reset_pin: t("🔐 إعادة تعيين PIN"), open_merchant: t("🔧 دخول لوحة التاجر"), delete_store: t("🗑️ حذف متجر"),
};
async function auditSheet() {
  const body = h("div", { class: "stack" }, h("div", { class: "center" }, h("span", { class: "spinner" })));
  openSheet({ title: t("📜 سجل العمليات"), body });
  let rows;
  try { rows = await rpc(sb, "admin_audit_log", { p_limit: 200 }); } catch (e) { return fill(body, h("div", { class: "alert alert-danger" }, friendlyError(e))); }
  if (!rows.length) return fill(body, h("div", { class: "muted center" }, t("لا توجد عمليات بعد")));
  fill(body, ...rows.map((r) => h("div", { class: "audit-row" },
    h("div", { class: "grow" },
      h("b", { text: AUDIT_LABELS[r.action] || r.action }),
      h("div", { class: "hint", text: `${r.store_name || "—"}${r.store_slug ? ` (${r.store_slug})` : ""}${r.details?.days ? t(" • {0} يوم", { 0: r.details.days }) : ""}` })),
    h("span", { class: "hint", style: { "white-space": "nowrap" }, text: new Date(r.at).toLocaleString("ar-u-ca-gregory-nu-latn", { dateStyle: "short", timeStyle: "short" }) }))));
}

/** شاشة إدخال رمز التحقق بخطوتين عند الدخول */
async function renderMfaChallenge() {
  const code = h("input", { class: "input pin-input", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", placeholder: "••••••", "aria-label": t("رمز التحقق") });
  const err = h("div", { class: "error-text center", role: "alert" });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, t("تحقق"));
  const form = h("form", { class: "auth-card" }, h("h2", { text: t("التحقق بخطوتين") }),
    h("p", { class: "muted center", style: { margin: "0" }, text: t("اكتب الرمز المكون من 6 أرقام من تطبيق المصادقة (Google Authenticator أو غيره).") }),
    code, err, btn, h("button", { class: "btn btn-ghost btn-block", type: "button", onClick: logout }, t("تسجيل الخروج")));
  fill(root, h("div", { class: "auth" },
    h("div", { class: "auth-hero" }, h("img", { class: "art", src: "/assets/img/login-admin.svg", alt: "" }), h("h1", { text: t("خطوة أمان إضافية") })), form));
  code.focus();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = toLatinDigits(code.value).trim();
    if (!/^\d{6}$/.test(v)) { err.textContent = t("الرمز 6 أرقام"); return; }
    btn.disabled = true; err.textContent = "";
    try {
      const { data, error } = await sb.auth.mfa.listFactors();
      if (error) throw error;
      const f = (data?.totp || []).find((x) => x.status === "verified");
      if (!f) throw new Error("no_factor");
      const r = await sb.auth.mfa.challengeAndVerify({ factorId: f.id, code: v });
      if (r.error) throw r.error;
      boot();
    } catch { err.textContent = t("الرمز غير صحيح أو انتهت صلاحيته"); btn.disabled = false; }
  });
}

/** تفعيل/إلغاء التحقق بخطوتين */
async function securitySheet() {
  const body = h("div", { class: "stack" }, h("div", { class: "center" }, h("span", { class: "spinner" })));
  const sheet = openSheet({ title: t("🔐 الأمان"), body });
  const { data } = await sb.auth.mfa.listFactors();
  const verified = (data?.totp || []).find((x) => x.status === "verified");
  if (verified) {
    const off = h("button", { class: "btn btn-danger btn-block", type: "button" }, t("إلغاء التحقق بخطوتين"));
    off.addEventListener("click", async () => {
      if (!(await confirmDialog(t("إلغاء التحقق بخطوتين يقلل حماية حساب المدير. متابعة؟"), { okText: t("إلغاء التفعيل"), danger: true }))) return;
      const r = await sb.auth.mfa.unenroll({ factorId: verified.id });
      if (r.error) return toast(t("تعذر الإلغاء — سجّل الدخول من جديد ثم حاول"), "error");
      toast(t("تم إلغاء التحقق بخطوتين"), "success"); sheet.close();
    });
    return fill(body, h("div", { class: "alert alert-info" }, t("✅ التحقق بخطوتين مفعّل على هذا الحساب.")), off);
  }
  const start = h("button", { class: "btn btn-primary btn-block", type: "button" }, t("تفعيل التحقق بخطوتين"));
  fill(body, h("p", { style: { margin: "0" }, text: t("يطلب رمزاً من تطبيق المصادقة على جوالك مع كل دخول، فما يقدر أحد يدخل حتى لو عرف كلمة المرور.") }), start);
  start.addEventListener("click", async () => {
    start.disabled = true;
    // تنظيف أي محاولة سابقة غير مكتملة
    for (const f of (data?.totp || []).filter((x) => x.status !== "verified")) await sb.auth.mfa.unenroll({ factorId: f.id });
    const { data: en, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `admin-${Date.now()}` });
    if (error || !en) { start.disabled = false; return toast(t("تعذر بدء التفعيل"), "error"); }
    const code = h("input", { class: "input pin-input", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", placeholder: "••••••", "aria-label": t("رمز التحقق") });
    const ok = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, t("تأكيد وتفعيل"));
    fill(body,
      h("ol", { class: "stack", style: { margin: "0", "padding-inline-start": "20px" } },
        h("li", {}, t("افتح تطبيق المصادقة (Google Authenticator / Microsoft Authenticator).")),
        h("li", {}, t("امسح الرمز أو أدخل المفتاح يدوياً.")),
        h("li", {}, t("اكتب الرمز المكون من 6 أرقام."))),
      h("div", { class: "qr-wrap" }, qrCanvas(en.totp.uri, 360)),
      h("div", { class: "copy-field" }, h("input", { class: "input", value: en.totp.secret, readonly: true, "aria-label": t("المفتاح السري") }),
        h("button", { class: "btn btn-soft", type: "button", onClick: () => copyText(en.totp.secret) }, t("نسخ"))),
      code, ok);
    ok.addEventListener("click", async () => {
      const v = toLatinDigits(code.value).trim();
      if (!/^\d{6}$/.test(v)) return toast(t("الرمز 6 أرقام"), "error");
      ok.disabled = true;
      const r = await sb.auth.mfa.challengeAndVerify({ factorId: en.id, code: v });
      if (r.error) { ok.disabled = false; return toast(t("الرمز غير صحيح، حاول مرة ثانية"), "error"); }
      toast(t("✅ تم تفعيل التحقق بخطوتين"), "success"); sheet.close();
    });
  });
}
