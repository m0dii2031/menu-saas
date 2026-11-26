// =========================================================
// لوحة التاجر: /manage?store=slug  (دخول برمز PIN)
// كل حفظ يتم عبر RPC → يحدّث stores.updated_at → المنيو العام يتحدث فوراً (Realtime)
// =========================================================
import { CONFIG } from "./config.js";
import {
  h, fill, $, toast, openSheet, confirmDialog, money, num, oneLine, initials, store as ls, applyTheme, THEMES, MODES,
  createSb, rpc, friendlyError, compressImage, uploadImage, blobToBase64, pickFile, callFunction,
  getStoreSlug, daysLeft, fmtTime12, toLatinDigits, copyText,
} from "./common.js";

const slug = getStoreSlug();
const root = document.getElementById("app");
const sb = createSb();
const TOKEN_KEY = `mtoken_${slug}`;

let token = null;
let D = null;          // بيانات اللوحة
let tab = ls.get("manage_tab", "menu", true) || "menu";

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
  const logo = h("div", { class: "hero-logo", style: { margin: "0 auto" } }, "🔐");
  const title = h("h1", { style: { "font-size": "20px", margin: "8px 0 0" }, text: "لوحة تحكم المتجر" });
  const pin = h("input", { class: "input center", type: "password", inputmode: "numeric", autocomplete: "current-password",
    maxlength: "8", placeholder: "• • • •", "aria-label": "رمز PIN", style: { "font-size": "24px", "letter-spacing": "8px" } });
  const err = h("div", { class: "error-text center", role: "alert" });
  const btn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "submit" }, "دخول");
  const form = h("form", { class: "card stack", style: { "max-width": "380px", width: "100%" } },
    logo, title, h("p", { class: "muted center", style: { margin: "0" }, text: "أدخل رمز PIN الخاص بمتجرك" }), pin, err, btn);
  fill(root, h("div", { class: "state-screen" }, form));
  pin.focus();

  rpc(sb, "get_store_public", { p_slug: slug }).then((d) => {
    if (d?.store) {
      applyTheme(d.store);
      title.textContent = d.store.name;
      if (d.store.logo_url) logo.replaceWith(h("img", { class: "hero-logo", src: d.store.logo_url, alt: "", style: { margin: "0 auto" } }));
      else logo.textContent = initials(d.store.name);
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

  const header = h("header", { class: "app-header" }, h("div", { class: "container" },
    s.logo_url ? h("img", { class: "logo-sm", src: s.logo_url, alt: "" }) : h("div", { class: "logo-sm" }, initials(s.name)),
    h("div", { class: "grow" }, h("h1", { text: s.name }), h("div", { class: "hint", text: `وضع التشغيل: ${mode.label}` })),
    h("a", { class: "btn btn-soft btn-sm", href: `/?store=${slug}`, target: "_blank", rel: "noopener" }, "عرض المتجر ↗"),
    h("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "تسجيل الخروج", onClick: logout }, "خروج")));

  const content = h("div", { class: "container dash-pad stack", id: "tab-content" });
  const days = daysLeft(s.expires_at);
  if (!s.is_live) {
    content.append(h("div", { class: "alert alert-danger" }, "⏸️ ",
      h("span", {}, s.is_active ? "انتهى اشتراك متجرك والرابط العام متوقف. تواصل مع الإدارة للتجديد." : "متجرك موقوف حالياً من الإدارة.")));
  } else if (days <= 7) {
    content.append(h("div", { class: "alert alert-info" }, `⏳ ينتهي الاشتراك خلال ${days} يوم — تواصل مع الإدارة للتجديد.`));
  }
  const t = D.stats.today, m = D.stats.last_30d;
  content.append(h("div", { class: "stats" },
    h("div", { class: "stat" }, h("b", { text: String(t.views) }), h("span", {}, "زيارات اليوم")),
    h("div", { class: "stat" }, h("b", { text: String(t.orders) }), h("span", {}, "طلبات اليوم")),
    h("div", { class: "stat" }, h("b", { text: String(m.orders) }), h("span", {}, "طلبات 30 يوم"))));

  const panel = h("section", { class: "stack", id: "panel" });
  content.append(panel);

  const nav = h("nav", { class: "bottom-nav", "aria-label": "أقسام اللوحة" }, TABS.map((x) =>
    h("button", { type: "button", class: x.id === tab ? "active" : "", "aria-current": x.id === tab ? "page" : null,
      onClick: () => { tab = x.id; ls.set("manage_tab", tab, true); renderShell(); window.scrollTo(0, 0); } },
      h("span", { class: "i", "aria-hidden": "true" }, x.icon), x.label)));

  fill(root, header, content, nav);
  ({ menu: tabMenu, settings: tabSettings, design: tabDesign, offers: tabOffers })[tab](panel);
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
  const products = D.products;

  const actions = h("div", { class: "row wrap" },
    h("button", { class: "btn btn-primary grow", type: "button", onClick: () => productForm(null) }, `➕ إضافة ${mode.item}`));
  if (s.business_mode === "order") {
    actions.append(h("button", { class: "btn btn-soft grow", type: "button", onClick: visionImport },
      `📷 منيو من صورة (${D.vision_left}/5)`));
  }
  panel.append(actions);

  if (!products.length) {
    panel.append(h("div", { class: "card center muted" }, `لا توجد ${mode.items} بعد. ابدأ بإضافة أول ${mode.item}.`));
    return;
  }

  const search = input({ type: "search", placeholder: `بحث في ${mode.items}...`, "aria-label": "بحث" });
  const listWrap = h("div", { class: "stack" });
  if (products.length > 8) panel.append(search);
  panel.append(listWrap);

  const draw = () => {
    const q = oneLine(search.value, 40);
    const groups = new Map();
    for (const p of products) {
      if (q && !p.name.includes(q) && !(p.category || "").includes(q)) continue;
      const k = p.category || mode.items;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    fill(listWrap, ...[...groups.entries()].map(([cat, items]) => h("div", { class: "stack", style: { gap: "8px" } },
      h("div", { class: "row between" }, h("b", { text: cat }), h("span", { class: "hint", text: `${items.length}` })),
      ...items.map(itemRow))));
  };
  search.addEventListener("input", draw);
  draw();
}

function itemRow(p) {
  const hasSizes = (p.options_json?.sizes || []).length > 0;
  const row = h("div", { class: `item-row${p.is_available ? "" : " off"}` });
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
  const sw = switchEl(p.is_available, async (checked, inp) => {
    try {
      await save("merchant_quick_update", { p_id: p.id, p_is_available: checked, p_price: null }, checked ? "أصبح ظاهراً للعملاء ✅" : "تم الإخفاء من المتجر");
      p.is_available = checked;
      row.classList.toggle("off", !checked);
    } catch { inp.checked = !checked; }
  }, `إظهار ${p.name}`);

  const del = h("button", { class: "btn btn-ghost icon-btn", type: "button", "aria-label": "حذف", onClick: async () => {
    if (!(await confirmDialog(`حذف «${p.name}» نهائياً؟`, { okText: "حذف", danger: true }))) return;
    try { await save("merchant_delete_product", { p_id: p.id }, "تم الحذف"); await loadDash(); } catch { /* handled */ }
  } }, "🗑️");
  const minSize = hasSizes ? Math.min(...p.options_json.sizes.map((x) => num(x.price))) : 0;
  row.append(
    p.image_url ? h("img", { src: p.image_url, alt: "", loading: "lazy" }) : h("div", { class: "ph", "aria-hidden": "true" }, "🍽️"),
    h("div", { class: "grow" },
      h("div", { class: "name", text: p.name }),
      h("div", { class: "row item-controls" },
        hasSizes ? h("span", { class: "hint grow", text: `${p.options_json.sizes.length} أحجام • من ${money(minSize)}` }) : priceInp,
        h("button", { class: "btn btn-ghost icon-btn", type: "button", "aria-label": "تعديل", onClick: () => productForm(p) }, "✏️"),
        del)),
    sw.el);
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

  let sizes, addons, specs, unitSel, gallery;
  const priceLabel = { order: "السعر", booking: "السعر لكل وحدة زمنية", inquiry: "السعر (اختياري)", charity: "قيمة السهم (اختياري)", legal: "رسوم الاستشارة (اختياري)" }[modeId];

  if (modeId === "booking" || modeId === "inquiry") {
    const units = modeId === "booking" ? ["ليلة", "يوم", "ساعة"] : ["", "شهر", "يوم"];
    unitSel = h("select", { class: "select" }, units.map((u) => h("option", { value: u, selected: (o.unit || units[0]) === u }, u || "بدون")));
    body.push(h("div", { class: "row" }, h("div", { class: "grow" }, field(priceLabel, price)), h("div", { style: { width: "120px" } }, field("لكل", unitSel))));
  } else {
    body.push(field(priceLabel, price, modeId === "order" ? "إذا أضفت أحجاماً سيُعتمد سعر الحجم المختار" : null));
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
      },
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

  const allDay = !s.open_time;
  const allDaySw = switchEl(allDay, (c) => { timesRow.hidden = c; }, "مفتوح 24 ساعة");
  const openT = input({ type: "time", value: s.open_time || "16:00" });
  const closeT = input({ type: "time", value: s.close_time || "02:00" });
  const timesRow = h("div", { class: "row", hidden: allDay },
    h("div", { class: "grow" }, field("يفتح", openT)), h("div", { class: "grow" }, field("يغلق", closeT)));
  const hoursHint = h("div", { class: "hint" });
  const updHint = () => {
    hoursHint.textContent = openT.value && closeT.value && closeT.value <= openT.value
      ? `دوام ممتد لما بعد منتصف الليل: من ${fmtTime12(openT.value)} حتى ${fmtTime12(closeT.value)} اليوم التالي` : "";
  };
  openT.addEventListener("input", updHint); closeT.addEventListener("input", updHint); updHint();

  const card = h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "بيانات المتجر"),
    field("اسم المتجر", name), field("نوع النشاط", type), logo.el,
    field("رقم واتساب لاستقبال الطلبات", phone, "مثال: 0501234567 أو 966501234567"),
    s.business_mode === "order" ? field(`رسوم التوصيل (${CONFIG.CURRENCY})`, fee, "اكتب 0 للتوصيل المجاني") : null,
    (s.business_mode === "charity" || s.business_mode === "order") ? field(s.business_mode === "charity" ? "الآيبان الرسمي للتبرعات" : "الآيبان (للدفع بالتحويل - اختياري)", iban) : null);

  const hoursCard = h("div", { class: "card stack" }, h("h2", { class: "card-title" }, "أوقات العمل"),
    h("div", { class: "row between" }, h("span", {}, "مفتوح 24 ساعة"), allDaySw.el), timesRow, hoursHint);

  const saveBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "💾 حفظ الإعدادات");
  saveBtn.addEventListener("click", async () => {
    if (oneLine(name.value, 80).length < 2) return toast("اسم المتجر مطلوب", "error");
    const patch = {
      name: oneLine(name.value, 80), business_type: oneLine(type.value, 60), logo_url: logo.get(),
      whatsapp_phone: phone.value,
      open_time: allDaySw.input.checked ? "" : openT.value, close_time: allDaySw.input.checked ? "" : closeT.value,
    };
    if (!allDaySw.input.checked && (!openT.value || !closeT.value)) return toast("حدد وقت الفتح والإغلاق", "error");
    if (s.business_mode === "order") patch.delivery_fee = String(num(fee.value));
    if (s.business_mode === "charity" || s.business_mode === "order") patch.iban_number = iban.value;
    saveBtn.disabled = true;
    try { await save("merchant_update_store", { p_patch: patch }); await loadDash(); } catch { /* handled */ } finally { saveBtn.disabled = false; }
  });

  panel.append(card, hoursCard, saveBtn, pinCard(), linksCard());
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
}
