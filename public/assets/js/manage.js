// =========================================================
// لوحة التاجر: /manage?store=slug  (دخول برمز PIN)
// كل حفظ يتم عبر RPC → يحدّث stores.updated_at → المنيو العام يتحدث فوراً (Realtime)
// =========================================================
import { CONFIG } from "./config.js";
import {
  h, fill, $, toast, openSheet, confirmDialog, money, num, oneLine, initials, store as ls, applyTheme, THEMES, MODES,
  createSb, rpc, friendlyError, compressImage, uploadImage, blobToBase64, pickFile, callFunction,
  getStoreSlug, daysLeft, fmtTime12, toLatinDigits, copyText, normalizePhone,
} from "./common.js";

const slug = getStoreSlug();
const root = document.getElementById("app");
const sb = createSb();
const TOKEN_KEY = `mtoken_${slug}`;

let token = null;
let D = null;          // بيانات اللوحة
let tab = ls.get("manage_tab", "menu", true) || "menu";
let reorderMode = false;

boot();

function boot() {
  if (!slug) return renderMessage("🔗", "الرابط غير صحيح", "استخدم رابط لوحة التحكم الخاص بمتجرك.");
  // دخول المدير للمساعدة: يمرر الرمز عبر # ولا يُحفظ إلا في هذه الجلسة
  const m = location.hash.match(/(?:^#|&)t=([0-9a-f]{64})/);
  if (m) {
    ls.set(TOKEN_KEY, m[1], true);
    history.replaceState(null, "", location.pathname + location.search);
  }
  token = ls.get(TOKEN_KEY, null, true) || ls.get(TOKEN_KEY, null);
  if (token) loadDash(true);
  else renderLogin();
}

function clearToken() {
  ls.del(TOKEN_KEY); ls.del(TOKEN_KEY, true);
  token = null;
}

async function loadDash(first = false) {
  try {
    D = await rpc(sb, "merchant_get_dashboard", { p_token: token });
  } catch (e) {
    if (String(e.message).includes("unauthorized")) { clearToken(); return renderLogin(); }
    if (first) return renderMessage("📡", "تعذر التحميل", friendlyError(e), true);
    return toast(friendlyError(e), "error");
  }
  applyTheme(D.store);
  document.title = `لوحة التحكم — ${D.store.name}`;
  renderShell();
}

async function save(fn, args, okMsg = "تم الحفظ ✅ وانعكس على المتجر فوراً") {
  try {
    const r = await rpc(sb, fn, { p_token: token, ...args });
    toast(okMsg, "success");
    return r;
  } catch (e) {
    if (String(e.message).includes("unauthorized")) { clearToken(); renderLogin(); }
    toast(friendlyError(e), "error");
    throw e;
  }
}

/* =========================================================
   شاشة الدخول
   ========================================================= */
function renderMessage(icon, title, text, retry = false) {
  fill(root, h("div", { class: "state-screen" }, h("div", {},
    h("div", { class: "ico", "aria-hidden": "true" }, icon), h("h1", { text: title }), h("p", { class: "muted", text }),
    retry ? h("button", { class: "btn btn-primary", onClick: () => location.reload() }, "إعادة المحاولة") : null)));
}

async function renderLogin() {
  const chip = h("div", { class: "store-chip" }, h("span", { class: "ph" }, "🏪"), h("b", { text: "لوحة تحكم المتجر" }));
  const pin = h("input", { class: "input pin-input", type: "password", inputmode: "numeric", autocomplete: "current-password",
    maxlength: "8", placeholder: "••••", "aria-label": "رمز PIN" });
  const err = h("div", { class: "error-text center", role: "alert" });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, "تسجيل الدخول");
  const form = h("form", { class: "auth-card" },
    chip, h("h2", { text: "أدخل رمز الدخول (PIN)" }),
    h("div", { class: "icon-input" }, h("span", { class: "i", "aria-hidden": "true" }, "🔒"), pin), err, btn,
    h("p", { class: "hint center", style: { margin: "0" }, text: "نسيت الرمز؟ تواصل مع الإدارة لإعادة تعيينه." }));
  fill(root, h("div", { class: "auth" },
    h("div", { class: "auth-hero" }, h("img", { class: "art", src: "/assets/img/login-merchant.svg", alt: "" }),
      h("h1", { text: "أهلاً بك 👋" }), h("p", { text: "أدر متجرك وطلباتك من جوالك بكل سهولة" })),
    form));
  pin.focus();

  rpc(sb, "get_store_public", { p_slug: slug }).then((d) => {
    if (d?.store) {
      applyTheme(d.store);
      fill(chip, d.store.logo_url ? h("img", { src: d.store.logo_url, alt: "" }) : h("span", { class: "ph" }, initials(d.store.name)), h("b", { text: d.store.name }));
    }
  }).catch(() => {});

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = toLatinDigits(pin.value).trim();
    if (!/^\d{4,8}$/.test(v)) { err.textContent = "الرمز من 4 إلى 8 أرقام"; return; }
    btn.disabled = true; err.textContent = "";
    try {
      const r = await rpc(sb, "merchant_login", { p_slug: slug, p_pin: v });
      if (r.ok) {
        token = r.token;
        ls.set(TOKEN_KEY, token);
        return loadDash(true);
      }
      pin.value = "";
      err.textContent = r.error === "locked"
        ? `تم إيقاف المحاولات مؤقتاً لمدة ${r.retry_after_minutes} دقيقة بسبب محاولات خاطئة متكررة`
        : `رمز غير صحيح${typeof r.remaining === "number" ? ` — المتبقي ${r.remaining} محاولات` : ""}`;
    } catch (ex) {
      err.textContent = friendlyError(ex);
    } finally {
      btn.disabled = false;
    }
  });
}

/* =========================================================
   الهيكل العام + التبويبات
   ========================================================= */
const TABS = [
  { id: "menu", icon: "🍽️", label: "المنيو" },
  { id: "settings", icon: "⚙️", label: "الإعدادات" },
  { id: "design", icon: "🎨", label: "التصميم" },
  { id: "offers", icon: "📣", label: "العروض" },
];

function renderShell() {
  const s = D.store;
  const mode = MODES[s.business_mode];
  TABS[0].label = mode.items === "الأصناف" ? "المنيو" : mode.items;
  TABS[0].icon = mode.icon;
  const tabTitle = { menu: TABS[0].label, settings: "إعدادات المتجر", design: "التصميم والهوية", offers: "العروض والبنرات" }[tab];

  const header = h("header", { class: "p-header" },
    h("div", { class: "p-top" },
      s.logo_url ? h("img", { class: "p-logo", src: s.logo_url, alt: "" }) : h("div", { class: "p-logo" }, initials(s.name)),
      h("div", { class: "p-title" }, h("h1", { text: s.name }), h("div", { class: "sub", text: `${mode.icon} ${mode.label} • ${tabTitle}` })),
      h("button", { class: "hbtn orders-btn", type: "button", "aria-label": "سجل الطلبات", title: "سجل الطلبات", onClick: () => openOrders("new") }, "🧾", h("span", { class: "nbadge", hidden: true })),
      h("a", { class: "hbtn", href: `/?store=${slug}`, target: "_blank", rel: "noopener", "aria-label": "عرض المتجر", title: "عرض المتجر" }, "👁️"),
      h("button", { class: "hbtn", type: "button", "aria-label": "تسجيل الخروج", title: "خروج", onClick: logout }, "🚪")));

  const t = D.stats.today, m = D.stats.last_30d;
  const stats = h("div", { class: "p-stats" },
    h("button", { class: "p-stat", type: "button", onClick: openInsights, "aria-label": "الإحصائيات" }, h("span", { class: "i" }, "👀"), h("b", { text: String(t.views) }), h("span", {}, "زيارات اليوم")),
    h("button", { class: "p-stat", type: "button", onClick: () => openOrders("new"), "aria-label": "سجل الطلبات" }, h("span", { class: "i" }, "🧾"), h("b", { text: String(t.orders) }), h("span", {}, "طلبات اليوم")),
    h("button", { class: "p-stat", type: "button", onClick: openInsights, "aria-label": "الإحصائيات" }, h("span", { class: "i" }, "📊"), h("b", { text: money(m.revenue) }), h("span", {}, `${m.orders} طلب / 30 يوم`)));

  const content = h("div", { class: "p-body", id: "tab-content" });
  const days = daysLeft(s.expires_at);
  if (!s.is_live) {
    content.append(h("div", { class: "alert alert-danger" }, "⏸️ ",
      h("span", {}, s.is_active ? "انتهى اشتراك متجرك والرابط العام متوقف. تواصل مع الإدارة للتجديد." : "متجرك موقوف حالياً من الإدارة.")));
  } else if (days <= 7) {
    content.append(h("div", { class: "alert alert-info" }, `⏳ ينتهي الاشتراك خلال ${days} يوم — تواصل مع الإدارة للتجديد.`));
  }
  const panel = h("section", { class: "stack", id: "panel" });
  content.append(panel);

  const nav = h("nav", { class: "bottom-nav p-nav", "aria-label": "أقسام اللوحة" }, TABS.map((x) =>
    h("button", { type: "button", class: x.id === tab ? "active" : "", "aria-current": x.id === tab ? "page" : null,
      onClick: () => { tab = x.id; ls.set("manage_tab", tab, true); renderShell(); window.scrollTo(0, 0); } },
      h("span", { class: "i", "aria-hidden": "true" }, x.icon), x.label)));

  fill(root, header, stats, content, nav);
  ({ menu: tabMenu, settings: tabSettings, design: tabDesign, offers: tabOffers })[tab](panel);
  // شارة عدد الطلبات الجديدة
  rpc(sb, "merchant_list_orders", { p_token: token, p_status: "new", p_limit: 1 }).then((r) => {
    const n = r?.counts?.new || 0, b = header.querySelector(".nbadge");
    if (b && n) { b.hidden = false; b.textContent = n > 99 ? "99+" : String(n); }
  }).catch(() => {});
}

