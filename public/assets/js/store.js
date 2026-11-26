// =========================================================
// واجهة المتجر العامة: domain.com/?store=slug
// =========================================================
import { CONFIG } from "./config.js";
import {
  h, fill, $, toast, openSheet, copyText, money, num, oneLine, multiLine, normalizePhone, isValidPhone, waLink,
  initials, store as ls, applyTheme, openState, fmtTime12, fmtDateAr, tzParts, addDays, MODES,
  createSb, rpc, withTimeout, debounce, getStoreSlug, toLatinDigits,
} from "./common.js";

const slug = getStoreSlug();
const root = document.getElementById("app");
const sb = createSb();

const S = {
  store: null,
  products: [],
  serverOffset: 0,             // فرق ساعة الجهاز عن ساعة الخادم
  cart: [],
  timers: [],
};

const now = () => new Date(Date.now() + S.serverOffset);
const cartKey = () => `cart_${slug}`;
const CUSTOMER_KEY = "customer_profile";

/* =========================================================
   التشغيل
   ========================================================= */
boot();

async function boot() {
  if (!slug) return renderLanding();
  renderSkeleton();
  try {
    await load(true);
  } catch {
    return renderState("📡", "تعذر تحميل الصفحة", "تحقق من اتصالك بالإنترنت ثم أعد المحاولة.", true);
  }
  if (!S.store) return;
  logViewOnce();
  subscribeRealtime();
  setInterval(() => refresh(), 120000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  registerSW();
  setupInstall();
}

async function load(first = false) {
  const data = await rpc(sb, "get_store_public", { p_slug: slug });
  if (data.status === "not_found") {
    S.store = null;
    return renderState("🔍", "المتجر غير موجود", "تأكد من صحة الرابط.");
  }
  if (data.status === "suspended") {
    S.store = null;
    applyTheme(data.store);
    return renderSuspended(data.store);
  }
  if (data.server_time) S.serverOffset = new Date(data.server_time).getTime() - Date.now();
  S.store = data.store;
  S.products = Array.isArray(data.products) ? data.products : [];
  applyTheme(S.store);
  setupHead();
  if (first) S.cart = sanitizeCart(ls.get(cartKey(), []));
  else S.cart = sanitizeCart(S.cart, true);
  saveCart();
  render();
}

const refresh = debounce(() => load().catch(() => {}), 400);

function subscribeRealtime() {
  // أي تعديل من لوحة التاجر يحدّث stores.updated_at → نعيد الجلب فوراً
  sb.channel(`store-${S.store.id}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "stores", filter: `id=eq.${S.store.id}` }, () => refresh())
    .subscribe();
}

function logViewOnce() {
  const k = `viewed_${slug}`;
  if (ls.get(k, false, true)) return;
  ls.set(k, true, true);
  rpc(sb, "log_event", { p_store_id: S.store.id, p_event_type: "view" }).catch(() => {});
}

function setupHead() {
  const s = S.store;
  document.title = s.name;
  document.documentElement.lang = "ar";
  let link = $('link[rel="manifest"]');
  if (!link) { link = h("link", { rel: "manifest" }); document.head.append(link); }
  link.setAttribute("href", `${CONFIG.SUPABASE_URL}/functions/v1/manifest?store=${encodeURIComponent(slug)}`);
  const setMeta = (name, content) => {
    let m = $(`meta[name="${name}"]`);
    if (!m) { m = h("meta", { name }); document.head.append(m); }
    m.setAttribute("content", content);
  };
  setMeta("apple-mobile-web-app-title", s.name.slice(0, 30));
  setMeta("description", `${s.name}${s.business_type ? " — " + s.business_type : ""}`);
  let apple = $('link[rel="apple-touch-icon"]');
  if (!apple) { apple = h("link", { rel: "apple-touch-icon" }); document.head.append(apple); }
  apple.setAttribute("href", s.logo_url || "/assets/icons/icon-192.png");
}

function registerSW() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/* =========================================================
   شاشات الحالة
   ========================================================= */
function renderSkeleton() {
  fill(root, 
    h("div", { class: "skeleton", style: { height: "170px", "border-radius": "0" } }),
    h("div", { class: "container stack mt2" },
      h("div", { class: "skeleton", style: { height: "90px", width: "90px", "border-radius": "50%", margin: "-60px auto 0" } }),
      ...[1, 2, 3, 4].map(() => h("div", { class: "skeleton", style: { height: "110px" } }))),
  );
}

function renderState(icon, title, text, retry = false) {
  fill(root, h("div", { class: "state-screen" },
    h("div", {},
      h("div", { class: "ico", "aria-hidden": "true" }, icon),
      h("h1", { text: title }),
      h("p", { class: "muted", text }),
      retry ? h("button", { class: "btn btn-primary mt", onClick: () => location.reload() }, "إعادة المحاولة") : null)));
}

function renderSuspended(s) {
  fill(root, h("div", { class: "state-screen" },
    h("div", { class: "card", style: { "max-width": "420px" } },
      s.logo_url ? h("img", { src: s.logo_url, alt: "", class: "hero-logo", style: { margin: "0 auto 8px" } })
                 : h("div", { class: "hero-logo", style: { margin: "0 auto 8px" } }, initials(s.name)),
      h("h1", { text: s.name }),
      h("div", { class: "ico", "aria-hidden": "true" }, "⏸️"),
      h("p", { class: "muted", text: "هذه الصفحة متوقفة مؤقتاً. نعتذر عن الإزعاج، وسنعود قريباً بإذن الله." }))));
}

function renderLanding() {
  const inp = h("input", { class: "input ltr", placeholder: "store-name", "aria-label": "رابط المتجر", style: { "text-align": "left" } });
  const go = () => {
    const v = oneLine(inp.value, 40).toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v)) location.search = `?store=${v}`;
    else toast("اكتب رابط المتجر بالأحرف الإنجليزية", "error");
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  fill(root, h("div", { class: "state-screen" },
    h("div", { class: "card stack", style: { "max-width": "420px", width: "100%" } },
      h("div", { class: "ico", "aria-hidden": "true" }, "🍽️"),
      h("h1", { text: "منيو إلكتروني وبوابات طلب عبر واتساب" }),
      h("p", { class: "muted", text: "افتح صفحة أي متجر عبر رابطه الخاص." }),
      inp,
      h("button", { class: "btn btn-primary btn-block", onClick: go }, "فتح المتجر"))));
}

/* =========================================================
   الصفحة الرئيسية للمتجر
   ========================================================= */
function clearTimers() {
  S.timers.forEach(clearInterval);
  S.timers = [];
}

function render() {
  clearTimers();
  const s = S.store;
  const mode = s.business_mode;
  const st = openState(s, now());

  const cover = h("div", { class: "hero-cover" });
  if (s.cover_url) cover.style.setProperty("background-image", `url("${encodeURI(s.cover_url)}")`);

  const statusBadge = st.open
    ? h("span", { class: "badge badge-success" }, "● مفتوح الآن")
    : h("span", { class: "badge badge-danger" }, "● مغلق الآن");

  const meta = [statusBadge];
  if (s.open_time && s.close_time && s.open_time !== s.close_time) {
    meta.push(h("span", { class: "badge badge-muted" }, `🕒 ${fmtTime12(s.open_time)} – ${fmtTime12(s.close_time)}`));
  }
  if (mode === "order" && num(s.delivery_fee) > 0) meta.push(h("span", { class: "badge badge-muted" }, `🛵 التوصيل ${money(s.delivery_fee)}`));
  if (mode === "order" && num(s.delivery_fee) === 0) meta.push(h("span", { class: "badge badge-muted" }, "🛵 توصيل مجاني"));

  const hero = h("header", { class: "hero" }, cover,
    h("div", { class: "container hero-body" },
      s.logo_url ? h("img", { class: "hero-logo", src: s.logo_url, alt: s.name, width: "96", height: "96" })
                 : h("div", { class: "hero-logo", "aria-hidden": "true" }, initials(s.name)),
      h("h1", { class: "hero-name", text: s.name }),
      s.business_type ? h("div", { class: "muted", text: s.business_type }) : null,
      h("div", { class: "hero-meta" }, meta)));

  const main = h("main", { class: "container stack page-pad" });

  if (!st.open) {
    main.append(h("div", { class: "alert alert-danger", role: "alert" },
      h("span", { "aria-hidden": "true" }, "🔒"),
      h("div", {},
        h("b", { text: st.manual ? "مغلق الآن مؤقتاً" : `مغلق الآن — يفتح الساعة ${fmtTime12(st.opensAt)}` }),
        h("div", { class: "small", text: "يمكنك تصفح القائمة، وسيتاح الإرسال عند فتح المتجر." }))));
  }

  const banner = renderBanner();
  if (banner) main.append(banner);
  main.append(h("div", { id: "install-slot" }));

  if (mode === "charity" && s.iban_number) main.append(ibanCard());

  const groups = groupProducts();
  if (groups.length > 1) main.append(categoryTabs(groups));
  if (!S.products.length) {
    main.append(h("div", { class: "card center muted mt2" }, `لا توجد ${MODES[mode].items} حالياً`));
  }
  for (const g of groups) {
    main.append(h("h2", { class: "section-title", id: `cat-${g.idx}`, text: g.name }));
    const list = h("div", { class: "products" });
    for (const p of g.items) list.append(productCard(p));
    main.append(list);
  }

  S.ctaEl = ctaBar();
  fill(root, hero, main, S.ctaEl);
  maybeShowInstall();
}

function groupProducts() {
  const mode = S.store.business_mode;
  const fallback = MODES[mode].items;
  const map = new Map();
  for (const p of S.products) {
    const key = p.category || fallback;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return [...map.entries()].map(([name, items], idx) => ({ name, items, idx }));
}

function categoryTabs(groups) {
  const nav = h("nav", { class: "cat-tabs", "aria-label": "الأقسام" });
  groups.forEach((g, i) => {
    const b = h("button", { class: `cat-tab${i === 0 ? " active" : ""}`, type: "button" }, g.name);
    b.addEventListener("click", () => {
      nav.querySelectorAll(".cat-tab").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      document.getElementById(`cat-${g.idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    nav.append(b);
  });
  return nav;
}

/* ---------------- البنر والعداد التنازلي ---------------- */
function renderBanner() {
  const s = S.store;
  if (!s.banner_active || (!s.banner_text && !s.banner_image_url)) return null;
  const ends = s.banner_expires_at ? new Date(s.banner_expires_at).getTime() : null;
  if (ends && ends <= now().getTime()) return null;

  const hh = h("b"), mm = h("b"), ss = h("b");
  const cd = ends ? h("div", { class: "countdown", "aria-label": "الوقت المتبقي للعرض" }, hh, ":", mm, ":", ss) : null;
  const el = h("section", { class: "promo", "aria-label": "عرض" },
    s.banner_image_url ? h("img", { src: s.banner_image_url, alt: s.banner_text || "عرض" }) : null,
    (s.banner_text || cd) ? h("div", { class: "promo-body" },
      s.banner_text ? h("div", { class: "promo-text", text: s.banner_text }) : h("span"), cd) : null);

  if (ends) {
    const tick = () => {
      const left = Math.max(0, ends - now().getTime());
      if (left <= 0) { el.remove(); clearInterval(t); return; }
      const sec = Math.floor(left / 1000);
      hh.textContent = String(Math.floor(sec / 3600)).padStart(2, "0");
      mm.textContent = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      ss.textContent = String(sec % 60).padStart(2, "0");
    };
    tick();
    const t = setInterval(tick, 1000);
    S.timers.push(t);
  }
  return el;
}

function ibanCard() {
  const iban = S.store.iban_number;
  return h("section", { class: "card stack", "aria-label": "الحساب البنكي" },
    h("div", { class: "row" }, h("span", { "aria-hidden": "true" }, "🏦"), h("b", { text: "الآيبان الرسمي للتبرع" })),
    h("div", { class: "iban-box" },
      h("code", { text: iban.replace(/(.{4})/g, "$1 ").trim() }),
      h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => copyText(iban, "تم نسخ الآيبان ✅") }, "نسخ")));
}

/* ---------------- بطاقات العناصر ---------------- */
function productImages(p) {
  const imgs = [];
  if (p.image_url) imgs.push(p.image_url);
  for (const g of p.gallery_json || []) if (typeof g === "string" && !imgs.includes(g)) imgs.push(g);
  return imgs;
}

function startingPrice(p) {
  const sizes = p.options_json?.sizes || [];
  if (sizes.length) return Math.min(...sizes.map((x) => num(x.price)));
  return num(p.price);
}

function productCard(p) {
  const mode = S.store.business_mode;
  const off = !p.is_available;
  const imgs = productImages(p);

  if (mode === "booking" || mode === "inquiry") {
    const specs = (p.options_json?.specs || []).slice(0, 4);
    const unit = p.options_json?.unit || (mode === "booking" ? "ليلة" : "");
    const card = h("button", { class: `card listing${off ? " unavailable" : ""}`, type: "button", disabled: off },
      imgs.length ? h("div", { class: "gallery" }, imgs.map((u) => h("img", { src: u, alt: p.name, loading: "lazy" }))) : null,
      h("div", { class: "listing-body" },
        h("div", { class: "row between" },
          h("h3", { class: "product-name", text: p.name }),
          num(p.price) > 0 ? h("span", { class: "price" }, money(p.price), unit ? ` / ${unit}` : "") : null),
        p.description ? h("p", { class: "product-desc", text: p.description }) : null,
        specs.length ? h("div", { class: "specs" }, specs.map((x) => h("span", { class: "spec" }, h("b", { text: x.label }), x.value ? `: ${x.value}` : ""))) : null,
        off ? h("span", { class: "badge badge-muted mt" }, mode === "booking" ? "محجوز / غير متاح" : "غير متاح حالياً") : null));
    if (!off) card.addEventListener("click", () => openListing(p));
    return card;
  }

  const icon = mode === "legal" ? "⚖️" : mode === "charity" ? "💚" : "🍽️";
  let priceEl = null;
  if (mode === "order") {
    const sp = startingPrice(p);
    priceEl = h("span", { class: "price" }, (p.options_json?.sizes?.length ? "يبدأ من " : ""), money(sp));
  } else if (num(p.price) > 0) {
    priceEl = h("span", { class: "price" }, mode === "charity" ? `السهم ${money(p.price)}` : `الرسوم ${money(p.price)}`);
  }
  const action = mode === "order" ? h("span", { class: "add-dot", "aria-hidden": "true" }, "+")
    : h("span", { class: "btn btn-soft btn-sm" }, mode === "charity" ? "تبرع" : "احجز");

  const card = h("button", { class: `product${off ? " unavailable" : ""}`, type: "button", disabled: off,
    "aria-label": p.name },
    imgs[0] ? h("img", { class: "product-img", src: imgs[0], alt: "", loading: "lazy", width: "96", height: "96" })
            : h("div", { class: "product-img ph", "aria-hidden": "true" }, icon),
    h("div", { class: "product-body" },
      h("h3", { class: "product-name", text: p.name }),
      p.description ? h("p", { class: "product-desc", text: p.description }) : null,
      h("div", { class: "product-foot" }, off ? h("span", { class: "badge badge-muted" }, "غير متوفر") : priceEl, off ? null : action)));
  if (!off) {
    card.addEventListener("click", () => {
      if (mode === "order") openProduct(p);
      else if (mode === "charity") openDonation(p);
      else openLegal(p);
    });
  }
  return card;
}