async function logout() {
  try { await rpc(sb, "merchant_logout", { p_token: token }); } catch { /* ignore */ }
  clearToken();
  renderLogin();
}

/* =========================================================
   مكونات مساعدة
   ========================================================= */
function field(label, input, hint) {
  return h("label", { class: "field" }, h("span", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null);
}
const input = (attrs = {}) => h("input", { class: "input", ...attrs });

function switchEl(checked, onChange, label) {
  const inp = h("input", { type: "checkbox", checked, "aria-label": label || "" });
  if (onChange) inp.addEventListener("change", () => onChange(inp.checked, inp));
  return { el: h("label", { class: "switch" }, inp, h("span", { class: "slider" })), input: inp };
}

/** رفع صورة مع ضغط تلقائي في المتصفح ومعاينة فورية */
function imageField(label, url, kind, { square = false, maxSize = 1280, wide = false } = {}) {
  let value = url || null;
  const preview = h("div", { class: "ph", "aria-hidden": "true" }, "🖼️");
  const status = h("span", { class: "hint" }, value ? "" : "لم يتم اختيار صورة");
  const removeBtn = h("button", { class: "btn btn-ghost btn-sm", type: "button", hidden: !value }, "إزالة");
  const pickBtn = h("button", { class: "btn btn-soft btn-sm", type: "button" }, value ? "تغيير" : "اختيار صورة");
  let current = preview;
  const show = (src) => {
    const n = src ? h("img", { src, alt: "" }) : h("div", { class: "ph", "aria-hidden": "true" }, "🖼️");
    current.replaceWith(n); current = n;
  };
  show(value);

  pickBtn.addEventListener("click", async () => {
    const file = await pickFile("image/jpeg,image/png,image/webp,image/*");
    if (!file) return;
    pickBtn.disabled = true;
    fill(status, h("span", { class: "spinner" }), " جاري الضغط والرفع...");
    try {
      const blob = await compressImage(file, { square, maxSize });
      const local = URL.createObjectURL(blob);
      show(local);
      value = await uploadImage(sb, token, kind, blob);
      status.textContent = `✅ تم الرفع (${Math.round(blob.size / 1024)} KB)`;
      removeBtn.hidden = false;
      pickBtn.textContent = "تغيير";
    } catch (e) {
      status.textContent = e.message?.includes("صورة") || e.message?.includes("ضغط") ? e.message : friendlyError(e);
      show(value);
    } finally {
      pickBtn.disabled = false;
    }
  });
  removeBtn.addEventListener("click", () => { value = null; show(null); removeBtn.hidden = true; status.textContent = "سيتم إزالة الصورة عند الحفظ"; });

  const el = h("div", { class: "field" }, h("span", { class: "label", text: label }),
    h("div", { class: `upload-box${wide ? " wide" : ""}` }, current,
      h("div", { class: "grow stack", style: { gap: "4px" } }, h("div", { class: "row" }, pickBtn, removeBtn), status)));
  // current مُضاف داخل el، والاستبدال يتم في مكانه
  return { el, get: () => value };
}

/** محرر صفوف (أحجام / إضافات / مواصفات) */
function rowsEditor(rows, cols, addLabel) {
  const wrap = h("div", { class: "rows-editor" });
  const list = h("div", { class: "rows-editor" });
  const addRow = (r = {}) => {
    const inputs = cols.map((c) => input({ placeholder: c.placeholder, value: r[c.key] ?? "", type: c.type || "text",
      inputmode: c.type === "number" ? "decimal" : null, min: c.type === "number" ? "0" : null, step: c.type === "number" ? "0.01" : null,
      maxlength: c.max ? String(c.max) : null, "aria-label": c.placeholder }));
    const row = h("div", { class: "r" }, inputs,
      h("button", { class: "btn btn-danger icon-btn", type: "button", "aria-label": "حذف", onClick: () => row.remove() }, "✕"));
    row._inputs = inputs;
    list.append(row);
  };
  (rows || []).forEach(addRow);
  wrap.append(list, h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => addRow() }, `+ ${addLabel}`));
  return {
    el: wrap,
    get: () => [...list.children].map((row) => Object.fromEntries(cols.map((c, i) => [c.key,
      c.type === "number" ? num(row._inputs[i].value) : oneLine(row._inputs[i].value, c.max || 60)])))
      .filter((r) => r[cols[0].key]),
  };
}

/* =========================================================
   تبويب 1: المنيو / العناصر
   ========================================================= */
function tabMenu(panel) {
  const s = D.store;
  const mode = MODES[s.business_mode];
  const products = [...D.products].sort((a, b) => a.sort_order - b.sort_order);

  root.append(h("button", { class: "fab", type: "button", "aria-label": `إضافة ${mode.item}`, onClick: () => productForm(null) },
    h("span", { class: "plus", "aria-hidden": "true" }, "+"), `إضافة ${mode.item}`));

  if (s.business_mode === "order") {
    panel.append(h("button", { class: "promo-card", type: "button", onClick: visionImport },
      h("span", { class: "i", "aria-hidden": "true" }, "📷"),
      h("span", {}, h("b", {}, "أضف منيو من صورة"), h("small", {}, "صوّر المنيو الورقي ونستخرج الأصناف والأسعار تلقائياً")),
      h("span", { class: "go" }, `${D.vision_left}/5 ←`)));
  }

  if (!products.length) {
    panel.append(h("div", { class: "card empty-state" }, h("img", { src: "/assets/img/empty.svg", alt: "" }),
      h("b", { text: `لا توجد ${mode.items} بعد` }), h("span", { class: "muted small", text: `ابدأ بإضافة أول ${mode.item} من الزر بالأسفل` })));
    return;
  }

  let filter = ls.get("manage_filter", "all", true) || "all";
  const counts = { all: products.length, on: products.filter((p) => p.is_available).length };
  counts.off = counts.all - counts.on;
  const seg = h("div", { class: "seg-tabs", role: "tablist" });
  const drawSeg = () => fill(seg, ...[["all", "الكل"], ["on", "المتوفر"], ["off", "غير المتوفر"]].map(([k, l]) =>
    h("button", { type: "button", class: filter === k ? "active" : "", onClick: () => { filter = k; ls.set("manage_filter", k, true); drawSeg(); draw(); } },
      l, h("span", { class: "n" }, String(counts[k])))));
  drawSeg();

  const search = input({ type: "search", placeholder: `بحث في ${mode.items}...`, "aria-label": "بحث" });
  const listWrap = h("div", { class: "stack" });
  const sortBtn = h("button", { class: `btn btn-sm ${reorderMode ? "btn-primary" : "btn-outline"}`, type: "button", onClick: () => { reorderMode = !reorderMode; renderShell(); } },
    reorderMode ? "✔️ تم الترتيب" : "↕️ ترتيب");
  panel.append(h("div", { class: "row" }, h("div", { class: "grow" }, seg), products.length > 1 ? sortBtn : null));
  if (reorderMode) panel.append(h("div", { class: "alert alert-info" }, "استخدم الأسهم لترتيب الأصناف والأقسام — يتغير الترتيب في المتجر فوراً."));
  if (products.length > 8) panel.append(h("div", { class: "search-box" }, h("span", { class: "i", "aria-hidden": "true" }, "🔍"), search));
  panel.append(listWrap);

  const draw = () => {
    const q = oneLine(search.value, 40);
    const groups = new Map();
    for (const p of products) {
      if (filter === "on" && !p.is_available) continue;
      if (filter === "off" && p.is_available) continue;
      if (q && !p.name.includes(q) && !(p.category || "").includes(q)) continue;
      const k = p.category || mode.items;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    if (!groups.size) return fill(listWrap, h("div", { class: "card center muted" }, "لا توجد عناصر في هذا التصنيف"));
    fill(listWrap, ...[...groups.entries()].map(([cat, items]) => h("div", { class: "stack", style: { gap: "10px" } },
      h("div", { class: "sec-title" }, h("b", { text: cat }),
        reorderMode ? h("span", { class: "row", style: { gap: "6px" } },
          h("button", { class: "rbtn", type: "button", "aria-label": `تحريك قسم ${cat} للأعلى`, onClick: () => moveCategory(items[0].category || "", -1) }, "▲"),
          h("button", { class: "rbtn", type: "button", "aria-label": `تحريك قسم ${cat} للأسفل`, onClick: () => moveCategory(items[0].category || "", 1) }, "▼"))
          : h("span", { text: `${items.length} ${mode.item}` })),
      ...items.map((p) => itemRow(p)))));
  };
  search.addEventListener("input", draw);
  draw();
}

function itemRow(p) {
  const hasSizes = (p.options_json?.sizes || []).length > 0;
  const row = h("div", { class: `pcard item-row${p.is_available ? "" : " off"}` });
  const priceInp = input({ class: "input price-input", type: "number", inputmode: "decimal", min: "0", step: "0.01",
    value: String(num(p.price)), "aria-label": `سعر ${p.name}` });
  priceInp.addEventListener("change", async () => {
    const v = num(priceInp.value);
    if (v < 0) return;
    try {
      const r = await save("merchant_quick_update", { p_id: p.id, p_is_available: null, p_price: v }, "تم تحديث السعر ✅");
      p.price = r.price;
    } catch { priceInp.value = String(num(p.price)); }
  });
  const stateLbl = h("span", { text: p.is_available ? "ظاهر" : "مخفي" });
  const sw = switchEl(p.is_available, async (checked, inp) => {
    try {
      await save("merchant_quick_update", { p_id: p.id, p_is_available: checked, p_price: null }, checked ? "أصبح ظاهراً للعملاء ✅" : "تم الإخفاء من المتجر");
      p.is_available = checked;
      row.classList.toggle("off", !checked);
      stateLbl.textContent = checked ? "ظاهر" : "مخفي";
    } catch { inp.checked = !checked; }
  }, `إظهار ${p.name}`);

  const del = h("button", { class: "rbtn danger", type: "button", "aria-label": "حذف", onClick: async () => {
    if (!(await confirmDialog(`حذف «${p.name}» نهائياً؟`, { okText: "حذف", danger: true }))) return;
    try { await save("merchant_delete_product", { p_id: p.id }, "تم الحذف"); await loadDash(); } catch { /* handled */ }
  } }, "🗑️");
  const minSize = hasSizes ? Math.min(...p.options_json.sizes.map((x) => num(x.price))) : 0;
  const meta = [];
  if (p.category) meta.push(h("span", {}, "📂 ", p.category));
  if (hasSizes) meta.push(h("span", {}, "📏 ", `${p.options_json.sizes.length} أحجام`));
  if ((p.options_json?.addons || []).length) meta.push(h("span", {}, "➕ ", `${p.options_json.addons.length} إضافات`));
  if (p.stock != null) meta.push(h("span", { class: p.stock === 0 ? "out" : "" }, "📦 ", p.stock === 0 ? "نفدت الكمية" : `${p.stock} متوفر`));
  if (num(p.options_json?.old_price) > 0) meta.push(h("span", {}, "🏷️ ", "عليه خصم"));

  row.append(
    h("div", { class: "pc-media" }, p.image_url ? h("img", { src: p.image_url, alt: "", loading: "lazy" }) : "🍽️"),
    h("div", { class: "pc-info" },
      h("div", { class: "pc-name", text: p.name }),
      meta.length ? h("div", { class: "pc-meta" }, meta) : null,
      h("div", { class: "pc-foot" },
        h("div", { class: "pc-price" }, hasSizes ? h("span", { text: `من ${money(minSize)}` }) : [priceInp, h("span", { class: "small" }, CONFIG.CURRENCY)]),
        h("label", { class: "pc-toggle" }, stateLbl, sw.el))),
    h("div", { class: "pc-actions" }, reorderMode
      ? [h("button", { class: "rbtn", type: "button", "aria-label": `تحريك ${p.name} للأعلى`, onClick: () => moveProduct(p, -1) }, "▲"),
         h("button", { class: "rbtn", type: "button", "aria-label": `تحريك ${p.name} للأسفل`, onClick: () => moveProduct(p, 1) }, "▼")]
      : [h("button", { class: "rbtn", type: "button", "aria-label": "تعديل", onClick: () => productForm(p) }, "✏️"), del]));
  return row;
}

function productForm(p) {
  const s = D.store;
  const modeId = s.business_mode;
  const mode = MODES[modeId];
  const o = p?.options_json || {};
  const cats = [...new Set(D.products.map((x) => x.category).filter(Boolean))];
  const listId = "cats-list";

  const name = input({ value: p?.name || "", maxlength: "120", required: true });
  const category = input({ value: p?.category || "", maxlength: "60", list: listId, placeholder: "مثال: وجبات، مشروبات" });
  const desc = h("textarea", { class: "textarea", maxlength: "1000", value: p?.description || "" });
  const price = input({ type: "number", inputmode: "decimal", min: "0", step: "0.01", value: p ? String(num(p.price)) : "" });
  const image = imageField("الصورة الرئيسية", p?.image_url, "product", { maxSize: 1000 });
  const avail = switchEl(p ? p.is_available : true, null, "ظاهر للعملاء");

  const body = [
    field(`اسم ال${mode.item}`, name),
    h("div", {}, field("القسم", category), h("datalist", { id: listId }, cats.map((c) => h("option", { value: c })))),
    field("الوصف", desc),
    image.el,
  ];

  let sizes, addons, specs, unitSel, gallery, blocked, oldPriceIn, stockIn;
  const priceLabel = { order: "السعر", booking: "السعر لكل وحدة زمنية", inquiry: "السعر (اختياري)", charity: "قيمة السهم (اختياري)", legal: "رسوم الاستشارة (اختياري)" }[modeId];

  if (modeId === "booking" || modeId === "inquiry") {
    const units = modeId === "booking" ? ["ليلة", "يوم", "ساعة"] : ["", "شهر", "يوم"];
    unitSel = h("select", { class: "select" }, units.map((u) => h("option", { value: u, selected: (o.unit || units[0]) === u }, u || "بدون")));
    body.push(h("div", { class: "row" }, h("div", { class: "grow" }, field(priceLabel, price)), h("div", { style: { width: "120px" } }, field("لكل", unitSel))));
  } else {
    body.push(field(priceLabel, price, modeId === "order" ? "إذا أضفت أحجاماً سيُعتمد سعر الحجم المختار" : null));
  }
  if (modeId === "order") {
    oldPriceIn = input({ type: "number", inputmode: "decimal", min: "0", step: "0.01", value: o.old_price ? String(num(o.old_price)) : "", placeholder: "اختياري" });
    stockIn = input({ type: "number", inputmode: "numeric", min: "0", step: "1", value: p?.stock != null ? String(p.stock) : "", placeholder: "غير محدود" });
    body.push(h("div", { class: "row" },
      h("div", { class: "grow" }, field("السعر قبل الخصم", oldPriceIn, "يظهر مشطوباً بجانب السعر")),
      h("div", { class: "grow" }, field("الكمية المتوفرة", stockIn, "تنقص مع كل طلب"))));
  }

  if (modeId === "order") {
    sizes = rowsEditor(o.sizes, [{ key: "name", placeholder: "الحجم / النوع", max: 40 }, { key: "price", placeholder: "السعر", type: "number" }], "إضافة حجم");
    addons = rowsEditor(o.addons, [{ key: "name", placeholder: "الإضافة", max: 40 }, { key: "price", placeholder: "السعر", type: "number" }], "إضافة إضافة");
    body.push(h("div", { class: "field" }, h("span", { class: "label" }, "الأحجام / الأنواع (اختيار إلزامي للعميل)"), sizes.el));
    body.push(h("div", { class: "field" }, h("span", { class: "label" }, "الإضافات (اختيارية)"), addons.el));
  }
  if (modeId === "booking" || modeId === "inquiry") {
    specs = rowsEditor(o.specs, [{ key: "label", placeholder: "المواصفة (مثال: المساحة)", max: 40 }, { key: "value", placeholder: "القيمة", max: 120 }], "إضافة مواصفة");
    specs.el.querySelectorAll(".r").forEach((r) => r.style.setProperty("grid-template-columns", "1fr 1fr 40px"));
    body.push(h("div", { class: "field" }, h("span", { class: "label" }, "المواصفات"), specs.el));
    gallery = galleryField(p?.gallery_json || []);
    body.push(gallery.el);
  }
  if (modeId === "booking") {
    blocked = blockedDatesField(o.blocked_dates);
    body.push(blocked.el);
  }
  body.push(h("div", { class: "row between card", style: { "box-shadow": "none" } }, h("b", {}, "ظاهر للعملاء"), avail.el));

  const saveBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, p ? "حفظ التعديلات" : `إضافة ال${mode.item}`);
  const sheet = openSheet({ title: p ? `تعديل: ${p.name}` : `إضافة ${mode.item}`, body, foot: saveBtn });

  saveBtn.addEventListener("click", async () => {
    if (!oneLine(name.value, 120)) { name.classList.add("invalid"); name.focus(); return toast("الاسم مطلوب", "error"); }
    const sz = sizes?.get() || [];
    if (modeId === "order" && !sz.length && price.value === "") { price.classList.add("invalid"); return toast("أدخل السعر أو أضف أحجاماً", "error"); }
    const payload = {
      id: p?.id || null,
      name: oneLine(name.value, 120),
      category: oneLine(category.value, 60),
      description: desc.value.slice(0, 1000),
      price: String(sz.length ? Math.min(...sz.map((x) => x.price)) : num(price.value)),
      image_url: image.get(),
      gallery_json: gallery ? gallery.get() : (p?.gallery_json || []),
      options_json: {
        ...(sizes ? { sizes: sz } : {}),
        ...(addons ? { addons: addons.get() } : {}),
        ...(specs ? { specs: specs.get() } : {}),
        ...(unitSel && unitSel.value ? { unit: unitSel.value } : {}),
        ...(oldPriceIn && num(oldPriceIn.value) > 0 ? { old_price: String(num(oldPriceIn.value)) } : {}),
        ...(blocked ? { blocked_dates: blocked.get() } : {}),
      },
      stock: stockIn && stockIn.value !== "" ? String(Math.max(0, Math.floor(num(stockIn.value)))) : null,
      is_available: avail.input.checked,
    };
    saveBtn.disabled = true;
    try {
      await save("merchant_save_product", { p_product: payload });
      sheet.close();
      await loadDash();
    } catch { /* handled */ } finally { saveBtn.disabled = false; }
  });
}