function ctaBar() {
  const mode = S.store.business_mode;
  let btn;
  if (mode === "order") {
    const count = S.cart.reduce((a, l) => a + l.qty, 0);
    if (!count) return h("div");
    btn = h("button", { class: "btn btn-primary btn-lg", type: "button", onClick: openCheckout },
      h("span", { class: "cart-count" }, String(count)), "عرض السلة وإتمام الطلب", h("span", {}, `• ${money(cartSubtotal())}`));
  } else {
    const label = { booking: "📅 احجز الآن", inquiry: "🏢 اطلب معاينة / استفسار", charity: "💚 تبرع الآن", legal: "⚖️ احجز استشارة" }[mode];
    const open = { booking: () => openBooking(null), inquiry: () => openInquiry(null), charity: () => openDonation(null), legal: () => openLegal(null) }[mode];
    if (mode === "booking" && !S.products.some((p) => p.is_available)) return h("div");
    btn = h("button", { class: "btn btn-primary btn-lg", type: "button", onClick: open }, label);
  }
  return h("div", { class: "cta-bar" }, btn);
}

function refreshCta() {
  const n = ctaBar();
  if (S.ctaEl?.isConnected) S.ctaEl.replaceWith(n);
  else root.append(n);
  S.ctaEl = n;
}

/* =========================================================
   وضع الطلبات (order): السلة
   ========================================================= */
function lineKey(l) {
  return [l.pid, l.size?.name || "", ...(l.addons || []).map((a) => a.name).sort()].join("|");
}
function lineUnit(l) {
  return (l.size ? num(l.size.price) : num(l.base)) + (l.addons || []).reduce((a, x) => a + num(x.price), 0);
}
const cartSubtotal = () => S.cart.reduce((a, l) => a + lineUnit(l) * l.qty, 0);
const saveCart = () => ls.set(cartKey(), S.cart);

/** يعيد مطابقة السلة مع أحدث بيانات المنيو (أسعار/توفر) */
function sanitizeCart(lines, notify = false) {
  if (S.store?.business_mode !== "order" || !Array.isArray(lines)) return [];
  const out = [];
  let dropped = 0;
  for (const l of lines.slice(0, 50)) {
    const p = S.products.find((x) => x.id === l?.pid);
    if (!p || !p.is_available) { dropped++; continue; }
    const sizes = p.options_json?.sizes || [];
    const addons = p.options_json?.addons || [];
    let size = null;
    if (sizes.length) {
      size = sizes.find((x) => x.name === l.size?.name) || null;
      if (!size) { dropped++; continue; }
    }
    const ad = (l.addons || []).map((a) => addons.find((x) => x.name === a.name)).filter(Boolean);
    out.push({ pid: p.id, name: p.name, base: num(p.price), size, addons: ad, qty: Math.min(99, Math.max(1, Math.floor(num(l.qty)) || 1)) });
  }
  if (notify && dropped) toast("تم تحديث السلة: بعض الأصناف لم تعد متوفرة");
  return out;
}

function addToCart(line) {
  const key = lineKey(line);
  const ex = S.cart.find((l) => lineKey(l) === key);
  if (ex) ex.qty = Math.min(99, ex.qty + line.qty);
  else S.cart.push(line);
  saveCart();
  refreshCta();
}

function qtyControl(value, onChange, small = false) {
  const out = h("output", { text: String(value) });
  let v = value;
  const set = (n) => { v = Math.min(99, Math.max(1, n)); out.textContent = String(v); onChange(v); };
  return h("div", { class: `qty${small ? " sm" : ""}` },
    h("button", { type: "button", "aria-label": "زيادة", onClick: () => set(v + 1) }, "+"),
    out,
    h("button", { type: "button", "aria-label": "إنقاص", onClick: () => set(v - 1) }, "−"));
}

function openProduct(p) {
  const sizes = p.options_json?.sizes || [];
  const addons = p.options_json?.addons || [];
  const state = { size: null, addons: new Set(), qty: 1 };
  const err = h("div", { class: "error-text", role: "alert" });
  const addBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" });

  const unit = () => (state.size ? num(state.size.price) : num(p.price)) + [...state.addons].reduce((a, i) => a + num(addons[i].price), 0);
  const updateBtn = () => {
    addBtn.textContent = sizes.length && !state.size ? "اختر الحجم / النوع أولاً" : `أضف للسلة • ${money(unit() * state.qty)}`;
    addBtn.classList.toggle("btn-soft", !!(sizes.length && !state.size));
    addBtn.classList.toggle("btn-primary", !(sizes.length && !state.size));
  };

  const body = [];
  const imgs = productImages(p);
  if (imgs[0]) body.push(h("img", { class: "sheet-hero", src: imgs[0], alt: p.name }));
  body.push(h("div", {}, h("h2", { style: { margin: "0", "font-size": "20px" }, text: p.name }),
    p.description ? h("p", { class: "muted", style: { margin: "4px 0 0" }, text: p.description }) : null));

  if (sizes.length) {
    const group = `size-${p.id}`;
    body.push(h("fieldset", { class: "field", style: { border: "0", padding: "0", margin: "0" } },
      h("legend", { class: "label mb" }, "اختر الحجم / النوع ", h("span", { class: "badge badge-danger" }, "إلزامي")),
      h("div", { class: "option-list" }, sizes.map((sz) =>
        h("label", { class: "option" },
          h("input", { type: "radio", name: group, onChange: () => { state.size = sz; err.textContent = ""; updateBtn(); } }),
          h("span", { text: sz.name }),
          h("span", { class: "price", text: money(sz.price) }))))));
  } else {
    body.push(h("div", { class: "price", style: { "font-size": "18px" } }, money(p.price)));
  }

  if (addons.length) {
    body.push(h("fieldset", { class: "field", style: { border: "0", padding: "0", margin: "0" } },
      h("legend", { class: "label mb" }, "الإضافات ", h("span", { class: "badge badge-muted" }, "اختياري")),
      h("div", { class: "option-list" }, addons.map((a, i) =>
        h("label", { class: "option" },
          h("input", { type: "checkbox", onChange: (e) => { e.target.checked ? state.addons.add(i) : state.addons.delete(i); updateBtn(); } }),
          h("span", { text: a.name }),
          h("span", { class: "price", text: num(a.price) ? `+${money(a.price)}` : "مجاناً" }))))));
  }

  body.push(h("div", { class: "row between" }, h("span", { class: "label" }, "الكمية"),
    qtyControl(1, (v) => { state.qty = v; updateBtn(); })));
  body.push(err);

  const sheet = openSheet({ title: p.name, body, foot: addBtn });
  updateBtn();
  addBtn.addEventListener("click", () => {
    if (sizes.length && !state.size) {
      err.textContent = "⚠️ الرجاء اختيار الحجم أو النوع قبل الإضافة للسلة";
      sheet.body.querySelector("fieldset")?.scrollIntoView({ behavior: "smooth" });
      return;
    }
    addToCart({ pid: p.id, name: p.name, base: num(p.price), size: state.size,
                addons: [...state.addons].sort().map((i) => addons[i]), qty: state.qty });
    sheet.close();
    toast("تمت الإضافة للسلة ✅", "success");
  });
}