function galleryField(urls) {
  let list = [...urls].slice(0, 8);
  const thumbs = h("div", { class: "thumbs" });
  const status = h("span", { class: "hint" });
  const addBtn = h("button", { class: "btn btn-soft btn-sm", type: "button" }, "+ إضافة صور");
  const draw = () => {
    fill(thumbs, ...list.map((u, i) => h("div", { class: "t" }, h("img", { src: u, alt: "" }),
      h("button", { class: "x", type: "button", "aria-label": "حذف الصورة", onClick: () => { list.splice(i, 1); draw(); } }, "✕"))));
    addBtn.hidden = list.length >= 8;
  };
  addBtn.addEventListener("click", async () => {
    const file = await pickFile("image/*");
    if (!file) return;
    addBtn.disabled = true;
    fill(status, h("span", { class: "spinner" }), " جاري الرفع...");
    try {
      const blob = await compressImage(file, { maxSize: 1400 });
      list.push(await uploadImage(sb, token, "gallery", blob));
      status.textContent = "";
      draw();
    } catch (e) { status.textContent = friendlyError(e); } finally { addBtn.disabled = false; }
  });
  draw();
  return { el: h("div", { class: "field" }, h("span", { class: "label" }, "معرض الصور (حتى 8)"), thumbs, h("div", { class: "row" }, addBtn, status)), get: () => list };
}

/* ---------------- إضافة منيو من صورة (Vision) ---------------- */
async function visionImport() {
  if (D.vision_left <= 0) return toast("استهلكت الحد اليومي (5 صور). جرّب غداً", "error");
  const file = await pickFile("image/*");
  if (!file) return;

  const body = h("div", { class: "stack center" }, h("span", { class: "spinner", style: { margin: "20px auto" } }),
    h("b", {}, "جاري تحليل صورة المنيو..."), h("span", { class: "hint" }, "قد يستغرق ذلك حتى دقيقة"));
  const sheet = openSheet({ title: "إضافة منيو من صورة", body });

  let res;
  try {
    const blob = await compressImage(file, { maxSize: 1800, quality: 0.85, forceJpeg: true, maxBytes: 1.9 * 1024 * 1024 });
    res = await callFunction("vision-menu", { token, image_base64: await blobToBase64(blob), media_type: blob.type });
  } catch (e) {
    fill(sheet.body, h("div", { class: "alert alert-danger" }, friendlyError(e)));
    if (e.data?.remaining === 0) D.vision_left = 0;
    return;
  }
  D.vision_left = res.remaining;
  const items = res.items || [];
  if (!items.length) {
    fill(sheet.body, h("div", { class: "alert alert-info" }, "لم نتمكن من التعرف على أصناف. جرّب صورة أوضح بإضاءة جيدة."));
    return;
  }

  const rows = items.map((it) => {
    const chk = h("input", { type: "checkbox", checked: true, "aria-label": "اعتماد", style: { width: "20px", height: "20px" } });
    const nm = input({ value: it.name, maxlength: "120", "aria-label": "الاسم" });
    const pr = input({ type: "number", value: String(it.price), inputmode: "decimal", min: "0", step: "0.01", "aria-label": "السعر", class: "input price-input" });
    const el = h("div", { class: "vision-item" }, chk, nm, pr,
      h("div", { class: "sizes" }, it.category ? `📂 ${it.category}` : "", it.sizes?.length ? `  •  ${it.sizes.map((s) => `${s.name}: ${s.price}`).join(" | ")}` : ""));
    return { el, get: () => chk.checked ? { ...it, name: oneLine(nm.value, 120), price: num(pr.value) } : null };
  });
  const approve = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, `✅ اعتماد الأصناف المحددة (${items.length})`);
  fill(sheet.body, 
    h("div", { class: "alert alert-info" }, `تم استخراج ${items.length} صنف. راجع الأسماء والأسعار ثم اعتمدها. (المتبقي اليوم: ${res.remaining})`),
    ...rows.map((r) => r.el));
  const foot = h("div", { class: "sheet-foot" }, approve);
  sheet.sheet.append(foot);

  approve.addEventListener("click", async () => {
    const chosen = rows.map((r) => r.get()).filter((x) => x && x.name);
    if (!chosen.length) return toast("لم تحدد أي صنف", "error");
    approve.disabled = true;
    try {
      const n = await save("merchant_import_products", { p_items: chosen }, `تمت إضافة ${chosen.length} صنف ✅`);
      if (n !== chosen.length) toast(`أُضيف ${n} فقط`, "");
      sheet.close();
      await loadDash();
    } catch { approve.disabled = false; }
  });
}

/* =========================================================
   تبويب 2: إعدادات المتجر
   ========================================================= */