/* ---------------- نموذج إتمام الطلب ---------------- */
function customer() { return ls.get(CUSTOMER_KEY, {}) || {}; }
function saveCustomer(patch) { ls.set(CUSTOMER_KEY, { ...customer(), ...patch }); }

function textField(label, attrs = {}, hint) {
  const input = attrs.multiline ? h("textarea", { class: "textarea", ...attrs, multiline: null }) : h("input", { class: "input", ...attrs });
  return { input, el: h("label", { class: "field" }, h("span", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null) };
}

function segmented(name, options, value, onChange) {
  return h("div", { class: "segmented", role: "radiogroup" }, options.map((o) =>
    h("label", {},
      h("input", { type: "radio", name, value: o.value, checked: o.value === value, onChange: () => onChange(o.value) }),
      h("span", {}, o.label))));
}

function nameAndPhone(c) {
  const name = textField("الاسم", { autocomplete: "name", value: c.name || "", maxlength: "60", required: true });
  const phone = textField("رقم الجوال", { type: "tel", inputmode: "tel", autocomplete: "tel", value: c.phone || "",
    maxlength: "20", placeholder: "05xxxxxxxx", dir: "ltr", style: { "text-align": "right" } });
  return { name, phone };
}

function validateNamePhone(f) {
  const n = oneLine(f.name.input.value, 60);
  f.name.input.classList.toggle("invalid", n.length < 2);
  const okPhone = isValidPhone(f.phone.input.value);
  f.phone.input.classList.toggle("invalid", !okPhone);
  if (n.length < 2) { toast("الرجاء كتابة الاسم", "error"); f.name.input.focus(); return null; }
  if (!okPhone) { toast("رقم الجوال غير صحيح", "error"); f.phone.input.focus(); return null; }
  return { name: n, phone: toLatinDigits(f.phone.input.value).replace(/[^\d+]/g, "") };
}

function openCheckout() {
  const s = S.store;
  const c = customer();
  const st = { type: c.order_type === "pickup" ? "pickup" : "delivery", pay: c.pay || "cash", gps: null };

  const linesBox = h("div");
  const summary = h("div", { class: "summary" });
  const f = nameAndPhone(c);
  const district = textField("الحي", { value: c.district || "", maxlength: "60", autocomplete: "address-level3" });
  const address = textField("العنوان التفصيلي", { value: c.address || "", maxlength: "160", placeholder: "الشارع، رقم المبنى، علامة مميزة", autocomplete: "street-address" });
  const notes = textField("ملاحظات (اختياري)", { multiline: true, maxlength: "400", placeholder: "مثال: بدون بصل، الطابق الثاني..." });
  const gpsStatus = h("span", { class: "hint" }, "اختياري إذا كتبت الحي");
  const gpsBtn = h("button", { class: "btn btn-soft btn-block", type: "button" }, "📍 تحديد موقعي عبر GPS");
  const ibanBox = s.iban_number ? h("div", { class: "iban-box", hidden: st.pay !== "transfer" },
    h("code", { text: s.iban_number }), h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => copyText(s.iban_number) }, "نسخ")) : null;

  const deliveryBox = h("div", { class: "stack" }, district.el, address.el, h("div", { class: "field" }, gpsBtn, gpsStatus));

  gpsBtn.addEventListener("click", () => {
    if (!navigator.geolocation) return toast("المتصفح لا يدعم تحديد الموقع", "error");
    gpsBtn.disabled = true;
    gpsStatus.textContent = "جاري تحديد الموقع...";
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude.toFixed(6), lng = pos.coords.longitude.toFixed(6);
      st.gps = `https://maps.google.com/?q=${lat},${lng}`;
      gpsStatus.textContent = "✅ تم تحديد موقعك بدقة";
      gpsBtn.textContent = "📍 تحديث الموقع";
      gpsBtn.disabled = false;
    }, (e) => {
      gpsBtn.disabled = false;
      gpsStatus.textContent = e.code === 1 ? "تم رفض إذن الموقع — اكتب الحي يدوياً" : "تعذر تحديد الموقع — اكتب الحي يدوياً";
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  const typeSeg = segmented("otype", [{ value: "delivery", label: "🛵 توصيل" }, { value: "pickup", label: "🏃 استلام من المحل" }], st.type,
    (v) => { st.type = v; deliveryBox.hidden = v !== "delivery"; renderSummary(); });
  const paySeg = segmented("pay", [
    { value: "cash", label: "💵 نقداً" }, { value: "card", label: "💳 شبكة/مدى" }, { value: "transfer", label: "🏦 تحويل" },
  ], st.pay, (v) => { st.pay = v; if (ibanBox) ibanBox.hidden = v !== "transfer"; });
  deliveryBox.hidden = st.type !== "delivery";

  function renderLines() {
    fill(linesBox, ...S.cart.map((l, idx) => h("div", { class: "cart-line" },
      h("div", { class: "grow" },
        h("b", { text: l.name }),
        l.size ? h("div", { class: "small muted", text: `الحجم: ${l.size.name}` }) : null,
        l.addons.length ? h("div", { class: "small muted", text: `إضافات: ${l.addons.map((a) => a.name).join("، ")}` }) : null,
        h("div", { class: "price small", text: money(lineUnit(l) * l.qty) })),
      h("div", { class: "stack", style: { "justify-items": "end", gap: "4px" } },
        qtyControl(l.qty, (v) => { l.qty = v; saveCart(); renderSummary(); refreshCta(); renderLinesPrices(); }, true),
        h("button", { class: "btn btn-ghost btn-sm", type: "button", style: { color: "var(--danger)" },
          onClick: () => { S.cart.splice(idx, 1); saveCart(); refreshCta(); if (!S.cart.length) sheet.close(); else { renderLines(); renderSummary(); } } }, "حذف")))));
  }
  function renderLinesPrices() {
    linesBox.querySelectorAll(".cart-line").forEach((row, i) => {
      const pr = row.querySelector(".price");
      if (pr && S.cart[i]) pr.textContent = money(lineUnit(S.cart[i]) * S.cart[i].qty);
    });
  }
  function renderSummary() {
    const sub = cartSubtotal();
    const fee = st.type === "delivery" ? num(s.delivery_fee) : 0;
    fill(summary, 
      h("div", { class: "row" }, h("span", {}, "مجموع الأصناف"), h("span", {}, money(sub))),
      st.type === "delivery" ? h("div", { class: "row" }, h("span", {}, "رسوم التوصيل"), h("span", {}, fee ? money(fee) : "مجاناً")) : null,
      h("div", { class: "row total" }, h("span", {}, "الإجمالي"), h("span", {}, money(sub + fee))));
  }

  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "إرسال الطلب عبر واتساب");
  const sheet = openSheet({
    title: "سلة الطلب",
    body: [linesBox,
      h("div", { class: "field" }, h("span", { class: "label" }, "نوع الطلب"), typeSeg),
      f.name.el, f.phone.el, deliveryBox,
      h("div", { class: "field" }, h("span", { class: "label" }, "طريقة الدفع"), paySeg), ibanBox,
      notes.el, summary],
    foot: sendBtn,
  });
  renderLines();
  renderSummary();
  bindCooldown(sendBtn, "إرسال الطلب عبر واتساب");

  sendBtn.addEventListener("click", async () => {
    if (!S.cart.length) return toast("السلة فارغة", "error");
    const who = validateNamePhone(f);
    if (!who) return;
    const dist = oneLine(district.input.value, 60);
    const addr = oneLine(address.input.value, 160);
    if (st.type === "delivery" && !dist && !st.gps) {
      district.input.classList.add("invalid");
      district.input.focus();
      return toast("للتوصيل: اكتب اسم الحي أو حدّد موقعك عبر GPS", "error");
    }
    saveCustomer({ name: who.name, phone: who.phone, district: dist, address: addr, order_type: st.type, pay: st.pay });

    const sub = cartSubtotal();
    const fee = st.type === "delivery" ? num(s.delivery_fee) : 0;
    const payLabel = { cash: "نقداً عند الاستلام", card: "شبكة / مدى عند الاستلام", transfer: "تحويل بنكي" }[st.pay];
    const note = multiLine(notes.input.value, 400);
    const items = S.cart.map((l) => ({ n: l.name.slice(0, 60), s: l.size?.name || null, q: l.qty, t: lineUnit(l) * l.qty }));

    const ok = await submitToWhatsApp(sendBtn, sub + fee, items, (no) => buildOrderMessage(no, {
      ...who, type: st.type, district: dist, address: addr, gps: st.gps, note, sub, fee, payLabel,
    }));
    if (ok) { S.cart = []; saveCart(); refreshCta(); sheet.close(); }
  });
}

const SEP = "━━━━━━━━━━━━";

function buildOrderMessage(no, d) {
  const L = [];
  L.push(`🧾 *طلب جديد #${no}*`);
  L.push(`🏪 ${S.store.name}`);
  L.push(SEP);
  L.push(`👤 *الاسم:* ${d.name}`);
  L.push(`📱 *الجوال:* ${d.phone}`);
  L.push(`🚚 *نوع الطلب:* ${d.type === "delivery" ? "توصيل" : "استلام من المحل"}`);
  if (d.type === "delivery") {
    L.push(SEP);
    L.push("📍 *بيانات الموقع:*");
    if (d.district) L.push(`• الحي: ${d.district}`);
    if (d.address) L.push(`• العنوان: ${d.address}`);
    if (d.gps) L.push(`• الموقع على الخريطة: ${d.gps}`);
  }
  L.push(SEP);
  L.push("🛒 *الأصناف:*");
  S.cart.forEach((l, i) => {
    L.push(`${i + 1}) *${l.name}*`);
    if (l.size) L.push(`   • الحجم: ${l.size.name} (${money(l.size.price)})`);
    else L.push(`   • السعر: ${money(l.base)}`);
    if (l.addons.length) L.push(`   • الإضافات: ${l.addons.map((a) => `${a.name} (+${money(a.price)})`).join("، ")}`);
    L.push(`   • الكمية: ${l.qty}`);
    L.push(`   • المجموع الفرعي: ${money(lineUnit(l) * l.qty)}`);
  });
  if (d.note) {
    L.push(SEP);
    L.push(`📝 *ملاحظات:* ${d.note}`);
  }
  L.push(SEP);
  L.push(`🧮 مجموع الأصناف: ${money(d.sub)}`);
  if (d.type === "delivery") L.push(`🛵 رسوم التوصيل: ${d.fee ? money(d.fee) : "مجاناً"}`);
  L.push(`💰 *الإجمالي النهائي: ${money(d.sub + d.fee)}*`);
  L.push(`💳 *طريقة الدفع:* ${d.payLabel}`);
  return L.join("\n");
}

/* =========================================================
   الإرسال عبر واتساب (Click-to-Chat) + مهلة منع الإغراق
   ========================================================= */
const cdKey = () => `cooldown_${slug}`;
function cooldownLeft() {
  return Math.max(0, Math.ceil(((ls.get(cdKey(), 0) || 0) - Date.now()) / 1000));
}

function bindCooldown(btn, label) {
  const tick = () => {
    if (!btn.isConnected) return clearInterval(t);
    const left = cooldownLeft();
    if (left > 0) { btn.disabled = true; btn.textContent = `انتظر ${left} ثانية قبل الإرسال مجدداً`; }
    else if (btn.dataset.cd === "1") { btn.disabled = false; btn.textContent = label; }
    btn.dataset.cd = left > 0 ? "1" : "0";
  };
  const t = setInterval(tick, 1000);
  tick();
}