function tabSettings(panel) {
  const s = D.store;

  // زر الإغلاق الطارئ — يُحفظ فوراً
  const emergency = switchEl(s.is_open, async (checked, inp) => {
    try {
      await save("merchant_update_store", { p_patch: { is_open: checked } }, checked ? "✅ المتجر يستقبل الطلبات الآن" : "🔒 تم إغلاق المتجر مؤقتاً");
      s.is_open = checked;
      state.textContent = checked ? "يستقبل الطلبات حسب أوقات العمل" : "مغلق يدوياً — لن تصل أي طلبات";
    } catch { inp.checked = !checked; }
  }, "استقبال الطلبات");
  const state = h("div", { class: "hint", text: s.is_open ? "يستقبل الطلبات حسب أوقات العمل" : "مغلق يدوياً — لن تصل أي طلبات" });
  panel.append(h("div", { class: "card row between" }, h("div", {}, h("b", {}, "🚨 استقبال الطلبات الآن"), state), emergency.el));

  const name = input({ value: s.name, maxlength: "80" });
  const type = input({ value: s.business_type || "", maxlength: "60", placeholder: "مثال: مطعم مشويات" });
  const logo = imageField("الشعار (يظهر كأيقونة التطبيق)", s.logo_url, "logo", { square: true, maxSize: 512 });
  const phone = input({ type: "tel", inputmode: "tel", value: s.whatsapp_phone, dir: "ltr", maxlength: "20" });
  const fee = input({ type: "number", inputmode: "decimal", min: "0", step: "0.5", value: String(num(s.delivery_fee)) });
  const iban = input({ value: s.iban_number || "", dir: "ltr", maxlength: "40", placeholder: "SA00 0000 0000 0000 0000 0000" });

  const hours = hoursEditor(s);
  const minOrder = input({ type: "number", inputmode: "decimal", min: "0", step: "1", value: String(num(s.min_order)) });
  const zones = rowsEditor(s.delivery_zones || [], [{ key: "name", placeholder: "اسم الحي", max: 40 }, { key: "fee", placeholder: "الرسوم", type: "number" }], "إضافة حي");

  const card = h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "بيانات المتجر"),
    field("اسم المتجر", name), field("نوع النشاط", type), logo.el,
    field("رقم واتساب لاستقبال الطلبات", phone, "مثال: 0501234567 أو 966501234567"),
    (s.business_mode === "charity" || s.business_mode === "order") ? field(s.business_mode === "charity" ? "الآيبان الرسمي للتبرعات" : "الآيبان (للدفع بالتحويل - اختياري)", iban) : null);

  const deliveryCard = s.business_mode === "order" ? h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "🛵 التوصيل"),
    field(`رسوم التوصيل (${CONFIG.CURRENCY})`, fee, "تُستخدم إذا ما أضفت أحياء. اكتب 0 للتوصيل المجاني"),
    field(`الحد الأدنى لطلبات التوصيل (${CONFIG.CURRENCY})`, minOrder, "اكتب 0 بدون حد أدنى"),
    h("div", { class: "field" }, h("span", { class: "label" }, "مناطق التوصيل (اختياري)"), zones.el,
      h("span", { class: "hint", text: "إذا أضفت أحياء، يختار العميل حيّه من قائمة ويُحسب سعر التوصيل حسب الحي." }))) : null;

  const saveBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "💾 حفظ الإعدادات");
  saveBtn.addEventListener("click", async () => {
    if (oneLine(name.value, 80).length < 2) return toast("اسم المتجر مطلوب", "error");
    let hrs;
    try { hrs = hours.get(); } catch (e) { return toast(e.message, "error"); }
    const patch = {
      name: oneLine(name.value, 80), business_type: oneLine(type.value, 60), logo_url: logo.get(),
      whatsapp_phone: phone.value, ...hrs,
    };
    if (s.business_mode === "order") {
      patch.delivery_fee = String(num(fee.value));
      patch.min_order = String(num(minOrder.value));
      patch.delivery_zones = zones.get().map((z) => ({ name: z.name, fee: String(z.fee) }));
    }
    if (s.business_mode === "charity" || s.business_mode === "order") patch.iban_number = iban.value;
    saveBtn.disabled = true;
    try { await save("merchant_update_store", { p_patch: patch }); await loadDash(); } catch { /* handled */ } finally { saveBtn.disabled = false; }
  });

  panel.append(...[card, deliveryCard, hours.el, saveBtn, pinCard(), linksCard()].filter(Boolean));
}

function pinCard() {
  const oldP = input({ type: "password", inputmode: "numeric", maxlength: "8", autocomplete: "current-password" });
  const newP = input({ type: "password", inputmode: "numeric", maxlength: "8", autocomplete: "new-password" });
  const btn = h("button", { class: "btn btn-block", type: "button" }, "تغيير رمز PIN");
  btn.addEventListener("click", async () => {
    const n = toLatinDigits(newP.value);
    if (!/^\d{4,8}$/.test(n)) return toast("الرمز الجديد من 4 إلى 8 أرقام", "error");
    try {
      const r = await rpc(sb, "merchant_change_pin", { p_token: token, p_old_pin: toLatinDigits(oldP.value), p_new_pin: n });
      if (r.ok) { toast("تم تغيير الرمز ✅ وتم تسجيل خروج الأجهزة الأخرى", "success"); oldP.value = newP.value = ""; }
      else toast(r.error === "invalid" ? "الرمز الحالي غير صحيح" : r.error === "rate_limited" ? "محاولات كثيرة، حاول لاحقاً" : "رمز ضعيف", "error");
    } catch (e) { toast(friendlyError(e), "error"); }
  });
  return h("details", { class: "card" }, h("summary", { style: { cursor: "pointer", "font-weight": "700" } }, "🔐 تغيير رمز الدخول"),
    h("div", { class: "stack mt" }, field("الرمز الحالي", oldP), field("الرمز الجديد", newP), btn));
}

function linksCard() {
  const url = `${location.origin}/?store=${slug}`;
  return h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "رابط متجرك"),
    h("div", { class: "copy-field" }, input({ value: url, readonly: true, "aria-label": "رابط المتجر" }),
      h("button", { class: "btn btn-soft", type: "button", onClick: () => copyText(url) }, "نسخ")));
}

/* =========================================================
   تبويب 3: التصميم
   ========================================================= */
function tabDesign(panel) {
  const s = D.store;
  let theme = s.theme_style;
  let color = s.custom_primary_color || "";

  const preview = () => applyTheme({ theme_style: theme, custom_primary_color: color || null });

  const grid = h("div", { class: "theme-grid" });
  const drawGrid = () => fill(grid, ...THEMES.map((t) => {
    const b = h("button", { type: "button", class: `theme-card${t.id === theme ? " active" : ""}`, "aria-pressed": t.id === theme ? "true" : "false" },
      h("div", { class: "sw" }, h("i", { style: { background: t.primary } }), h("i", { style: { background: t.bg } })),
      h("b", { text: t.label }));
    b.addEventListener("click", () => { theme = t.id; drawGrid(); preview(); });
    return b;
  }));
  drawGrid();

  const picker = h("input", { type: "color", value: color || "#ea580c", "aria-label": "اللون الأساسي",
    style: { width: "64px", height: "44px", border: "0", background: "none", padding: "0" } });
  const useCustom = switchEl(!!color, (c) => { color = c ? picker.value : ""; preview(); }, "استخدام لون مخصص");
  picker.addEventListener("input", () => { if (useCustom.input.checked) { color = picker.value; preview(); } });

  const cover = imageField("صورة الغلاف", s.cover_url, "cover", { maxSize: 1600, wide: true });
  const logo = imageField("الشعار", s.logo_url, "logo", { square: true, maxSize: 512 });

  const sample = h("div", { class: "card stack" },
    h("div", { class: "row between" }, h("b", {}, "معاينة"), h("span", { class: "badge" }, "مثال")),
    h("div", { class: "product", style: { cursor: "default" } }, h("div", { class: "product-img ph" }, "🍔"),
      h("div", { class: "product-body" }, h("b", {}, "اسم الصنف"), h("span", { class: "muted small" }, "وصف قصير"),
        h("div", { class: "product-foot" }, h("span", { class: "price" }, money(25)), h("span", { class: "add-dot" }, "+")))),
    h("button", { class: "btn btn-primary", type: "button" }, "زر رئيسي"));

  const saveBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "💾 حفظ التصميم");
  saveBtn.addEventListener("click", async () => {
    saveBtn.disabled = true;
    try {
      await save("merchant_update_store", { p_patch: { theme_style: theme, custom_primary_color: color || "", cover_url: cover.get(), logo_url: logo.get() } });
      await loadDash();
    } catch { /* handled */ } finally { saveBtn.disabled = false; }
  });

  panel.append(
    h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "القالب الجاهز"), grid),
    h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "اللون الأساسي"),
      h("div", { class: "row between" }, h("span", {}, "تخصيص اللون"), useCustom.el), h("div", { class: "row" }, picker, h("span", { class: "hint", text: "يغيّر لون الأزرار والأسعار فقط ويحافظ على باقي القالب" }))),
    h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "الصور"), cover.el, logo.el),
    sample, saveBtn);
}

/* =========================================================
   تبويب 4: العروض والبنرات
   ========================================================= */