async function submitToWhatsApp(btn, total, items, build) {
  const st = openState(S.store, now());
  if (!st.open) {
    toast(st.manual ? "المتجر مغلق حالياً" : `مغلق الآن — يفتح الساعة ${fmtTime12(st.opensAt)}`, "error");
    return false;
  }
  if (cooldownLeft() > 0) return false;
  const label = btn.textContent;
  btn.disabled = true;
  fill(btn, h("span", { class: "spinner", "aria-hidden": "true" }), " جاري التجهيز...");

  let no;
  try {
    const r = await withTimeout(rpc(sb, "log_event", {
      p_store_id: S.store.id, p_event_type: "order_click", p_order_total: Math.round(total * 100) / 100, p_items: items,
    }), 3500);
    if (r?.ok === false) {
      btn.disabled = false; btn.textContent = label;
      toast(r.error === "rate_limited" ? "طلبات كثيرة خلال وقت قصير، انتظر دقائق ثم حاول" : "المتجر غير متاح حالياً", "error");
      return false;
    }
    no = r?.order_no;
  } catch { /* لا نعطل الطلب إذا تأخر الخادم */ }
  if (!no) no = String(Date.now()).slice(-4);

  const url = waLink(S.store.whatsapp_phone, build(no));
  ls.set(cdKey(), Date.now() + CONFIG.ORDER_COOLDOWN_SECONDS * 1000);
  btn.disabled = false; btn.textContent = label;
  showSent(url, no);
  const w = window.open(url, "_blank");
  if (w) w.opener = null;
  else location.href = url;
  return true;
}

function showSent(url, no) {
  openSheet({
    title: "تم تجهيز طلبك ✅",
    body: h("div", { class: "stack center" },
      h("div", { style: { "font-size": "48px" }, "aria-hidden": "true" }, "📨"),
      h("b", { text: `رقم الطلب #${no}` }),
      h("p", { class: "muted", style: { margin: "0" }, text: "تم فتح واتساب برسالة جاهزة. اضغط «إرسال» داخل واتساب لإتمام العملية." })),
    foot: h("a", { class: "btn btn-primary btn-block", href: url, target: "_blank", rel: "noopener" }, "فتح واتساب مرة أخرى"),
  });
}

/* =========================================================
   وضع الحجوزات / الاستفسار: تفاصيل العرض
   ========================================================= */
function openListing(p) {
  const mode = S.store.business_mode;
  const imgs = productImages(p);
  const specs = p.options_json?.specs || [];
  const unit = p.options_json?.unit || (mode === "booking" ? "ليلة" : "");
  const cta = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, mode === "booking" ? "📅 احجز هذه الوحدة" : "🏢 اطلب معاينة / استفسر");
  const s = openSheet({
    title: p.name,
    body: [
      imgs.length ? h("div", { class: "gallery sheet-hero", style: { height: "240px" } }, imgs.map((u) => h("img", { src: u, alt: p.name, loading: "lazy" }))) : null,
      imgs.length > 1 ? h("div", { class: "hint center", text: `← اسحب لعرض ${imgs.length} صور →` }) : null,
      num(p.price) > 0 ? h("div", { class: "price", style: { "font-size": "20px" } }, money(p.price), unit ? ` / ${unit}` : "") : null,
      p.description ? h("p", { style: { margin: "0", "white-space": "pre-line" }, text: p.description }) : null,
      specs.length ? h("div", { class: "card", style: { padding: "8px 12px", "box-shadow": "none" } },
        specs.map((x) => h("div", { class: "row between", style: { padding: "6px 0", "border-bottom": "1px solid var(--border)" } },
          h("span", { class: "muted", text: x.label }), h("b", { text: x.value })))) : null,
    ],
    foot: cta,
  });
  cta.addEventListener("click", () => { s.close(); mode === "booking" ? openBooking(p) : openInquiry(p); });
}

function itemSelect(selected, { allowGeneral, generalLabel }) {
  const avail = S.products.filter((p) => p.is_available);
  const sel = h("select", { class: "select" },
    allowGeneral ? h("option", { value: "" }, generalLabel) : null,
    avail.map((p) => h("option", { value: p.id, selected: selected?.id === p.id }, p.name)));
  return sel;
}

/* ---------------- الحجز ---------------- */
function openBooking(p) {
  const s = S.store;
  const c = customer();
  const today = tzParts(s.timezone, now()).ymd;
  const sel = itemSelect(p, { allowGeneral: false });
  const getItem = () => S.products.find((x) => x.id === sel.value) || p;
  const date = h("input", { class: "input", type: "date", min: today, value: today });
  let nights = 1;
  const f = nameAndPhone(c);
  const guests = textField("عدد الأشخاص (اختياري)", { type: "number", inputmode: "numeric", min: "1", max: "500" });
  const notes = textField("ملاحظات (اختياري)", { multiline: true, maxlength: "400" });
  const summary = h("div", { class: "summary" });
  const unitLbl = h("span", { class: "label" });

  function update() {
    const it = getItem();
    const unit = it?.options_json?.unit || "ليلة";
    unitLbl.textContent = `عدد ${unit === "ليلة" ? "الليالي" : unit === "يوم" ? "الأيام" : unit === "ساعة" ? "الساعات" : "الوحدات"}`;
    const price = num(it?.price);
    const out = date.value ? addDays(date.value, nights) : "";
    fill(summary, 
      h("div", { class: "row" }, h("span", {}, `السعر / ${unit}`), h("span", {}, money(price))),
      date.value && (unit === "ليلة" || unit === "يوم") ? h("div", { class: "row" }, h("span", {}, "تاريخ الخروج"), h("span", { class: "small" }, fmtDateAr(out))) : null,
      h("div", { class: "row total" }, h("span", {}, "الإجمالي"), h("span", {}, money(price * nights))));
  }
  sel.addEventListener("change", update);
  date.addEventListener("change", update);

  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "إرسال طلب الحجز عبر واتساب");
  const sheet = openSheet({
    title: "طلب حجز",
    body: [
      h("label", { class: "field" }, h("span", { text: "الوحدة" }), sel),
      h("label", { class: "field" }, h("span", { text: "تاريخ الدخول" }), date),
      h("div", { class: "row between" }, unitLbl, qtyControl(1, (v) => { nights = Math.min(60, v); update(); })),
      f.name.el, f.phone.el, guests.el, notes.el, summary,
    ],
    foot: sendBtn,
  });
  update();
  bindCooldown(sendBtn, "إرسال طلب الحجز عبر واتساب");

  sendBtn.addEventListener("click", async () => {
    const it = getItem();
    if (!it) return toast("اختر الوحدة", "error");
    if (!date.value || date.value < today) { date.classList.add("invalid"); return toast("اختر تاريخ دخول صحيح", "error"); }
    const who = validateNamePhone(f);
    if (!who) return;
    saveCustomer({ name: who.name, phone: who.phone });
    const unit = it.options_json?.unit || "ليلة";
    const total = num(it.price) * nights;
    const g = Math.floor(num(guests.input.value));
    const note = multiLine(notes.input.value, 400);
    const ok = await submitToWhatsApp(sendBtn, total, [{ n: it.name.slice(0, 60), q: nights, t: total }], (no) => {
      const L = [`📅 *طلب حجز جديد #${no}*`, `🏪 ${s.name}`, SEP,
        `👤 *الاسم:* ${who.name}`, `📱 *الجوال:* ${who.phone}`, SEP,
        `🏡 *الوحدة:* ${it.name}`, `📆 *تاريخ الدخول:* ${fmtDateAr(date.value)}`,
        `🌙 *المدة:* ${nights} ${unit}`];
      if (unit === "ليلة" || unit === "يوم") L.push(`🚪 *تاريخ الخروج:* ${fmtDateAr(addDays(date.value, nights))}`);
      if (g > 0) L.push(`👥 *عدد الأشخاص:* ${g}`);
      if (note) L.push(SEP, `📝 *ملاحظات:* ${note}`);
      L.push(SEP, `💵 السعر / ${unit}: ${money(it.price)}`, `💰 *الإجمالي: ${money(total)}*`);
      return L.join("\n");
    });
    if (ok) sheet.close();
  });
}