function tabOffers(panel) {
  const s = D.store;
  const active = switchEl(s.banner_active, null, "تفعيل البنر");
  const text = input({ value: s.banner_text || "", maxlength: "200", placeholder: "مثال: 🔥 خصم 20% على جميع الوجبات اليوم" });
  const image = imageField("صورة البنر (اختياري)", s.banner_image_url, "banner", { maxSize: 1400, wide: true });

  const hasFuture = s.banner_expires_at && new Date(s.banner_expires_at) > new Date();
  let timer = hasFuture ? "keep" : "none";
  const custom = input({ type: "datetime-local", hidden: true });
  const opts = [
    ...(hasFuture ? [{ v: "keep", l: "الإبقاء على الحالي" }] : []),
    { v: "none", l: "بدون عداد" }, { v: "6", l: "6 ساعات" }, { v: "24", l: "24 ساعة" }, { v: "48", l: "48 ساعة" },
    { v: "168", l: "أسبوع" }, { v: "custom", l: "تاريخ محدد" },
  ];
  const seg = h("div", { class: "segmented" }, opts.map((o) => h("label", {},
    h("input", { type: "radio", name: "timer", value: o.v, checked: o.v === timer,
      onChange: () => { timer = o.v; custom.hidden = o.v !== "custom"; } }),
    h("span", {}, o.l))));

  const statusLine = h("div", { class: "hint" });
  if (s.banner_active && hasFuture) {
    const tick = (first = false) => {
      if (!first && !statusLine.isConnected) return clearInterval(t);
      const left = new Date(s.banner_expires_at) - Date.now();
      if (left <= 0) { statusLine.textContent = "انتهى العرض"; return clearInterval(t); }
      const sec = Math.floor(left / 1000);
      statusLine.textContent = `⏳ العرض الحالي ينتهي بعد ${Math.floor(sec / 3600)} ساعة و${Math.floor((sec % 3600) / 60)} دقيقة`;
    };
    const t = setInterval(tick, 30000); tick(true);
  } else if (s.banner_active && s.banner_expires_at && !hasFuture) {
    statusLine.textContent = "انتهت مدة العرض السابق — اختر مدة جديدة";
  }

  const saveBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "💾 حفظ العرض");
  saveBtn.addEventListener("click", async () => {
    if (active.input.checked && !oneLine(text.value, 200) && !image.get()) return toast("أضف نصاً أو صورة للبنر", "error");
    let expires;
    if (timer === "keep") expires = s.banner_expires_at;
    else if (timer === "none") expires = "";
    else if (timer === "custom") {
      if (!custom.value) return toast("حدد تاريخ ووقت نهاية العرض", "error");
      const d = new Date(custom.value);
      if (!(d > new Date())) return toast("تاريخ النهاية يجب أن يكون في المستقبل", "error");
      expires = d.toISOString();
    } else expires = new Date(Date.now() + Number(timer) * 3600000).toISOString();

    saveBtn.disabled = true;
    try {
      await save("merchant_update_store", { p_patch: {
        banner_active: active.input.checked, banner_text: oneLine(text.value, 200),
        banner_image_url: image.get(), banner_expires_at: expires,
      } });
      await loadDash();
    } catch { /* handled */ } finally { saveBtn.disabled = false; }
  });

  panel.append(
    h("div", { class: "card row between" }, h("div", {}, h("b", {}, "📣 إظهار البنر في المتجر"), h("div", { class: "hint" }, "يظهر أعلى المنيو مباشرة")), active.el),
    h("div", { class: "card stack" }, field("النص الترويجي", text), image.el),
    h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "⏱️ عداد تنازلي للعرض"),
      seg, custom, statusLine, h("div", { class: "hint", text: "يختفي البنر تلقائياً من المتجر عند انتهاء المدة." })),
    saveBtn);
  if (s.business_mode === "order") panel.append(couponsCard());
}

/* =========================================================
   الإصدار 2: سجل الطلبات، الإحصائيات، الكوبونات، أوقات العمل لكل يوم،
   مناطق التوصيل، المخزون، أيام الحجز المحجوزة، ترتيب الأصناف
   ========================================================= */
const ORDER_PREFIX = { order: "ORD", booking: "BK", inquiry: "RQ", charity: "DN", legal: "LG" };
const STATUS = {
  new: { label: "جديد", cls: "badge-warning" },
  confirmed: { label: "مؤكد", cls: "badge" },
  done: { label: "مكتمل", cls: "badge-success" },
  cancelled: { label: "ملغي", cls: "badge-danger" },
};
const WD = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

function timeAgo(iso) {
  const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return "الآن";
  if (sec < 3600) return `قبل ${Math.floor(sec / 60)} دقيقة`;
  if (sec < 86400) return `قبل ${Math.floor(sec / 3600)} ساعة`;
  return new Date(iso).toLocaleString("ar-u-ca-gregory-nu-latn", { dateStyle: "medium", timeStyle: "short" });
}

/* ---------------- سجل الطلبات ---------------- */
async function openOrders(initial = "new") {
  let status = initial;
  let before = null;
  const tabsEl = h("div", { class: "status-tabs", role: "tablist" });
  const list = h("div", { class: "stack" });
  const more = h("button", { class: "btn btn-block", type: "button", hidden: true }, "عرض المزيد");
  const sheet = openSheet({ title: "🧾 سجل الطلبات", body: [tabsEl, list, more], className: "orders-sheet" });

  async function load(reset) {
    if (reset) { before = null; fill(list, h("div", { class: "center muted" }, h("span", { class: "spinner" }))); }
    let r;
    try {
      r = await rpc(sb, "merchant_list_orders", { p_token: token, p_status: status === "all" ? null : status, p_limit: 20, p_before: before });
    } catch (e) { return fill(list, h("div", { class: "alert alert-danger" }, friendlyError(e))); }
    const c = r.counts || {};
    fill(tabsEl, ...[["new", "جديد"], ["confirmed", "مؤكد"], ["done", "مكتمل"], ["cancelled", "ملغي"], ["all", "الكل"]].map(([k, l]) =>
      h("button", { type: "button", class: status === k ? "active" : "", onClick: () => { status = k; load(true); } },
        k === "all" ? l : `${l} (${c[k] ?? 0})`)));
    if (reset) fill(list);
    if (reset && !r.orders.length) {
      list.append(h("div", { class: "empty-state" }, h("img", { src: "/assets/img/empty.svg", alt: "" }), h("b", {}, "لا توجد طلبات هنا"),
        h("span", { class: "muted small" }, "تظهر الطلبات هنا تلقائياً أول ما يضغط العميل إرسال عبر واتساب")));
    }
    r.orders.forEach((o) => list.append(orderCard(o, () => load(true))));
    before = r.orders.length ? r.orders[r.orders.length - 1].id : before;
    more.hidden = r.orders.length < 20;
  }
  more.addEventListener("click", () => load(false));
  await load(true);
  return sheet;
}

function orderCard(o, reload) {
  const m = o.meta || {};
  const mode = m.mode || D.store.business_mode;
  const st = STATUS[o.status] || STATUS.new;
  const items = Array.isArray(o.items) ? o.items : [];
  const setStatus = async (next, confirmMsg) => {
    if (confirmMsg && !(await confirmDialog(confirmMsg, { okText: "تأكيد", danger: next === "cancelled" }))) return;
    try {
      await save("merchant_set_order_status", { p_event_id: o.id, p_status: next }, `تم تحويل الطلب إلى «${STATUS[next].label}»`);
      reload();
    } catch { /* handled */ }
  };
  const phone = m.phone ? normalizePhone(m.phone) : "";
  const greet = `مرحباً ${m.name || ""}، بخصوص طلبك #${ORDER_PREFIX[mode] || "ORD"}-${o.order_no} من ${D.store.name}`;
  const actions = {
    new: [["✅ تأكيد الطلب", "confirmed", "btn-primary"], ["إلغاء", "cancelled", "btn-danger", "إلغاء هذا الطلب؟ سيتم إرجاع الكميات للمخزون."]],
    confirmed: [["✔️ تم التسليم", "done", "btn-primary"], ["إلغاء", "cancelled", "btn-danger", "إلغاء هذا الطلب؟ سيتم إرجاع الكميات للمخزون."]],
    done: [["↩️ إعادة فتح", "confirmed", ""]],
    cancelled: [["↩️ إعادة فتح", "new", ""]],
  }[o.status] || [];

  return h("article", { class: `ocard st-${o.status}` },
    h("div", { class: "o-head" },
      h("b", { class: "ltr", text: `#${ORDER_PREFIX[mode] || "ORD"}-${o.order_no ?? "—"}` }),
      h("span", { class: `badge ${st.cls}` }, st.label),
      h("span", { class: "hint grow", style: { "text-align": "end" }, text: timeAgo(o.created_at) })),
    h("div", { class: "o-lines" },
      m.name ? h("div", {}, "👤 ", h("b", { text: m.name })) : null,
      m.phone ? h("div", {}, "📞 ", h("span", { class: "ltr", text: m.phone })) : null,
      m.type ? h("div", { text: `${m.type === "delivery" ? "🛵 توصيل" : "🏃 استلام"}${m.district ? ` — ${m.district}` : ""}${m.address ? `، ${m.address}` : ""}` }) : null,
      m.gps ? h("div", {}, "🗺️ ", h("a", { href: m.gps, target: "_blank", rel: "noopener" }, "الموقع على الخريطة")) : null,
      m.date ? h("div", { text: `📅 ${m.date}` }) : null,
      m.kind ? h("div", { text: `📋 ${m.kind}` }) : null,
      m.pay ? h("div", { text: `💳 ${m.pay}` }) : null,
      m.note ? h("div", { class: "o-note", text: `📝 ${m.note}` }) : null),
    items.length ? h("div", { class: "o-items" }, items.map((i) => h("div", { class: "row between" },
      h("span", { text: `${i.n}${i.s ? ` (${i.s})` : ""} ×${i.q ?? 1}` }), h("span", { text: money(i.t ?? 0) })))) : null,
    h("div", { class: "o-total row between" },
      h("span", {}, m.coupon ? `🎟️ ${m.coupon} (-${money(m.discount || 0)})` : "الإجمالي"),
      h("b", { text: money(o.total ?? 0) })),
    h("div", { class: "o-actions" },
      actions.map(([label, next, cls, confirmMsg]) => h("button", { class: `btn btn-sm ${cls}`, type: "button", onClick: () => setStatus(next, confirmMsg) }, label)),
      phone ? h("a", { class: "btn btn-sm btn-outline", href: `https://wa.me/${phone}?text=${encodeURIComponent(greet)}`, target: "_blank", rel: "noopener" }, "💬 راسل العميل") : null));
}

/* ---------------- الإحصائيات ---------------- */
async function openInsights() {
  const body = h("div", { class: "stack" }, h("div", { class: "center" }, h("span", { class: "spinner" })));
  openSheet({ title: "📊 إحصائيات آخر 14 يوم", body });
  let r;
  try { r = await rpc(sb, "merchant_stats_detail", { p_token: token, p_days: 14 }); }
  catch (e) { return fill(body, h("div", { class: "alert alert-danger" }, friendlyError(e))); }
  const daily = r.daily || [];
  const tot = daily.reduce((a, d) => ({ v: a.v + d.views, o: a.o + d.orders, r: a.r + Number(d.revenue) }), { v: 0, o: 0, r: 0 });
  const maxO = Math.max(1, ...daily.map((d) => d.orders));
  const maxH = Math.max(1, ...(r.hours || [0]));
  const top = r.top_items || [];
  const maxT = Math.max(1, ...top.map((x) => Number(x.qty)));
  const peak = (r.hours || []).indexOf(Math.max(...(r.hours || [0])));

  fill(body,
    h("div", { class: "mini-stats" },
      h("div", {}, h("b", { text: String(tot.o) }), h("span", {}, "طلب")),
      h("div", {}, h("b", { text: money(tot.r) }), h("span", {}, "قيمة الطلبات")),
      h("div", {}, h("b", { text: tot.v ? `${Math.round((tot.o / tot.v) * 100)}%` : "—" }), h("span", {}, "نسبة التحويل"))),
    h("div", { class: "card stack" }, h("b", {}, "الطلبات اليومية"),
      h("div", { class: "chart-bars", role: "img", "aria-label": "رسم بياني للطلبات اليومية" }, daily.map((d) =>
        h("div", { class: "bar-col", title: `${d.d}: ${d.orders} طلب • ${money(d.revenue)}` },
          h("span", { class: "bar-v", text: d.orders ? String(d.orders) : "" }),
          h("i", { class: "bar", style: { height: `${Math.max(3, (d.orders / maxO) * 100)}%` } }),
          h("span", { class: "bar-l", text: d.d.slice(8) }))))),
    h("div", { class: "card stack" }, h("b", {}, "الأكثر طلباً"),
      top.length ? top.map((x) => h("div", { class: "hbar" },
        h("div", { class: "row between small" }, h("span", { text: x.name }), h("span", { class: "muted", text: `${x.qty} • ${money(x.revenue)}` })),
        h("div", { class: "hbar-track" }, h("i", { style: { width: `${(Number(x.qty) / maxT) * 100}%` } }))))
        : h("span", { class: "muted small" }, "لا توجد بيانات بعد")),
    h("div", { class: "card stack" }, h("b", {}, "أوقات الذروة", tot.o ? h("span", { class: "hint", text: `  • الأكثر الساعة ${fmtTime12(`${String(peak).padStart(2, "0")}:00`)}` }) : null),
      h("div", { class: "chart-bars hours", role: "img", "aria-label": "توزيع الطلبات حسب الساعة" }, (r.hours || []).map((c, hr) =>
        h("div", { class: "bar-col", title: `${hr}:00 — ${c} طلب` },
          h("i", { class: "bar", style: { height: `${Math.max(3, (c / maxH) * 100)}%` } }),
          h("span", { class: "bar-l", text: hr % 3 === 0 ? String(hr) : "" }))))));
}

/* ---------------- الكوبونات ---------------- */
function couponsCard() {
  const list = h("div", { class: "stack" });
  const card = h("div", { class: "card stack" },
    h("div", { class: "row between" }, h("h2", { class: "card-title", style: { margin: "0" } }, "🎟️ كوبونات الخصم"),
      h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => couponForm(null, draw) }, "+ كوبون")),
    h("p", { class: "hint", style: { margin: "0" }, text: "يكتب العميل الكود في صفحة الطلب ويُخصم تلقائياً من الإجمالي." }), list);
  async function draw() {
    let rows = [];
    try { rows = await rpc(sb, "merchant_list_coupons", { p_token: token }); } catch (e) { return fill(list, h("div", { class: "error-text" }, friendlyError(e))); }
    if (!rows.length) return fill(list, h("div", { class: "muted small" }, "لا توجد كوبونات بعد"));
    fill(list, ...rows.map((c) => {
      const expired = c.expires_at && new Date(c.expires_at) < new Date();
      const used = c.max_uses ? `${c.used}/${c.max_uses}` : `${c.used}`;
      return h("div", { class: "coupon-row" },
        h("div", { class: "grow" },
          h("b", { class: "ltr code", text: c.code }),
          h("div", { class: "hint", text: `${c.kind === "percent" ? `${num(c.value)}%` : money(c.value)}${num(c.min_order) ? ` • للطلبات فوق ${money(c.min_order)}` : ""} • استُخدم ${used}${c.expires_at ? ` • ينتهي ${new Date(c.expires_at).toLocaleDateString("ar-u-ca-gregory-nu-latn")}` : ""}` })),
        expired ? h("span", { class: "badge badge-danger" }, "منتهي") : !c.active ? h("span", { class: "badge badge-muted" }, "موقوف") : h("span", { class: "badge badge-success" }, "فعّال"),
        h("button", { class: "rbtn", type: "button", "aria-label": "تعديل", onClick: () => couponForm(c, draw) }, "✏️"),
        h("button", { class: "rbtn danger", type: "button", "aria-label": "حذف", onClick: async () => {
          if (!(await confirmDialog(`حذف الكوبون ${c.code}؟`, { okText: "حذف", danger: true }))) return;
          try { await save("merchant_delete_coupon", { p_id: c.id }, "تم حذف الكوبون"); draw(); } catch { /* handled */ }
        } }, "🗑️"));
    }));
  }
  draw();
  return card;
}

function couponForm(c, done) {
  const code = input({ value: c?.code || "", maxlength: "20", dir: "ltr", placeholder: "SAVE10", style: { "text-transform": "uppercase" } });
  let kind = c?.kind || "percent";
  const value = input({ type: "number", inputmode: "decimal", min: "1", step: "0.5", value: c ? String(num(c.value)) : "" });
  const minO = input({ type: "number", inputmode: "decimal", min: "0", step: "1", value: c ? String(num(c.min_order)) : "0" });
  const maxU = input({ type: "number", inputmode: "numeric", min: "1", value: c?.max_uses ? String(c.max_uses) : "", placeholder: "غير محدود" });
  const exp = input({ type: "date", value: c?.expires_at ? c.expires_at.slice(0, 10) : "" });
  const active = switchEl(c ? c.active : true, null, "فعّال");
  const valLbl = h("span", { text: kind === "percent" ? "نسبة الخصم %" : `مبلغ الخصم (${CONFIG.CURRENCY})` });
  const seg = h("div", { class: "segmented" }, [["percent", "نسبة %"], ["fixed", "مبلغ ثابت"]].map(([k, l]) =>
    h("label", {}, h("input", { type: "radio", name: "ckind", checked: kind === k, onChange: () => { kind = k; valLbl.textContent = k === "percent" ? "نسبة الخصم %" : `مبلغ الخصم (${CONFIG.CURRENCY})`; } }), h("span", {}, l))));
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, c ? "حفظ الكوبون" : "إنشاء الكوبون");
  const sheet = openSheet({ title: c ? `تعديل ${c.code}` : "كوبون جديد", foot: btn, body: [
    field("الكود", code, "حروف إنجليزية وأرقام، 3 إلى 20 حرفاً"),
    h("div", { class: "field" }, h("span", { class: "label" }, "نوع الخصم"), seg),
    h("label", { class: "field" }, valLbl, value),
    field(`الحد الأدنى للطلب (${CONFIG.CURRENCY})`, minO),
    h("div", { class: "row" }, h("div", { class: "grow" }, field("عدد مرات الاستخدام", maxU)), h("div", { class: "grow" }, field("تاريخ الانتهاء", exp))),
    h("div", { class: "row between" }, h("b", {}, "فعّال"), active.el),
  ] });
  btn.addEventListener("click", async () => {
    const v = num(value.value);
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(code.value.trim())) return toast("الكود من 3 إلى 20 حرفاً إنجليزياً أو رقماً", "error");
    if (!(v > 0) || (kind === "percent" && v > 90)) return toast(kind === "percent" ? "النسبة من 1 إلى 90" : "اكتب مبلغ الخصم", "error");
    btn.disabled = true;
    try {
      await save("merchant_save_coupon", { p: { id: c?.id || null, code: code.value.trim(), kind, value: String(v), min_order: String(num(minO.value)),
        max_uses: maxU.value ? String(Math.floor(num(maxU.value))) : null, expires_at: exp.value ? new Date(`${exp.value}T23:59:59`).toISOString() : "", active: active.input.checked } },
        "تم حفظ الكوبون ✅");
      sheet.close(); done();
    } catch { btn.disabled = false; }
  });
}