/* ---------------- الاستفسار والمعاينة ---------------- */
function openInquiry(p) {
  const s = S.store;
  const c = customer();
  const today = tzParts(s.timezone, now()).ymd;
  const sel = itemSelect(p, { allowGeneral: true, generalLabel: "استفسار عام" });
  let kind = "visit";
  const kindSeg = segmented("ikind", [
    { value: "visit", label: "👀 معاينة على الطبيعة" }, { value: "ask", label: "💬 استفسار" }, { value: "hold", label: "📌 حجز مبدئي" },
  ], kind, (v) => { kind = v; });
  const date = h("input", { class: "input", type: "date", min: today });
  let period = "any";
  const periodSeg = segmented("iperiod", [{ value: "am", label: "صباحاً" }, { value: "pm", label: "مساءً" }, { value: "any", label: "أي وقت" }], period, (v) => { period = v; });
  const f = nameAndPhone(c);
  const notes = textField("تفاصيل إضافية (اختياري)", { multiline: true, maxlength: "500", placeholder: "الميزانية، المتطلبات، أسئلتك..." });
  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "إرسال الطلب عبر واتساب");

  const sheet = openSheet({
    title: "طلب معاينة / استفسار",
    body: [
      h("label", { class: "field" }, h("span", { text: "العرض" }), sel),
      h("div", { class: "field" }, h("span", { class: "label" }, "نوع الطلب"), kindSeg),
      h("label", { class: "field" }, h("span", { text: "التاريخ المفضل (اختياري)" }), date),
      h("div", { class: "field" }, h("span", { class: "label" }, "الوقت المناسب"), periodSeg),
      f.name.el, f.phone.el, notes.el,
    ],
    foot: sendBtn,
  });
  bindCooldown(sendBtn, "إرسال الطلب عبر واتساب");

  sendBtn.addEventListener("click", async () => {
    const who = validateNamePhone(f);
    if (!who) return;
    saveCustomer({ name: who.name, phone: who.phone });
    const it = S.products.find((x) => x.id === sel.value);
    const kindLabel = { visit: "معاينة على الطبيعة", ask: "استفسار", hold: "حجز مبدئي" }[kind];
    const periodLabel = { am: "صباحاً", pm: "مساءً", any: "أي وقت" }[period];
    const note = multiLine(notes.input.value, 500);
    const ok = await submitToWhatsApp(sendBtn, it ? num(it.price) : 0, it ? [{ n: it.name.slice(0, 60), q: 1, t: num(it.price) }] : [], (no) => {
      const L = [`🏢 *طلب ${kindLabel} #${no}*`, `🏪 ${s.name}`, SEP,
        `👤 *الاسم:* ${who.name}`, `📱 *الجوال:* ${who.phone}`, `📋 *نوع الطلب:* ${kindLabel}`, SEP];
      if (it) {
        L.push(`🏠 *العرض:* ${it.name}`);
        if (num(it.price) > 0) L.push(`💵 *السعر المعلن:* ${money(it.price)}${it.options_json?.unit ? " / " + it.options_json.unit : ""}`);
        for (const sp of (it.options_json?.specs || []).slice(0, 6)) L.push(`• ${sp.label}: ${sp.value}`);
      } else L.push("🏠 *العرض:* استفسار عام");
      L.push(SEP, `🗓️ *الموعد المفضل:* ${date.value ? fmtDateAr(date.value) + " — " : ""}${periodLabel}`);
      if (note) L.push(`📝 *تفاصيل:* ${note}`);
      return L.join("\n");
    });
    if (ok) sheet.close();
  });
}

/* =========================================================
   وضع الجمعيات الخيرية
   ========================================================= */
function openDonation(p) {
  const s = S.store;
  const c = customer();
  const sel = itemSelect(p, { allowGeneral: true, generalLabel: "تبرع عام" });
  let amount = 100;
  const custom = h("input", { class: "input", type: "number", inputmode: "decimal", min: "1", placeholder: "اكتب المبلغ", hidden: true });
  const amountsBox = h("div", { class: "amounts" });

  function renderAmounts() {
    const it = S.products.find((x) => x.id === sel.value);
    const opts = [50, 100, 500].map((v) => ({ v, label: String(v) }));
    if (it && num(it.price) > 0 && ![50, 100, 500].includes(num(it.price))) opts.unshift({ v: num(it.price), label: `سهم ${num(it.price)}` });
    opts.push({ v: "open", label: "مفتوح" });
    amountsBox.style.setProperty("grid-template-columns", `repeat(${opts.length}, 1fr)`);
    fill(amountsBox, ...opts.map((o) => {
      const b = h("button", { type: "button", class: `btn ${amount === o.v ? "btn-primary" : ""}` }, o.label);
      b.addEventListener("click", () => {
        amount = o.v;
        custom.hidden = o.v !== "open";
        if (o.v === "open") custom.focus();
        renderAmounts();
      });
      return b;
    }));
  }
  sel.addEventListener("change", renderAmounts);

  const donor = textField("اسم المتبرع (اختياري)", { value: c.name || "", maxlength: "60", placeholder: "فاعل خير" });
  const phone = textField("رقم الجوال", { type: "tel", inputmode: "tel", value: c.phone || "", maxlength: "20", placeholder: "05xxxxxxxx", dir: "ltr", style: { "text-align": "right" } });
  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, "إرسال إشعار التبرع عبر واتساب");

  const sheet = openSheet({
    title: "تبرع الآن",
    body: [
      h("label", { class: "field" }, h("span", { text: "المبادرة" }), sel),
      h("div", { class: "field" }, h("span", { class: "label" }, `المبلغ (${CONFIG.CURRENCY})`), amountsBox, custom),
      s.iban_number ? h("div", { class: "field" }, h("span", { class: "label" }, "حوّل المبلغ إلى الآيبان الرسمي"),
        h("div", { class: "iban-box" }, h("code", { text: s.iban_number }),
          h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => copyText(s.iban_number, "تم نسخ الآيبان ✅") }, "نسخ")),
        h("span", { class: "hint", text: "بعد التحويل أرسل الإشعار وأرفق صورة الإيصال في واتساب." })) : null,
      donor.el, phone.el,
    ],
    foot: sendBtn,
  });
  renderAmounts();
  bindCooldown(sendBtn, "إرسال إشعار التبرع عبر واتساب");

  sendBtn.addEventListener("click", async () => {
    const value = amount === "open" ? num(custom.value) : num(amount);
    if (!(value >= 1 && value <= 10000000)) { custom.classList.add("invalid"); return toast("اكتب مبلغاً صحيحاً", "error"); }
    if (!isValidPhone(phone.input.value)) { phone.input.classList.add("invalid"); return toast("رقم الجوال غير صحيح", "error"); }
    const name = oneLine(donor.input.value, 60) || "فاعل خير";
    const ph = toLatinDigits(phone.input.value).replace(/[^\d+]/g, "");
    saveCustomer({ phone: ph, ...(name !== "فاعل خير" ? { name } : {}) });
    const it = S.products.find((x) => x.id === sel.value);
    const ok = await submitToWhatsApp(sendBtn, value, [{ n: (it?.name || "تبرع عام").slice(0, 60), q: 1, t: value }], (no) => [
      `💚 *إشعار تبرع جديد #${no}*`, `🏛️ ${s.name}`, SEP,
      `👤 *المتبرع:* ${name}`, `📱 *الجوال:* ${ph}`, SEP,
      `🎯 *المبادرة:* ${it?.name || "تبرع عام"}`,
      `💰 *المبلغ: ${money(value)}*`,
      s.iban_number ? `🏦 *طريقة الدفع:* تحويل بنكي إلى ${s.iban_number}` : "🏦 *طريقة الدفع:* تحويل بنكي",
      SEP, "📎 سأرفق صورة إيصال التحويل في هذه المحادثة.", "جزاكم الله خيراً 🤲",
    ].join("\n"));
    if (ok) sheet.close();
  });
}

/* =========================================================
   وضع مكاتب المحاماة والاستشارات
   ========================================================= */
function openLegal(p) {
  const s = S.store;
  const c = customer();
  const today = tzParts(s.timezone, now()).ymd;
  const sel = itemSelect(p, { allowGeneral: true, generalLabel: "غير محدد / أخرى" });
  let kind = "office";
  const kindSeg = segmented("lkind", [
    { value: "office", label: "🏢 حضورية" }, { value: "remote", label: "💻 عن بُعد" }, { value: "contract", label: "📄 صياغة عقد" },
  ], kind, (v) => { kind = v; });
  const brief = textField("نبذة مختصرة عن القضية / الطلب", { multiline: true, maxlength: "600", placeholder: "اكتب ملخصاً موجزاً دون تفاصيل حساسة..." }, "لا تكتب بيانات سرية هنا؛ سيتم التواصل معك لاستكمال التفاصيل.");
  const date = h("input", { class: "input", type: "date", min: today });
  let period = "any";
  const periodSeg = segmented("lperiod", [{ value: "am", label: "صباحاً" }, { value: "pm", label: "مساءً" }, { value: "any", label: "أي وقت" }], period, (v) => { period = v; });
  const f = nameAndPhone(c);
  const sendBtn = h("button", { class: "btn btn-accent btn-lg btn-block", type: "button" }, "إرسال طلب الاستشارة عبر واتساب");

  const sheet = openSheet({
    title: "حجز استشارة",
    body: [
      h("label", { class: "field" }, h("span", { text: "التخصص" }), sel),
      h("div", { class: "field" }, h("span", { class: "label" }, "نوع الاستشارة"), kindSeg),
      brief.el,
      h("label", { class: "field" }, h("span", { text: "التاريخ المناسب (اختياري)" }), date),
      h("div", { class: "field" }, h("span", { class: "label" }, "الوقت المناسب"), periodSeg),
      f.name.el, f.phone.el,
    ],
    foot: sendBtn,
  });
  bindCooldown(sendBtn, "إرسال طلب الاستشارة عبر واتساب");

  sendBtn.addEventListener("click", async () => {
    const b = multiLine(brief.input.value, 600);
    if (b.length < 10) { brief.input.classList.add("invalid"); brief.input.focus(); return toast("اكتب نبذة مختصرة (10 أحرف على الأقل)", "error"); }
    const who = validateNamePhone(f);
    if (!who) return;
    saveCustomer({ name: who.name, phone: who.phone });
    const it = S.products.find((x) => x.id === sel.value);
    const kindLabel = { office: "حضورية", remote: "عن بُعد", contract: "صياغة عقد" }[kind];
    const periodLabel = { am: "صباحاً", pm: "مساءً", any: "أي وقت" }[period];
    const fee = it ? num(it.price) : 0;
    const ok = await submitToWhatsApp(sendBtn, fee, it ? [{ n: it.name.slice(0, 60), q: 1, t: fee }] : [], (no) => {
      const L = [`⚖️ *طلب استشارة جديد #${no}*`, `🏛️ ${s.name}`, SEP,
        `👤 *الاسم:* ${who.name}`, `📱 *الجوال:* ${who.phone}`, SEP,
        `📚 *التخصص:* ${it?.name || "غير محدد"}`, `🗂️ *نوع الاستشارة:* ${kindLabel}`,
        `🗓️ *الوقت المناسب:* ${date.value ? fmtDateAr(date.value) + " — " : ""}${periodLabel}`, SEP,
        `📝 *نبذة مختصرة:*`, b];
      if (fee > 0) L.push(SEP, `💰 *رسوم الاستشارة: ${money(fee)}*`);
      return L.join("\n");
    });
    if (ok) sheet.close();
  });
}

/* =========================================================
   PWA: زر/بانر "أضف للشاشة الرئيسية"
   ========================================================= */
let deferredPrompt = null;
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const dismissKey = () => `pwa_dismiss_${slug}`;

function setupInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    maybeShowInstall();
  });
  window.addEventListener("appinstalled", () => { deferredPrompt = null; const sl = $("#install-slot"); if (sl) fill(sl); });
}

function maybeShowInstall() {
  const slot = $("#install-slot");
  if (!slot || isStandalone()) return;
  if (Date.now() - (ls.get(dismissKey(), 0) || 0) < 7 * 86400000) return;
  if (!deferredPrompt && !isIOS()) return;

  const bar = h("div", { class: "install-bar", role: "region", "aria-label": "تثبيت التطبيق" },
    h("div", { class: "ico", "aria-hidden": "true" }, "📲"),
    h("div", { class: "grow" }, h("b", { class: "small", text: "أضف للشاشة الرئيسية لطلب أسرع" }),
      h("div", { class: "hint", text: `افتح ${S.store.name} كتطبيق بلمسة واحدة` })),
    h("button", { class: "btn btn-primary btn-sm", type: "button", onClick: install }, "إضافة"),
    h("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": "إخفاء",
      onClick: () => { ls.set(dismissKey(), Date.now()); fill(slot); } }, "✕"));
  fill(slot, bar);
}

async function install() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    const sl = $("#install-slot");
    if (outcome === "accepted" && sl) fill(sl);
    return;
  }
  openSheet({
    title: "إضافة للشاشة الرئيسية",
    body: h("ol", { class: "stack", style: { margin: "0", "padding-inline-start": "20px" } },
      h("li", {}, "اضغط زر المشاركة ", h("b", {}, "⬆️"), " أسفل المتصفح (Safari)."),
      h("li", {}, "اختر ", h("b", {}, "«إضافة إلى الشاشة الرئيسية»"), "."),
      h("li", {}, "اضغط ", h("b", {}, "«إضافة»"), " — ستظهر أيقونة المتجر كتطبيق.")),
  });
}