/* ---------------- أوقات العمل (موحّدة / لكل يوم بفترتين) ---------------- */
function hoursEditor(s) {
  let mode = s.hours_json ? "perday" : s.open_time ? "same" : "all";
  const openT = input({ type: "time", value: s.open_time || "16:00", "aria-label": "يفتح" });
  const closeT = input({ type: "time", value: s.close_time || "02:00", "aria-label": "يغلق" });
  const sameBox = h("div", { class: "row" }, h("div", { class: "grow" }, field("يفتح", openT)), h("div", { class: "grow" }, field("يغلق", closeT)));
  const hint = h("div", { class: "hint" });
  const updHint = () => {
    hint.textContent = mode === "same" && openT.value && closeT.value && closeT.value <= openT.value
      ? `دوام ممتد لما بعد منتصف الليل: من ${fmtTime12(openT.value)} حتى ${fmtTime12(closeT.value)} اليوم التالي` : "";
  };
  openT.addEventListener("input", updHint); closeT.addEventListener("input", updHint);

  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => {
    const sh = s.hours_json?.[d] || (s.hours_json ? [] : [{ o: s.open_time || "09:00", c: s.close_time || "23:00" }]);
    const on = switchEl(!!sh.length || !s.hours_json, () => draw(), `${WD[d]} مفتوح`);
    const o1 = input({ type: "time", value: sh[0]?.o || "09:00", "aria-label": `${WD[d]} يفتح` });
    const c1 = input({ type: "time", value: sh[0]?.c || "23:00", "aria-label": `${WD[d]} يغلق` });
    const o2 = input({ type: "time", value: sh[1]?.o || "16:00", "aria-label": `${WD[d]} الفترة الثانية تفتح` });
    const c2 = input({ type: "time", value: sh[1]?.c || "23:00", "aria-label": `${WD[d]} الفترة الثانية تغلق` });
    let two = sh.length > 1;
    const twoBtn = h("button", { class: "link-btn", type: "button" });
    const row2 = h("div", { class: "shift" }, o2, h("span", {}, "←"), c2);
    const row1 = h("div", { class: "shift" }, o1, h("span", {}, "←"), c1);
    const el = h("div", { class: "day-row" }, h("div", { class: "row between" }, h("b", { text: WD[d] }), on.el), row1, row2, twoBtn);
    function draw() {
      const open = on.input.checked;
      row1.hidden = !open; row2.hidden = !open || !two; twoBtn.hidden = !open;
      twoBtn.textContent = two ? "− حذف الفترة الثانية" : "+ فترة ثانية";
      el.classList.toggle("off", !open);
    }
    twoBtn.addEventListener("click", () => { two = !two; draw(); });
    draw();
    return { el, get: () => (on.input.checked ? [{ o: o1.value, c: c1.value }, ...(two ? [{ o: o2.value, c: c2.value }] : [])].filter((x) => x.o && x.c) : []) };
  });
  const perBox = h("div", { class: "stack", style: { gap: "8px" } }, days.map((d) => d.el));

  const seg = h("div", { class: "segmented" }, [["all", "24 ساعة"], ["same", "نفس الوقت يومياً"], ["perday", "حسب اليوم"]].map(([k, l]) =>
    h("label", {}, h("input", { type: "radio", name: "hmode", value: k, checked: mode === k, onChange: () => { mode = k; sync(); } }), h("span", {}, l))));
  function sync() { sameBox.hidden = mode !== "same"; perBox.hidden = mode !== "perday"; updHint(); }
  sync();

  return {
    el: h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "🕒 أوقات العمل"), seg, sameBox, hint, perBox,
      h("div", { class: "hint", text: "يدعم الدوام لما بعد منتصف الليل (مثل 4:00م ← 2:00ص) وفترتين في اليوم." })),
    get() {
      if (mode === "all") return { open_time: "", close_time: "", hours_json: null };
      if (mode === "same") {
        if (!openT.value || !closeT.value) throw new Error("حدد وقت الفتح والإغلاق");
        return { open_time: openT.value, close_time: closeT.value, hours_json: null };
      }
      const hj = {};
      days.forEach((d, i) => { const v = d.get(); if (v.length) hj[i] = v; });
      return { open_time: "", close_time: "", hours_json: hj };
    },
  };
}

/* ---------------- أيام الحجز المحجوزة (للتاجر) ---------------- */
function blockedDatesField(dates) {
  const set = new Set(dates || []);
  const today = new Date().toISOString().slice(0, 10);
  let [y, m] = today.split("-").map(Number); m -= 1;
  const box = h("div", { class: "cal" });
  const count = h("span", { class: "hint" });
  const draw = () => {
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const n = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(h("span"));
    for (let d = 1; d <= n; d++) {
      const ymd = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const b = h("button", { type: "button", class: `cal-day${set.has(ymd) ? " busy" : ""}`, disabled: ymd < today, "aria-pressed": set.has(ymd) ? "true" : "false" }, String(d));
      b.addEventListener("click", () => { set.has(ymd) ? set.delete(ymd) : set.add(ymd); draw(); });
      cells.push(b);
    }
    count.textContent = set.size ? `${[...set].filter((d) => d >= today).length} يوم محجوز قادم` : "لا توجد أيام محجوزة";
    fill(box,
      h("div", { class: "cal-head" },
        h("button", { type: "button", class: "rbtn", "aria-label": "الشهر السابق", onClick: () => { m -= 1; if (m < 0) { m = 11; y -= 1; } draw(); } }, "›"),
        h("b", { text: new Date(Date.UTC(y, m, 1)).toLocaleDateString("ar-u-ca-gregory-nu-latn", { month: "long", year: "numeric", timeZone: "UTC" }) }),
        h("button", { type: "button", class: "rbtn", "aria-label": "الشهر التالي", onClick: () => { m += 1; if (m > 11) { m = 0; y += 1; } draw(); } }, "‹")),
      h("div", { class: "cal-grid cal-wd" }, WD.map((w) => h("span", { text: w.slice(0, 2) }))),
      h("div", { class: "cal-grid" }, cells));
  };
  draw();
  return {
    el: h("div", { class: "field" }, h("span", { class: "label" }, "📅 الأيام المحجوزة (اضغط على اليوم لحجزه أو فكّه)"), box, count),
    get: () => [...set].filter((d) => d >= today).sort(),
  };
}

/* ---------------- ترتيب الأصناف ---------------- */
async function moveProduct(p, dir) {
  const ordered = [...D.products].sort((a, b) => a.sort_order - b.sort_order);
  const cats = [...new Set(ordered.map((x) => x.category || ""))];
  const groups = cats.map((c) => ordered.filter((x) => (x.category || "") === c));
  const gi = cats.indexOf(p.category || "");
  const g = groups[gi];
  const i = g.indexOf(p);
  const j = i + dir;
  if (j < 0 || j >= g.length) return;
  [g[i], g[j]] = [g[j], g[i]];
  await saveOrder(groups.flat());
}
async function moveCategory(cat, dir) {
  const ordered = [...D.products].sort((a, b) => a.sort_order - b.sort_order);
  const cats = [...new Set(ordered.map((x) => x.category || ""))];
  const i = cats.indexOf(cat), j = i + dir;
  if (i < 0 || j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  await saveOrder(cats.flatMap((c) => ordered.filter((x) => (x.category || "") === c)));
}
async function saveOrder(list) {
  list.forEach((x, k) => { x.sort_order = k + 1; });
  try {
    await rpc(sb, "merchant_reorder_products", { p_token: token, p_ids: list.map((x) => x.id) });
    renderShell();
  } catch (e) { toast(friendlyError(e), "error"); loadDash(); }
}
