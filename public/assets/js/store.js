// =========================================================
// واجهة المتجر العامة: domain.com/?store=slug
// تصميم بأسلوب تطبيقات التوصيل: غلاف + بطاقة متجر + أقسام ثابتة + سلة عائمة
// =========================================================
import { CONFIG } from "./config.js";
import {
  h, fill, $, toast, openSheet, copyText, money, moneyText, fmtDateMsg, t, initLang, setLang, isEn, num, oneLine, multiLine, isValidPhone, waLink,
  initials, store as ls, applyTheme, openState, weekSchedule, tzWeekday, dayName, dayShort, fmtTime12, fmtDateAr, tzParts, addDays, MODES,
  createSb, rpc, withTimeout, debounce, getStoreSlug, toLatinDigits,
} from "./common.js";
import { EN } from "./i18n.js";

const slug = getStoreSlug();
const root = document.getElementById("app");
const sb = createSb();

const S = {
  store: null,
  products: [],
  serverOffset: 0,             // فرق ساعة الجهاز عن ساعة الخادم
  cart: [],
  timers: [],
  observers: [],
  query: "",
};

const now = () => new Date(Date.now() + S.serverOffset);
const cartKey = () => `cart_${slug}`;
const CUSTOMER_KEY = "customer_profile";
const MODE_ICON = { order: "🍽️", booking: "🏡", inquiry: "🏢", charity: "💚", legal: "⚖️" };

/* =========================================================
   التشغيل
   ========================================================= */
initLang(EN);
boot();

/** زر تبديل اللغة (عربي ⇄ English) */
function langBtn() {
  return h("button", { class: "round-btn lang-btn", type: "button", "aria-label": isEn() ? "العربية" : "English",
    onClick: () => {
      setLang(isEn() ? "ar" : "en");
      document.querySelectorAll(".sheet-backdrop").forEach((b) => b.remove());
      document.body.style.removeProperty("overflow");
      if (S.store) { setupHead(); render(); } else boot();
    } }, isEn() ? "ع" : "EN");
}

async function boot() {
  if (!slug) return renderLanding();
  renderSkeleton();
  try {
    await load(true);
  } catch {
    return renderState("📡", t("تعذر تحميل الصفحة"), t("تحقق من اتصالك بالإنترنت ثم أعد المحاولة."), true);
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
    return renderState("🔍", t("المتجر غير موجود"), t("تأكد من صحة الرابط."));
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
  const y = window.scrollY;
  render();
  if (!first) window.scrollTo(0, y);
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
  fill(root, h("div", { class: "sf" },
    h("div", { class: "skeleton", style: { height: "230px", "border-radius": "0" } }),
    h("div", { class: "sf-pad stack", style: { "margin-top": "16px" } },
      h("div", { class: "row" }, h("div", { class: "skeleton", style: { width: "84px", height: "84px", "border-radius": "22px", "margin-top": "-50px" } }),
        h("div", { class: "skeleton grow", style: { height: "24px" } })),
      h("div", { class: "skeleton", style: { height: "58px" } }),
      ...[1, 2, 3, 4].map(() => h("div", { class: "row", style: { gap: "14px" } },
        h("div", { class: "grow stack", style: { gap: "8px" } }, h("div", { class: "skeleton", style: { height: "16px", width: "60%" } }),
          h("div", { class: "skeleton", style: { height: "12px" } }), h("div", { class: "skeleton", style: { height: "14px", width: "30%" } })),
        h("div", { class: "skeleton", style: { width: "112px", height: "112px", "border-radius": "16px" } }))))));
}

function renderState(icon, title, text, retry = false) {
  fill(root, h("div", { class: "state-screen" },
    h("div", {},
      h("div", { class: "ico", "aria-hidden": "true" }, icon),
      h("h1", { text: title }),
      h("p", { class: "muted", text }),
      retry ? h("button", { class: "btn btn-primary mt", onClick: () => location.reload() }, t("إعادة المحاولة")) : null)));
}

function renderSuspended(s) {
  fill(root, h("div", { class: "state-screen" },
    h("div", { class: "stack", style: { "max-width": "380px", "justify-items": "center" } },
      s.logo_url ? h("img", { src: s.logo_url, alt: "", class: "sf-logo", style: { margin: "0" } })
                 : h("div", { class: "sf-logo", style: { margin: "0" } }, initials(s.name)),
      h("h1", { text: s.name, style: { margin: "4px 0 0" } }),
      h("div", { class: "ico", "aria-hidden": "true" }, "⏸️"),
      h("p", { class: "muted", style: { margin: "0" }, text: t("هذه الصفحة متوقفة مؤقتاً. نعتذر عن الإزعاج، وسنعود قريباً بإذن الله.") }))));
}

function renderLanding() {
  const inp = h("input", { class: "input ltr", placeholder: "store-name", "aria-label": t("رابط المتجر"), style: { "text-align": "left" } });
  const go = () => {
    const v = oneLine(inp.value, 40).toLowerCase();
    if (/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(v)) location.search = `?store=${v}`;
    else toast(t("اكتب رابط المتجر بالأحرف الإنجليزية"), "error");
  };
  inp.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  fill(root, h("div", { class: "state-screen" },
    h("div", { class: "card stack", style: { "max-width": "420px", width: "100%" } },
      h("div", { class: "ico", "aria-hidden": "true" }, "🍽️"),
      h("h1", { text: t("منيو إلكتروني وبوابات طلب عبر واتساب") }),
      h("p", { class: "muted", text: t("افتح صفحة أي متجر عبر رابطه الخاص.") }),
      inp,
      h("button", { class: "btn btn-primary btn-block", onClick: go }, t("فتح المتجر")))));
}

/* =========================================================
   الصفحة الرئيسية للمتجر
   ========================================================= */
function cleanup() {
  S.timers.forEach(clearInterval);
  S.timers = [];
  S.observers.forEach((o) => o.disconnect());
  S.observers = [];
}

function logoEl(s, cls) {
  return s.logo_url ? h("img", { class: cls, src: s.logo_url, alt: s.name }) : h("div", { class: cls, "aria-hidden": "true" }, initials(s.name));
}

async function shareStore() {
  const url = `${location.origin}/?store=${slug}`;
  try {
    if (navigator.share) return await navigator.share({ title: S.store.name, url });
  } catch { return; }
  copyText(url, t("تم نسخ رابط المتجر ✅"));
}

/* ---------------- أوقات العمل ---------------- */
function closedText(st) {
  if (st.manual) return t("مغلق الآن مؤقتاً");
  if (st.closedAll || !st.opensAt) return t("المتجر مغلق حالياً");
  const time = fmtTime12(st.opensAt);
  if (st.opensDay === "tomorrow") return t("مغلق الآن — يفتح بكرة الساعة {t}", { t: time });
  if (typeof st.opensDay === "number") return t("مغلق الآن — يفتح يوم {d} الساعة {t}", { d: dayName(st.opensDay), t: time });
  return t("مغلق الآن — يفتح الساعة {t}", { t: time });
}

function todayHoursText(s) {
  const week = weekSchedule(s);
  if (!week) return t("24 ساعة");
  const sh = week[tzWeekday(s.timezone, now())];
  if (!sh.length) return t("مغلق اليوم");
  return `${fmtTime12(sh[0].o)} - ${fmtTime12(sh[0].c)}${sh.length > 1 ? " +" : ""}`;
}

function openHoursSheet() {
  const s = S.store;
  const week = weekSchedule(s);
  const today = tzWeekday(s.timezone, now());
  openSheet({
    title: t("أوقات العمل"),
    body: week ? h("div", { class: "hours-list" }, [0, 1, 2, 3, 4, 5, 6].map((d) => h("div", { class: `hours-row${d === today ? " today" : ""}` },
      h("b", { text: dayName(d) }),
      h("span", { text: week[d].length ? week[d].map((x) => `${fmtTime12(x.o)} - ${fmtTime12(x.c)}`).join(isEn() ? " , " : " ، ") : t("مغلق") }))))
      : h("p", { class: "center", style: { margin: "0" }, text: t("مفتوح 24 ساعة طوال الأسبوع") }),
  });
}

/* ---------------- السعر قبل الخصم والمخزون ---------------- */
function oldPrice(p) {
  const o = num(p.options_json?.old_price);
  return o > startingPrice(p) ? o : 0;
}
function priceNodes(p, amount) {
  const o = oldPrice(p);
  return [money(amount), o ? h("s", { class: "old-price", text: money(o) }) : null];
}
/** الكمية المتبقية القابلة للإضافة (Infinity إذا غير محدود) */
function stockLeft(p, exceptQty = 0) {
  if (p.stock == null) return Infinity;
  return Math.max(0, num(p.stock) - (qtyInCart(p.id) - exceptQty));
}

function render() {
  cleanup();
  const s = S.store;
  const mode = s.business_mode;
  const st = openState(s, now());

  /* شريط علوي مصغّر يظهر بعد تجاوز الغلاف */
  const topbar = h("header", { class: "sf-topbar", "aria-hidden": "true" },
    logoEl(s, "ph"), h("b", { text: s.name }), langBtn(),
    h("button", { class: "round-btn", type: "button", "aria-label": t("مشاركة"), onClick: shareStore }, "↗"));

  /* الغلاف */
  const cover = h("div", { class: "sf-cover" },
    s.cover_url ? h("img", { src: s.cover_url, alt: "" }) : h("div", { class: "pattern" }),
    h("div", { class: "sf-cover-actions" },
      h("button", { class: "round-btn", type: "button", "aria-label": t("مشاركة المتجر"), onClick: shareStore }, "↗"),
      langBtn()));

  /* بطاقة المتجر */
  const info = [];
  info.push(h("div", {}, h("span", { class: "k" }, t("الحالة")),
    h("span", { class: "v" }, h("i", { class: `dot ${st.open ? "on" : "off"}` }), st.open ? t("مفتوح") : t("مغلق"))));
  info.push(h("button", { type: "button", class: "info-btn", onClick: openHoursSheet, "aria-label": t("أوقات العمل") }, h("span", { class: "k" }, t("أوقات العمل") + " ›"),
    h("span", { class: "v", text: todayHoursText(s) })));
  if (mode === "order") {
    info.push(h("div", {}, h("span", { class: "k" }, t("التوصيل")), h("span", { class: "v", text: num(s.delivery_fee) > 0 ? money(s.delivery_fee) : t("مجاني") })));
  } else {
    const label = { booking: t("الوحدات"), inquiry: t("العروض"), charity: t("المبادرات"), legal: t("التخصصات") }[mode];
    info.push(h("div", {}, h("span", { class: "k" }, label), h("span", { class: "v", text: String(S.products.filter((p) => p.is_available).length) })));
  }

  const head = h("section", { class: "sf-head" },
    h("div", { class: "sf-head-row" }, logoEl(s, "sf-logo"),
      h("div", { class: "sf-title" }, h("h1", { class: "hero-name", text: s.name }),
        s.business_type ? h("div", { class: "sub", text: s.business_type }) : null)),
    h("div", { class: "sf-info" }, info));

  const page = h("div", { class: "sf" }, topbar, cover, head);

  if (!st.open) {
    page.append(h("div", { class: "sf-closed", role: "alert" },
      h("span", { class: "ico", "aria-hidden": "true" }, "🌙"),
      h("div", {},
        h("div", { text: closedText(st) }),
        h("div", { class: "small", style: { "font-weight": "500" }, text: t("تقدر تتصفح، وبيتاح الطلب أول ما نفتح.") }))));
  }

  const groups = groupProducts();
  const banner = renderBanner(groups);
  if (banner) page.append(banner);
  page.append(h("div", { id: "install-slot" }));

  /* ترحيب */
  const cname = oneLine(customer().name, 30);
  const greet = { order: t("وش ودك تطلب اليوم"), booking: t("وين ودك تقضي إجازتك"), inquiry: t("تدوّر على عقار يناسبك"), charity: t("ساهم معنا في الخير"), legal: t("كيف نقدر نخدمك") }[mode];
  page.append(h("div", { class: "sf-greet" }, cname ? t("{g} يا {n}؟", { g: t(greet), n: cname }) : `${t(greet)}${isEn() ? "?" : "؟"}`,
    h("small", { text: mode === "order" ? t("اختر من الأقسام وأرسل طلبك عبر واتساب بثواني") : t("تصفح واختر، وطلبك يوصل مباشرة عبر واتساب") })));

  /* أقسام دائرية */
  if (groups.length > 1) page.append(...categoryCircles(groups));
  if (mode === "order") { const ro = reorderCard(); if (ro) page.append(ro); }
  if (mode === "charity" && s.iban_number) page.append(ibanCard());

  /* بحث */
  const search = h("input", { type: "search", placeholder: t("ابحث في {x}...", { x: t(MODES[mode].items) }), value: S.query, "aria-label": t("بحث") });
  if (S.products.length > 5) page.append(h("div", { class: "sf-search" }, h("span", { class: "i", "aria-hidden": "true" }, "🔍"), search));

  /* تبويبات الأقسام */
  let tabs = null;
  if (groups.length > 1) {
    tabs = h("div", { class: "sf-tabs" }, h("nav", { "aria-label": t("الأقسام") }, groups.map((g, i) =>
      h("button", { class: `sf-tab${i === 0 ? " active" : ""}`, type: "button", dataset: { idx: String(g.idx) },
        onClick: () => document.getElementById(`cat-${g.idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }, g.name))));
    page.append(tabs);
  } else {
    page.append(h("div", { class: "sf-band", style: { "margin-top": "14px" } }));
  }

  /* مختارات (وضع الطلبات) */
  if (mode === "order") {
    const feat = S.products.filter((p) => p.is_available && productImages(p)[0]).slice(0, 8);
    if (feat.length >= 3) {
      page.append(h("section", { class: "featured-wrap" },
        h("div", { class: "sf-sec" }, h("h2", { class: "sf-sec-title", text: t("مختارات لك ✨") })),
        h("div", { class: "sf-featured" }, feat.map(featuredCard))));
    }
  }

  /* الأقسام */
  const listWrap = h("div", {});
  const sections = groups.map((g) => {
    const list = h("div", { class: "sf-list" }, g.items.map(productCard));
    const sec = h("section", { class: "sf-sec", dataset: { idx: String(g.idx) } },
      h("h2", { class: "sf-sec-title", id: `cat-${g.idx}`, text: g.name }), list);
    sec._items = g.items;
    return sec;
  });
  const noResults = h("div", { class: "sf-empty", hidden: true }, t("لا توجد نتائج مطابقة 🔎"));
  if (!S.products.length) listWrap.append(h("div", { class: "sf-empty" }, t("لا توجد {x} حالياً", { x: t(MODES[mode].items) })));
  listWrap.append(...sections, noResults);
  page.append(listWrap, h("div", { class: "sf-bottom-space" }));

  const applySearch = () => {
    S.query = search.value;
    const q = oneLine(search.value, 40);
    let any = false;
    for (const sec of sections) {
      let visible = 0;
      sec.querySelectorAll(".item, .lcard").forEach((el, i) => {
        const p = sec._items[i];
        const show = !q || p.name.includes(q) || (p.description || "").includes(q) || (p.category || "").includes(q);
        el.hidden = !show;
        if (show) visible++;
      });
      sec.hidden = visible === 0;
      if (visible) any = true;
    }
    noResults.hidden = any || !S.products.length;
    $(".featured-wrap", page)?.toggleAttribute("hidden", !!q);
  };
  search.addEventListener("input", applySearch);
  if (S.query) applySearch();

  S.ctaEl = ctaBar();
  fill(root, page, S.ctaEl);
  wireScroll(cover, topbar, tabs, sections);
  maybeShowInstall();
}

/** يظهر الشريط العلوي بعد الغلاف + يحدّث التبويب النشط حسب القسم الظاهر */
function wireScroll(cover, topbar, tabs, sections) {
  if (!("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver(([e]) => {
    const show = !e.isIntersecting;
    topbar.classList.toggle("show", show);
    topbar.setAttribute("aria-hidden", show ? "false" : "true");
    tabs?.classList.toggle("under-bar", show);
  }, { threshold: 0 });
  io.observe(cover);
  S.observers.push(io);
  if (!tabs) return;
  const spy = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const idx = e.target.dataset.idx;
      tabs.querySelectorAll(".sf-tab").forEach((b) => {
        const on = b.dataset.idx === idx;
        b.classList.toggle("active", on);
        if (on) b.scrollIntoView({ inline: "center", block: "nearest" });
      });
    }
  }, { rootMargin: "-120px 0px -65% 0px" });
  sections.forEach((s) => spy.observe(s));
  S.observers.push(spy);
}

function groupProducts() {
  const fallback = MODES[S.store.business_mode].items;
  const map = new Map();
  for (const p of S.products) {
    const key = p.category || t(fallback);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(p);
  }
  return [...map.entries()].map(([name, items], idx) => ({ name, items, idx }));
}

/* ---------------- البنر والعداد التنازلي ---------------- */
function renderBanner(groups = []) {
  const s = S.store;
  if (!s.banner_active || (!s.banner_text && !s.banner_image_url)) return null;
  const ends = s.banner_expires_at ? new Date(s.banner_expires_at).getTime() : null;
  if (ends && ends <= now().getTime()) return null;

  const hh = h("b"), mm = h("b"), ss = h("b");
  const cd = ends ? h("div", { class: "countdown", "aria-label": t("الوقت المتبقي للعرض") }, hh, ":", mm, ":", ss) : null;
  const pct = /(\d{1,2})\s*[%٪]/.exec(toLatinDigits(s.banner_text || ""));
  const goMenu = () => {
    if (s.business_mode === "order" || !S.ctaEl?.querySelector("button")) document.getElementById(`cat-${groups[0]?.idx ?? 0}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    else S.ctaEl.querySelector("button").click();
  };
  const el = h("section", { class: `sf-promo promo poster${s.banner_image_url ? " has-img" : ""}`, "aria-label": t("عرض") },
    s.banner_image_url ? h("img", { src: s.banner_image_url, alt: s.banner_text || "عرض" }) : null,
    s.banner_image_url ? null : h("div", { class: "sticker", "aria-hidden": "true" }, pct ? [t("خصم"), h("b", {}, `${pct[1]}%`)] : ["🔥", h("b", {}, t("عرض"))]),
    h("div", { class: "sf-promo-body" },
      h("div", { class: "stack", style: { gap: "8px", "justify-items": "start" } },
        h("span", { class: "tag" }, ends ? t("⏳ لفترة محدودة") : t("🔥 عرض خاص")),
        s.banner_text ? h("div", { class: "sf-promo-text", text: s.banner_text }) : null,
        h("div", { class: "promo-cta" }, h("button", { class: "btn btn-sm", type: "button", onClick: goMenu }, t("اطلب الحين ←")), cd))));

  if (ends) {
    const tick = () => {
      const left = Math.max(0, ends - now().getTime());
      if (left <= 0) { el.remove(); clearInterval(timer); return; }
      const sec = Math.floor(left / 1000);
      hh.textContent = String(Math.floor(sec / 3600)).padStart(2, "0");
      mm.textContent = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
      ss.textContent = String(sec % 60).padStart(2, "0");
    };
    tick();
    const timer = setInterval(tick, 1000);
    S.timers.push(timer);
  }
  return el;
}

function ibanCard() {
  const iban = S.store.iban_number;
  return h("section", { class: "sf-iban", "aria-label": t("الحساب البنكي") },
    h("div", { class: "t" }, h("span", { "aria-hidden": "true" }, "🏦"), t("الآيبان الرسمي للتبرع")),
    h("div", { class: "iban-box" },
      h("code", { text: iban.replace(/(.{4})/g, "$1 ").trim() }),
      h("button", { class: "btn btn-primary btn-sm", type: "button", onClick: () => copyText(iban, t("تم نسخ الآيبان ✅")) }, t("نسخ"))));
}

/* ---------------- الأقسام الدائرية ---------------- */
const PASTELS = ["#fff1e6", "#e8f7ee", "#e8f1ff", "#fdeaf3", "#fff8d6", "#eceafd", "#e6f7f9", "#f3f4f6"];

function catCircle(g, i, onPick) {
  const img = g.items.map((p) => productImages(p)[0]).find(Boolean);
  return h("button", { class: "cat-circle", type: "button", onClick: () => { onPick?.(); document.getElementById(`cat-${g.idx}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); } },
    h("span", { class: "c", style: { background: PASTELS[i % PASTELS.length] } }, img ? h("img", { src: img, alt: "", loading: "lazy" }) : MODE_ICON[S.store.business_mode]),
    h("span", { text: g.name }));
}

function categoryCircles(groups) {
  const head = h("div", { class: "sf-cats-head" }, h("b", { text: t("الأقسام") }),
    groups.length > 4 ? h("button", { class: "link-btn", type: "button", onClick: () => {
      const sh = openSheet({ title: t("كل الأقسام"), body: h("div", { class: "cat-grid" }, groups.map((g, i) => catCircle(g, i, () => sh.close()))) });
    } }, t("عرض الكل")) : null);
  return [head, h("div", { class: "sf-cats" }, groups.map((g, i) => catCircle(g, i)))];
}

/* ---------------- أعد طلبك المعتاد ---------------- */
const lastKey = () => `last_order_${slug}`;

function reorderCard() {
  const last = ls.get(lastKey(), null);
  if (!last || !Array.isArray(last.lines)) return null;
  const lines = sanitizeCart(last.lines);
  if (!lines.length) return null;
  const total = lines.reduce((a, l) => a + lineUnit(l) * l.qty, 0);
  return h("section", { class: "reorder", "aria-label": t("إعادة الطلب") },
    h("div", { class: "top" }, h("b", {}, t("أعد طلبك المعتاد")), h("span", { class: "muted small", text: money(total) })),
    h("div", { class: "lines" },
      h("div", { class: "thumbs" }, lines.slice(0, 3).map((l) => l.img ? h("img", { src: l.img, alt: "" }) : h("span", { class: "ph" }, "🍽️"))),
      h("div", { class: "txt" }, lines.slice(0, 2).map((l) => h("div", { text: `x${l.qty} ${l.name}${l.size ? ` (${l.size.name})` : ""}` })),
        lines.length > 2 ? h("div", { text: t("+ {n} أصناف أخرى", { n: lines.length - 2 }) }) : null),
      h("button", { class: "btn btn-yellow btn-sm", type: "button", onClick: () => {
        for (const l of lines) addToCart({ ...l });
        toast(t("رجّعنا طلبك السابق للسلة ✅"), "success");
        openCheckout();
      } }, t("↻ إعادة الطلب"))));
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

const qtyInCart = (pid) => S.cart.filter((l) => l.pid === pid).reduce((a, l) => a + l.qty, 0);

function openItem(p) {
  const mode = S.store.business_mode;
  if (mode === "order") openProduct(p);
  else if (mode === "charity") openDonation(p);
  else if (mode === "legal") openLegal(p);
  else openListing(p);
}

function featuredCard(p) {
  const q = qtyInCart(p.id);
  return h("button", { class: "fcard", type: "button", "aria-label": p.name, onClick: () => openProduct(p) },
    h("div", { class: "media" }, h("img", { src: productImages(p)[0], alt: "", loading: "lazy" }),
      h("span", { class: `add-btn${q ? " has-qty" : ""}`, dataset: { pid: p.id }, style: { bottom: "8px", "inset-inline-end": "8px" } }, q ? String(q) : "+")),
    h("b", { text: p.name }),
    h("div", { class: "p" }, priceNodes(p, startingPrice(p))));
}

function productCard(p) {
  const mode = S.store.business_mode;
  const off = !p.is_available;
  const imgs = productImages(p);

  if (mode === "booking" || mode === "inquiry") {
    const specs = (p.options_json?.specs || []).slice(0, 4);
    const unit = p.options_json?.unit || (mode === "booking" ? "ليلة" : "");
    const card = h("button", { class: "lcard listing", type: "button", disabled: off, "aria-label": p.name },
      h("div", { class: "media" },
        imgs.length ? h("div", { class: "gallery" }, imgs.map((u) => h("img", { src: u, alt: "", loading: "lazy" })))
                    : h("div", { class: "ph", "aria-hidden": "true" }, MODE_ICON[mode]),
        imgs.length > 1 ? h("span", { class: "pill count" }, `1/${imgs.length} 📷`) : null,
        off ? h("span", { class: "pill na" }, mode === "booking" ? t("محجوز") : t("غير متاح")) : null,
        num(p.price) > 0 ? h("span", { class: "pill price" }, money(p.price), unit ? ` / ${t(unit)}` : "") : null),
      h("div", { class: "body" },
        h("h3", { text: p.name }),
        p.description ? h("p", { text: p.description }) : null,
        specs.length ? h("div", { class: "specs" }, specs.map((x) => h("span", { class: "spec" }, h("b", { text: x.label }), x.value ? `: ${x.value}` : ""))) : null));
    if (!off) card.addEventListener("click", () => openListing(p));
    return card;
  }

  let price = null;
  if (mode === "order") {
    const hasSizes = (p.options_json?.sizes || []).length > 0;
    price = h("div", { class: "item-price" }, hasSizes ? h("span", { class: "from" }, t("يبدأ من")) : null, priceNodes(p, startingPrice(p)),
      p.stock != null && p.stock <= 5 ? h("span", { class: "low-stock", text: t("باقي {n} فقط", { n: p.stock }) }) : null);
  } else if (num(p.price) > 0) {
    price = h("div", { class: "item-price" }, h("span", { class: "from" }, mode === "charity" ? t("قيمة السهم") : t("رسوم الاستشارة")), money(p.price));
  }

  const q = mode === "order" ? qtyInCart(p.id) : 0;
  const action = off ? null : mode === "order"
    ? h("span", { class: `add-btn${q ? " has-qty" : ""}`, dataset: { pid: p.id }, "aria-hidden": "true" }, q ? String(q) : "+")
    : h("span", { class: "cta-pill" }, mode === "charity" ? t("تبرع") : t("احجز"));

  const card = h("button", { class: `item product${imgs[0] ? "" : " no-img"}${off ? " off unavailable" : ""}`, type: "button", disabled: off, "aria-label": p.name },
    h("div", { class: "item-info" },
      h("h3", { class: "item-name product-name", text: p.name }),
      p.description ? h("p", { class: "item-desc", text: p.description }) : null,
      off ? h("span", { class: "soldout" }, t("غير متوفر حالياً")) : price),
    h("div", { class: "item-media" },
      imgs[0] ? h("img", { src: imgs[0], alt: "", loading: "lazy", width: "112", height: "112" }) : h("div", { class: "ph", "aria-hidden": "true" }, MODE_ICON[mode]),
      mode === "order" && oldPrice(p) ? h("span", { class: "sale-badge", text: `-${Math.round((1 - startingPrice(p) / oldPrice(p)) * 100)}%` }) : null,
      action));
  if (!off) card.addEventListener("click", () => openItem(p));
  return card;
}

function refreshBadges() {
  document.querySelectorAll(".add-btn[data-pid]").forEach((b) => {
    const q = qtyInCart(b.dataset.pid);
    b.textContent = q ? String(q) : "+";
    b.classList.toggle("has-qty", q > 0);
  });
}

function ctaBar() {
  const mode = S.store.business_mode;
  if (mode === "order") {
    const count = S.cart.reduce((a, l) => a + l.qty, 0);
    if (!count) return h("div");
    return h("div", { class: "cartbar-wrap cta-bar" },
      h("button", { class: "cartbar btn", type: "button", onClick: openCheckout },
        h("span", { class: "count" }, String(count)), h("span", { class: "label" }, t("عرض السلة")), h("span", { class: "total" }, money(cartSubtotal()))));
  }
  const label = { booking: t("📅 احجز الآن"), inquiry: t("🏢 اطلب معاينة / استفسار"), charity: t("💚 تبرع الآن"), legal: t("⚖️ احجز استشارة") }[mode];
  const open = { booking: () => openBooking(null), inquiry: () => openInquiry(null), charity: () => openDonation(null), legal: () => openLegal(null) }[mode];
  if (mode === "booking" && !S.products.some((p) => p.is_available)) return h("div");
  return h("div", { class: "cartbar-wrap cta-bar" },
    h("button", { class: "cartbar btn", type: "button", onClick: open, style: mode === "legal" ? { background: "var(--accent)" } : null },
      h("span", { class: "label" }, label)));
}

function refreshCta() {
  const n = ctaBar();
  if (S.ctaEl?.isConnected) S.ctaEl.replaceWith(n);
  else root.append(n);
  S.ctaEl = n;
  refreshBadges();
}

/* =========================================================
   وضع الطلبات (order): السلة
   ========================================================= */
function lineKey(l) {
  return [l.pid, l.size?.name || "", ...(l.addons || []).map((a) => a.name).sort(), l.note || ""].join("|");
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
    let qty = Math.min(99, Math.max(1, Math.floor(num(l.qty)) || 1));
    if (p.stock != null) {
      const used = out.filter((x) => x.pid === p.id).reduce((a, x) => a + x.qty, 0);
      qty = Math.min(qty, p.stock - used);
      if (qty <= 0) { dropped++; continue; }
    }
    out.push({ pid: p.id, name: p.name, img: p.image_url || null, base: num(p.price), size, addons: ad,
      note: oneLine(l.note, 120), qty });
  }
  if (notify && dropped) toast(t("تم تحديث السلة: بعض الأصناف لم تعد متوفرة"));
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

function stepper(value, onChange, small = false, min = 1, max = 99) {
  const out = h("output", { text: String(value) });
  let v = value;
  const set = (n) => {
    const lim = Math.min(99, typeof max === "function" ? max() : max);
    if (n > lim) { toast(t("هذي كل الكمية المتوفرة"), ""); n = lim; }
    v = Math.max(min, n); out.textContent = String(v); onChange(v);
  };
  return h("div", { class: `stepper qty${small ? " sm" : ""}` },
    h("button", { type: "button", "aria-label": t("زيادة"), onClick: () => set(v + 1) }, "+"),
    out,
    h("button", { type: "button", "aria-label": t("إنقاص"), onClick: () => set(v - 1) }, "−"));
}

function optGroup(title, tag, sub, rows) {
  return h("section", { class: "opt-group" },
    h("div", { class: "opt-head" }, h("b", { text: title }), tag),
    sub ? h("div", { class: "opt-sub", text: sub }) : null,
    h("div", {}, rows));
}

function openProduct(p) {
  const sizes = p.options_json?.sizes || [];
  const addons = p.options_json?.addons || [];
  const state = { size: null, addons: new Set(), qty: 1 };
  const imgs = productImages(p);

  const sizeTag = h("span", { class: "opt-tag req" }, t("مطلوب"));
  const addBtn = h("button", { class: "btn btn-primary", type: "button" });
  const unit = () => (state.size ? num(state.size.price) : num(p.price)) + [...state.addons].reduce((a, i) => a + num(addons[i].price), 0);
  const updateBtn = () => {
    const need = sizes.length && !state.size;
    fill(addBtn, h("span", {}, need ? t("اختر الحجم أولاً") : t("أضف للسلة")), h("span", {}, money(unit() * state.qty)));
    addBtn.classList.toggle("btn-soft", !!need);
    addBtn.classList.toggle("btn-primary", !need);
  };

  const note = h("textarea", { class: "note-input", maxlength: "120", placeholder: t("مثال: بدون بصل، صوص إضافي..."), "aria-label": t("ملاحظة على الصنف") });
  const body = [
    h("div", { class: `p-hero${imgs[0] ? "" : " no-img"}` }, imgs[0] ? h("img", { src: imgs[0], alt: p.name }) : null),
    h("div", { class: "stack", style: { gap: "6px" } },
      h("h2", { class: "p-title", text: p.name }),
      p.description ? h("p", { class: "p-desc", text: p.description }) : null,
      h("div", { class: "p-price" }, sizes.length ? h("span", { class: "muted small", style: { "font-weight": "500" } }, t("يبدأ من ")) : null, priceNodes(p, startingPrice(p))),
      p.stock != null ? h("div", { class: "low-stock", text: t("المتوفر: {n}", { n: p.stock }) }) : null),
  ];

  let sizeGroup = null;
  if (sizes.length) {
    const group = `size-${p.id}`;
    sizeGroup = optGroup(t("اختر الحجم / النوع"), sizeTag, t("اختر خياراً واحداً"), sizes.map((sz) =>
      h("label", { class: "opt-row option" },
        h("input", { type: "radio", name: group, onChange: () => {
          state.size = sz; sizeTag.textContent = t("✓ تم"); sizeTag.classList.add("ok"); updateBtn();
        } }),
        h("span", { class: "n", text: sz.name }),
        h("span", { class: "pr", text: money(sz.price) }))));
    body.push(sizeGroup);
  }
  if (addons.length) {
    body.push(optGroup(t("الإضافات"), h("span", { class: "opt-tag" }, t("اختياري")), null, addons.map((a, i) =>
      h("label", { class: "opt-row option" },
        h("input", { type: "checkbox", onChange: (e) => { e.target.checked ? state.addons.add(i) : state.addons.delete(i); updateBtn(); } }),
        h("span", { class: "n", text: a.name }),
        h("span", { class: "pr", text: num(a.price) ? `+${money(a.price)}` : t("مجاناً") })))));
  }
  body.push(optGroup(t("ملاحظات خاصة"), h("span", { class: "opt-tag" }, t("اختياري")), null, h("div", { style: { padding: "4px 16px 4px" } }, note)));

  const maxQty = () => stockLeft(p);
  const foot = h("div", { class: "p-foot" }, stepper(1, (v) => { state.qty = v; updateBtn(); }, false, 1, maxQty), addBtn);
  const sheet = openSheet({ title: p.name, body, foot, className: "hero-sheet" });
  updateBtn();
  addBtn.addEventListener("click", () => {
    if (sizes.length && !state.size) {
      toast(t("⚠️ الرجاء اختيار الحجم أو النوع قبل الإضافة للسلة"), "error");
      sizeGroup.scrollIntoView({ behavior: "smooth", block: "center" });
      sizeGroup.classList.remove("shake"); void sizeGroup.offsetWidth; sizeGroup.classList.add("shake");
      return;
    }
    if (state.qty > stockLeft(p)) { toast(stockLeft(p) ? t("هذي كل الكمية المتوفرة") : t("الكمية المتوفرة موجودة في سلتك"), "error"); return; }
    addToCart({ pid: p.id, name: p.name, img: p.image_url || null, base: num(p.price), size: state.size,
                addons: [...state.addons].sort().map((i) => addons[i]), note: oneLine(note.value, 120), qty: state.qty });
    sheet.close();
    toast(t("تمت الإضافة للسلة ✅"), "success");
  });
}

/* ---------------- مكونات النماذج ---------------- */
function customer() { return ls.get(CUSTOMER_KEY, {}) || {}; }
function saveCustomer(patch) { ls.set(CUSTOMER_KEY, { ...customer(), ...patch }); }

function sec(title, ...children) {
  return h("section", { class: "sec" }, title ? h("div", { class: "sec-h" }, typeof title === "string" ? h("b", { text: title }) : title) : null, ...children);
}

function textField(label, attrs = {}, hint) {
  const { multiline, ...rest } = attrs;
  const input = multiline ? h("textarea", { class: "textarea", ...rest }) : h("input", { class: "input", ...rest });
  return { input, el: h("label", { class: "field" }, h("span", { text: label }), input, hint ? h("span", { class: "hint", text: hint }) : null) };
}

/** خيارات بطاقات (توصيل/استلام، نوع الاستشارة...) */
function choices(name, options, value, onChange) {
  return h("div", { class: `choice-grid${options.length === 3 ? " three" : ""}`, role: "radiogroup" }, options.map((o) =>
    h("label", { class: "choice" },
      h("input", { type: "radio", name, value: o.value, checked: o.value === value, onChange: () => onChange(o.value) }),
      h("span", {}, o.icon ? h("i", { "aria-hidden": "true" }, o.icon) : null, o.label, o.sub ? h("small", {}, o.sub) : null))));
}

function nameAndPhone(c) {
  const name = textField(t("الاسم"), { autocomplete: "name", value: c.name || "", maxlength: "60", required: true, placeholder: t("اسمك الكريم") });
  const phone = textField(t("رقم الجوال"), { type: "tel", inputmode: "tel", autocomplete: "tel", value: c.phone || "",
    maxlength: "20", placeholder: "05xxxxxxxx", dir: "ltr", style: { "text-align": "right" } });
  return { name, phone };
}

function validateNamePhone(f) {
  const n = oneLine(f.name.input.value, 60);
  f.name.input.classList.toggle("invalid", n.length < 2);
  const okPhone = isValidPhone(f.phone.input.value);
  f.phone.input.classList.toggle("invalid", !okPhone);
  if (n.length < 2) { toast(t("الرجاء كتابة الاسم"), "error"); f.name.input.focus(); return null; }
  if (!okPhone) { toast(t("رقم الجوال غير صحيح"), "error"); f.phone.input.focus(); return null; }
  return { name: n, phone: toLatinDigits(f.phone.input.value).replace(/[^\d+]/g, "") };
}

function bill(rows) {
  return h("div", { class: "bill summary" }, rows.filter(Boolean).map(([k, v, grand]) =>
    h("div", { class: `row${grand ? " grand total" : ""}` }, h("span", {}, k), h("span", {}, v))));
}

/* ---------------- صفحة إتمام الطلب ---------------- */
function openCheckout() {
  const s = S.store;
  const c = customer();
  const st = { type: c.order_type === "pickup" ? "pickup" : "delivery", pay: c.pay || "cash", gps: null, coupon: null };
  const zones = Array.isArray(s.delivery_zones) ? s.delivery_zones : [];
  const zoneSel = zones.length ? h("select", { class: "select", "aria-label": t("الحي") },
    h("option", { value: "" }, t("اختر الحي")),
    zones.map((z, i) => h("option", { value: String(i), selected: z.name === c.district }, `${z.name} — ${num(z.fee) ? money(z.fee) : t("مجاني")}`))) : null;
  const deliveryFee = () => {
    if (st.type !== "delivery") return 0;
    if (zones.length) { const z = zones[Number(zoneSel.value)]; return zoneSel.value === "" || !z ? 0 : num(z.fee); }
    return num(s.delivery_fee);
  };
  const minOrder = num(s.min_order);
  const discountOf = (sub) => {
    const cp = st.coupon;
    if (!cp || sub < num(cp.min_order)) return 0;
    return cp.kind === "percent" ? Math.round(sub * num(cp.value)) / 100 : Math.min(num(cp.value), sub);
  };

  const linesBox = h("div", { class: "stack", style: { gap: "12px" } });
  const billBox = h("div");
  const f = nameAndPhone(c);
  const district = textField(t("الحي"), { value: c.district || "", maxlength: "60", autocomplete: "address-level3", placeholder: t("مثال: النرجس") });
  const address = textField(t("العنوان التفصيلي"), { value: c.address || "", maxlength: "160", placeholder: t("الشارع، رقم المبنى، علامة مميزة"), autocomplete: "street-address" });
  const notes = textField(t("ملاحظات للطلب"), { multiline: true, maxlength: "400", placeholder: t("أي تفاصيل تحب نعرفها؟") });

  const locTitle = h("b", {}, t("حدّد موقعي عبر GPS"));
  const locSub = h("small", {}, t("اختياري إذا كتبت الحي — يساعد المندوب يوصلك أسرع"));
  const gpsBtn = h("button", { class: "loc-card", type: "button" }, h("span", { class: "i", "aria-hidden": "true" }, "📍"), h("span", { class: "grow" }, locTitle, locSub));
  gpsBtn.addEventListener("click", () => {
    if (!navigator.geolocation) return toast(t("المتصفح لا يدعم تحديد الموقع"), "error");
    gpsBtn.disabled = true;
    locSub.textContent = t("جاري تحديد الموقع...");
    navigator.geolocation.getCurrentPosition((pos) => {
      const lat = pos.coords.latitude.toFixed(6), lng = pos.coords.longitude.toFixed(6);
      st.gps = `https://maps.google.com/?q=${lat},${lng}`;
      locTitle.textContent = t("✅ تم تحديد موقعك");
      locSub.textContent = t("اضغط لتحديث الموقع");
      gpsBtn.classList.add("done");
      gpsBtn.disabled = false;
    }, (e) => {
      gpsBtn.disabled = false;
      locSub.textContent = e.code === 1 ? t("تم رفض إذن الموقع — اكتب الحي يدوياً") : t("تعذر تحديد الموقع — اكتب الحي يدوياً");
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  });

  if (zoneSel) zoneSel.addEventListener("change", () => renderBill());
  const deliverySec = sec(t("عنوان التوصيل"), gpsBtn,
    zoneSel ? h("label", { class: "field" }, h("span", { text: t("الحي") }), zoneSel) : district.el, address.el);
  deliverySec.hidden = st.type !== "delivery";

  const ibanBox = s.iban_number ? h("div", { class: "iban-box", hidden: st.pay !== "transfer" },
    h("code", { text: s.iban_number }), h("button", { class: "btn btn-soft btn-sm", type: "button", onClick: () => copyText(s.iban_number) }, t("نسخ"))) : null;
  const pays = [
    { v: "cash", i: "💵", l: t("نقداً عند الاستلام") },
    { v: "card", i: "💳", l: t("شبكة / مدى عند الاستلام") },
    { v: "transfer", i: "🏦", l: t("تحويل بنكي") },
  ];
  const paySec = sec(t("طريقة الدفع"), h("div", {}, pays.map((p) => h("label", { class: "pay-row" },
    h("span", { class: "i", "aria-hidden": "true" }, p.i), h("span", { class: "n" }, p.l),
    h("input", { type: "radio", name: "pay", checked: st.pay === p.v, onChange: () => { st.pay = p.v; if (ibanBox) ibanBox.hidden = p.v !== "transfer"; } })))), ibanBox);

  const typeSec = sec(t("طريقة الاستلام"), choices("otype", [
    { value: "delivery", icon: "🛵", label: t("توصيل"), sub: zones.length ? t("حسب الحي") : num(s.delivery_fee) ? money(s.delivery_fee) : t("مجاني") },
    { value: "pickup", icon: "🏃", label: t("استلام من المحل"), sub: t("بدون رسوم") },
  ], st.type, (v) => { st.type = v; deliverySec.hidden = v !== "delivery"; renderBill(); }));

  function renderLines() {
    fill(linesBox, ...S.cart.map((l, idx) => h("div", { class: "cline cart-line" },
      l.img ? h("img", { src: l.img, alt: "" }) : h("div", { class: "ph", "aria-hidden": "true" }, "🍽️"),
      h("div", { class: "meta" },
        h("b", { text: l.name }),
        l.size ? h("small", { text: l.size.name }) : null,
        l.addons.length ? h("small", { text: `+ ${l.addons.map((a) => a.name).join(isEn() ? ", " : "، ")}` }) : null,
        l.note ? h("small", { text: `📝 ${l.note}` }) : null,
        h("div", { class: "lp price", text: money(lineUnit(l) * l.qty) })),
      stepper(l.qty, (v) => {
        if (v === 0) {
          S.cart.splice(idx, 1); saveCart(); refreshCta();
          if (!S.cart.length) return sheet.close();
          renderLines(); renderBill(); return;
        }
        l.qty = v; saveCart(); refreshCta(); renderBill(); renderLines();
      }, true, 0, () => { const p = S.products.find((x) => x.id === l.pid); return p ? Math.min(99, stockLeft(p, l.qty)) : 99; }))));
  }
  function renderBill() {
    const sub = cartSubtotal();
    const fee = deliveryFee();
    const disc = discountOf(sub);
    fill(billBox, bill([
      [t("مجموع الأصناف"), money(sub)],
      disc ? [t("الخصم ({c})", { c: st.coupon.code }), `-${money(disc)}`] : null,
      st.type === "delivery" ? [t("رسوم التوصيل"), zones.length && zoneSel.value === "" ? t("اختر الحي") : fee ? money(fee) : t("مجاناً")] : null,
      [t("الإجمالي"), money(Math.max(0, sub - disc) + fee), true],
    ]), st.type === "delivery" && minOrder && sub < minOrder
      ? h("div", { class: "min-warn", role: "status", text: t("الحد الأدنى لطلبات التوصيل {m} — أضف {r} للمتابعة", { m: money(minOrder), r: money(minOrder - sub) }) }) : null,
      st.coupon && sub < num(st.coupon.min_order) ? h("div", { class: "min-warn", text: t("الكود يتطلب طلباً بقيمة {m} أو أكثر", { m: money(st.coupon.min_order) }) }) : null);
  }

  let couponSec = null;
  if (s.has_coupons) {
    const code = h("input", { class: "input ltr", maxlength: "20", placeholder: t("كود الخصم"), "aria-label": t("كود الخصم"), style: { "text-transform": "uppercase" } });
    const msg = h("span", { class: "hint" });
    const btn = h("button", { class: "btn btn-soft", type: "button" }, t("تطبيق"));
    btn.addEventListener("click", async () => {
      if (st.coupon) { st.coupon = null; code.disabled = false; code.value = ""; btn.textContent = t("تطبيق"); msg.textContent = ""; return renderBill(); }
      const v = oneLine(code.value, 20).toUpperCase();
      if (v.length < 3) return toast(t("اكتب كود الخصم"), "error");
      btn.disabled = true;
      try {
        const r = await rpc(sb, "apply_coupon", { p_store_id: s.id, p_code: v, p_subtotal: cartSubtotal() });
        if (r.ok) {
          st.coupon = r; code.disabled = true; btn.textContent = t("إزالة");
          msg.textContent = t("✅ تم تطبيق الكود {c}", { c: r.code });
        } else {
          msg.textContent = r.error === "min_order" ? t("الكود يتطلب طلباً بقيمة {m} أو أكثر", { m: money(r.min_order) })
            : r.error === "expired" ? t("انتهت صلاحية الكود") : r.error === "rate_limited" ? t("محاولات كثيرة، انتظر قليلاً") : t("الكود غير صحيح");
        }
      } catch { msg.textContent = t("تعذر التحقق من الكود، حاول مجدداً"); }
      btn.disabled = false;
      renderBill();
    });
    couponSec = sec(t("كود الخصم"), h("div", { class: "row" }, h("div", { class: "grow" }, code), btn), msg);
  }

  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, t("إرسال الطلب عبر واتساب"));
  const sheet = openSheet({
    title: t("سلة الطلب"),
    className: "flow-sheet",
    body: [
      sec(h("div", { class: "row between", style: { width: "100%" } }, h("b", {}, t("طلبك من {n}", { n: s.name })),
        h("button", { class: "link-btn", type: "button", onClick: () => sheet.close() }, t("+ أضف أصناف"))), linesBox),
      typeSec, deliverySec,
      sec(t("بياناتك"), f.name.el, f.phone.el),
      paySec,
      couponSec,
      sec(null, notes.el),
      sec(t("ملخص الفاتورة"), billBox),
    ],
    foot: sendBtn,
  });
  renderLines();
  renderBill();
  bindCooldown(sendBtn, t("إرسال الطلب عبر واتساب"));

  sendBtn.addEventListener("click", async () => {
    if (!S.cart.length) return toast(t("السلة فارغة"), "error");
    const who = validateNamePhone(f);
    if (!who) return;
    const dist = zoneSel ? (zoneSel.value === "" ? "" : zones[Number(zoneSel.value)]?.name || "") : oneLine(district.input.value, 60);
    const addr = oneLine(address.input.value, 160);
    if (st.type === "delivery" && zoneSel && !dist) {
      zoneSel.classList.add("invalid"); zoneSel.focus();
      return toast(t("اختر الحي من القائمة"), "error");
    }
    if (st.type === "delivery" && minOrder && cartSubtotal() < minOrder) {
      return toast(t("الحد الأدنى لطلبات التوصيل {m}", { m: money(minOrder) }), "error");
    }
    if (st.type === "delivery" && !dist && !st.gps) {
      district.input.classList.add("invalid");
      district.input.focus();
      return toast(t("للتوصيل: اكتب اسم الحي أو حدّد موقعك عبر GPS"), "error");
    }
    saveCustomer({ name: who.name, phone: who.phone, district: dist, address: addr, order_type: st.type, pay: st.pay });

    const sub = cartSubtotal();
    const fee = deliveryFee();
    const disc = discountOf(sub);
    const coupon = disc ? st.coupon.code : null;
    const payLabel = { cash: "عند الاستلام (نقداً)", card: "عند الاستلام (شبكة / مدى)", transfer: "تحويل بنكي" }[st.pay];
    const note = multiLine(notes.input.value, 400);
    const items = S.cart.map((l) => ({ id: l.pid, n: l.name.slice(0, 60), s: l.size?.name || null, q: l.qty, t: lineUnit(l) * l.qty }));
    const total = Math.max(0, sub - disc) + fee;
    const meta = { mode: "order", name: who.name, phone: who.phone, type: st.type, district: dist, address: addr, gps: st.gps,
      pay: payLabel, note, coupon, discount: disc || null, fee };

    const ok = await submitToWhatsApp(sendBtn, total, items, (no) => buildOrderMessage(no, {
      ...who, type: st.type, district: dist, address: addr, gps: st.gps, note, sub, fee, payLabel, coupon, discount: disc,
    }), meta);
    if (ok) {
      ls.set(lastKey(), { at: Date.now(), lines: S.cart.map((l) => ({ ...l })) });
      S.cart = []; saveCart(); refreshCta(); sheet.close();
    }
  });
}

const SEP = "━━━━━━━━━━━━━━━━";
/** إطار الرسالة (يُعرض من اليمين لليسار داخل واتساب) */
const frameTop = (title) => `┐────── ${title} ──────┌`;
const FRAME_BOTTOM = "┘─────────────────────└";

function buildOrderMessage(no, d) {
  const L = [];
  L.push(frameTop("إشعار تأكيد الطلب 🛍️"));
  L.push(`رقم الطلب: *#ORD-${no}*`);
  L.push(`🏪 المتجر: ${S.store.name}`);
  L.push("");
  L.push("🔷 *المنتجات:*");
  S.cart.forEach((l) => {
    L.push(`• ${l.name}${l.size ? ` (${l.size.name})` : ""} ×${l.qty} — ${moneyText(lineUnit(l) * l.qty)}`);
    if (l.addons.length) L.push(`   ➕ الإضافات: ${l.addons.map((x) => `${x.name} (+${moneyText(x.price)})`).join("، ")}`);
    if (l.note) L.push(`   📝 ملاحظة: ${l.note}`);
  });
  L.push("");
  L.push(`👤 الاسم: ${d.name}`);
  if (d.type === "delivery") {
    const addr = [d.district, d.address].filter(Boolean).join(" — ");
    if (addr) L.push(`📍 العنوان: ${addr}`);
    if (d.gps) L.push(`🗺️ الموقع: ${d.gps}`);
  } else {
    L.push("📍 الاستلام: من المحل");
  }
  L.push(`📞 الجوال: ${d.phone}`);
  if (d.note) L.push(`📝 ملاحظات الطلب: ${d.note}`);
  L.push(SEP);
  L.push("💳 *تفاصيل الفاتورة:*");
  L.push(`• المنتجات: ${moneyText(d.sub)}`);
  if (d.discount) L.push(`• الخصم (${d.coupon}): -${moneyText(d.discount)}`);
  if (d.type === "delivery") L.push(`• التوصيل: ${d.fee ? moneyText(d.fee) : "مجاناً"}`);
  L.push(`• الإجمالي: *${moneyText(Math.max(0, d.sub - (d.discount || 0)) + d.fee)}*`);
  L.push(`• الدفع: ${d.payLabel}`);
  L.push(FRAME_BOTTOM);
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
    if (!btn.isConnected) return clearInterval(timer);
    const left = cooldownLeft();
    if (left > 0) { btn.disabled = true; btn.textContent = t("انتظر {n} ثانية قبل الإرسال مجدداً", { n: left }); }
    else if (btn.dataset.cd === "1") { btn.disabled = false; btn.textContent = label; }
    btn.dataset.cd = left > 0 ? "1" : "0";
  };
  const timer = setInterval(tick, 1000);
  tick();
}

async function submitToWhatsApp(btn, total, items, build, meta = null) {
  const st = openState(S.store, now());
  if (!st.open) {
    toast(closedText(st), "error");
    return false;
  }
  if (cooldownLeft() > 0) return false;
  const label = btn.textContent;
  btn.disabled = true;
  fill(btn, h("span", { class: "spinner", "aria-hidden": "true" }), t(" جاري التجهيز..."));

  let no;
  try {
    const r = await withTimeout(rpc(sb, "log_event", {
      p_store_id: S.store.id, p_event_type: "order_click", p_order_total: Math.round(total * 100) / 100, p_items: items, p_meta: meta,
    }), 3500);
    if (r?.ok === false) {
      btn.disabled = false; btn.textContent = label;
      toast(r.error === "rate_limited" ? t("طلبات كثيرة خلال وقت قصير، انتظر دقائق ثم حاول") : t("المتجر غير متاح حالياً"), "error");
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
    title: t("تم تجهيز طلبك ✅"),
    body: h("div", { class: "stack center", style: { "justify-items": "center", padding: "8px 0" } },
      h("img", { src: "/assets/img/order-success.svg", alt: "", style: { width: "190px" } }),
      h("b", { style: { "font-size": "20px" }, text: t("رقم الطلب #{n}", { n: no }) }),
      h("p", { class: "muted", style: { margin: "0" }, text: t("فتحنا لك واتساب برسالة جاهزة. اضغط «إرسال» داخل واتساب لإتمام العملية.") })),
    foot: h("a", { class: "btn btn-primary btn-lg btn-block", href: url, target: "_blank", rel: "noopener" }, t("فتح واتساب مرة أخرى")),
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
  const cta = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, mode === "booking" ? t("📅 احجز هذه الوحدة") : t("🏢 اطلب معاينة / استفسر"));
  const s = openSheet({
    title: p.name,
    className: "hero-sheet",
    body: [
      h("div", { class: `p-hero${imgs.length ? "" : " no-img"}` },
        imgs.length ? h("div", { class: "gallery", style: { height: "100%", display: "flex", "overflow-x": "auto", "scroll-snap-type": "x mandatory" } },
          imgs.map((u) => h("img", { src: u, alt: p.name, loading: "lazy", style: { flex: "none", width: "100%", "scroll-snap-align": "center" } }))) : null,
        imgs.length > 1 ? h("span", { class: "pill count", style: { top: "auto", bottom: "12px" } }, t("{n} صور ← اسحب", { n: imgs.length })) : null),
      h("div", { class: "stack", style: { gap: "6px" } },
        h("h2", { class: "p-title", text: p.name }),
        num(p.price) > 0 ? h("div", { class: "p-price" }, money(p.price), unit ? h("span", { class: "muted small" }, ` / ${t(unit)}`) : null) : null,
        p.description ? h("p", { class: "p-desc", text: p.description }) : null),
      specs.length ? optGroup(t("المواصفات"), null, null, specs.map((x) => h("div", { class: "opt-row", style: { cursor: "default" } },
        h("span", { class: "n muted", text: x.label }), h("b", { text: x.value })))) : null,
    ],
    foot: cta,
  });
  cta.addEventListener("click", () => { s.close(); mode === "booking" ? openBooking(p) : openInquiry(p); });
}

function itemSelect(selected, { allowGeneral, generalLabel }) {
  const avail = S.products.filter((p) => p.is_available);
  return h("select", { class: "select" },
    allowGeneral ? h("option", { value: "" }, generalLabel) : null,
    avail.map((p) => h("option", { value: p.id, selected: selected?.id === p.id }, p.name)));
}

const periodChoices = (name, set) => choices(name, [
  { value: "am", icon: "🌤️", label: t("صباحاً") }, { value: "pm", icon: "🌙", label: t("مساءً") }, { value: "any", icon: "🕒", label: t("أي وقت") },
], "any", set);

/* ---------------- تقويم التوفر ---------------- */
function monthLabel(y, m) {
  return new Date(Date.UTC(y, m, 1)).toLocaleDateString(isEn() ? "en-GB" : "ar-u-ca-gregory-nu-latn", { month: "long", year: "numeric", timeZone: "UTC" });
}
/** تقويم شهري: الأيام المحجوزة مشطوبة، والفترة المختارة مظللة */
function availCalendar({ min, getBlocked, getRange, onPick }) {
  const box = h("div", { class: "cal", role: "group", "aria-label": t("تقويم التوفر") });
  let [y, m] = min.split("-").map(Number); m -= 1;
  const draw = () => {
    const blocked = new Set(getBlocked());
    const [from, nights] = getRange();
    const sel = new Set(Array.from({ length: from ? nights : 0 }, (_, i) => addDays(from, i)));
    const first = new Date(Date.UTC(y, m, 1)).getUTCDay();
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(h("span", { class: "cal-blank" }));
    for (let d = 1; d <= days; d++) {
      const ymd = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const past = ymd < min, busy = blocked.has(ymd);
      const b = h("button", { type: "button", class: `cal-day${busy ? " busy" : ""}${sel.has(ymd) ? " sel" : ""}${sel.has(ymd) && busy ? " clash" : ""}`,
        disabled: past || busy, "aria-label": `${ymd}${busy ? " — " + t("محجوز") : ""}`, "aria-pressed": sel.has(ymd) ? "true" : "false" }, String(d));
      b.addEventListener("click", () => { onPick(ymd); draw(); });
      cells.push(b);
    }
    const canPrev = `${y}-${String(m + 1).padStart(2, "0")}` > min.slice(0, 7);
    fill(box,
      h("div", { class: "cal-head" },
        h("button", { type: "button", class: "rbtn", disabled: !canPrev, "aria-label": t("الشهر السابق"), onClick: () => { m -= 1; if (m < 0) { m = 11; y -= 1; } draw(); } }, isEn() ? "‹" : "›"),
        h("b", { text: monthLabel(y, m) }),
        h("button", { type: "button", class: "rbtn", "aria-label": t("الشهر التالي"), onClick: () => { m += 1; if (m > 11) { m = 0; y += 1; } draw(); } }, isEn() ? "›" : "‹")),
      h("div", { class: "cal-grid cal-wd" }, [0, 1, 2, 3, 4, 5, 6].map((d) => h("span", { text: dayShort(d) }))),
      h("div", { class: "cal-grid" }, cells),
      h("div", { class: "cal-legend" }, h("span", {}, h("i", { class: "lg sel" }), t("اختيارك")), h("span", {}, h("i", { class: "lg busy" }), t("محجوز"))));
  };
  draw();
  return { el: box, draw };
}

/* ---------------- الحجز ---------------- */
function openBooking(p) {
  const s = S.store;
  const c = customer();
  const today = tzParts(s.timezone, now()).ymd;
  const sel = itemSelect(p, { allowGeneral: false });
  const getItem = () => S.products.find((x) => x.id === sel.value) || p;
  const date = h("input", { class: "input", type: "date", min: today, value: today, hidden: true });
  let nights = 1;
  const blockedOf = () => getItem()?.options_json?.blocked_dates || [];
  const firstFree = () => { let d = today; const b = new Set(blockedOf()); for (let i = 0; i < 365 && b.has(d); i++) d = addDays(d, 1); return d; };
  date.value = firstFree();
  const clash = () => { const b = new Set(blockedOf()); return Array.from({ length: nights }, (_, i) => addDays(date.value, i)).some((d) => b.has(d)); };
  const dateLbl = h("b", { class: "sel-date" });
  const cal = availCalendar({ min: today, getBlocked: blockedOf, getRange: () => [date.value, nights], onPick: (d) => { date.value = d; update(); } });
  const f = nameAndPhone(c);
  const guests = textField(t("عدد الأشخاص (اختياري)"), { type: "number", inputmode: "numeric", min: "1", max: "500" });
  const notes = textField(t("ملاحظات (اختياري)"), { multiline: true, maxlength: "400" });
  const billBox = h("div");
  const unitLbl = h("b");

  function update() {
    const it = getItem();
    const unit = it?.options_json?.unit || "ليلة";
    unitLbl.textContent = t(unit === "ليلة" ? "عدد الليالي" : unit === "يوم" ? "عدد الأيام" : unit === "ساعة" ? "عدد الساعات" : "عدد الوحدات");
    const price = num(it?.price);
    const out = date.value ? addDays(date.value, nights) : "";
    dateLbl.textContent = date.value ? fmtDateAr(date.value) : "";
    cal.draw();
    fill(billBox, bill([
      [t("السعر / {u}", { u: t(unit) }), money(price)],
      date.value && (unit === "ليلة" || unit === "يوم") ? [t("تاريخ الخروج"), fmtDateAr(out)] : null,
      [t("الإجمالي"), money(price * nights), true],
    ]), clash() ? h("div", { class: "min-warn", text: t("بعض الأيام المختارة محجوزة، اختر تاريخاً آخر") }) : null);
  }
  sel.addEventListener("change", () => { date.value = firstFree(); update(); });
  date.addEventListener("change", update);

  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, t("إرسال طلب الحجز عبر واتساب"));
  const sheet = openSheet({
    title: t("طلب حجز"),
    className: "flow-sheet",
    body: [
      sec(t("تفاصيل الحجز"),
        h("label", { class: "field" }, h("span", { text: t("الوحدة") }), sel),
        h("div", { class: "field" }, h("span", { class: "label" }, t("تاريخ الدخول"), " ", dateLbl), date, cal.el),
        h("div", { class: "row between" }, unitLbl, stepper(1, (v) => { nights = Math.min(60, v); update(); }, true))),
      sec(t("بياناتك"), f.name.el, f.phone.el, guests.el, notes.el),
      sec(t("ملخص الحجز"), billBox),
    ],
    foot: sendBtn,
  });
  update();
  bindCooldown(sendBtn, t("إرسال طلب الحجز عبر واتساب"));

  sendBtn.addEventListener("click", async () => {
    const it = getItem();
    if (!it) return toast(t("اختر الوحدة"), "error");
    if (!date.value || date.value < today) { date.classList.add("invalid"); return toast(t("اختر تاريخ دخول صحيح"), "error"); }
    if (clash()) return toast(t("بعض الأيام المختارة محجوزة، اختر تاريخاً آخر"), "error");
    const who = validateNamePhone(f);
    if (!who) return;
    saveCustomer({ name: who.name, phone: who.phone });
    const unit = it.options_json?.unit || "ليلة";
    const total = num(it.price) * nights;
    const g = Math.floor(num(guests.input.value));
    const note = multiLine(notes.input.value, 400);
    const meta = { mode: "booking", name: who.name, phone: who.phone, date: `${date.value} +${nights} ${unit}`, note };
    const ok = await submitToWhatsApp(sendBtn, total, [{ id: it.id, n: it.name.slice(0, 60), q: nights, t: total }], (no) => {
      const L = [frameTop("إشعار طلب حجز 📅"), `رقم الطلب: *#BK-${no}*`, `🏪 ${s.name}`, "",
        "🔷 *تفاصيل الحجز:*", `• الوحدة: ${it.name}`, `• تاريخ الدخول: ${fmtDateMsg(date.value)}`, `• المدة: ${nights} ${unit}`];
      if (unit === "ليلة" || unit === "يوم") L.push(`• تاريخ الخروج: ${fmtDateMsg(addDays(date.value, nights))}`);
      if (g > 0) L.push(`• عدد الأشخاص: ${g}`);
      L.push("", `👤 الاسم: ${who.name}`, `📞 الجوال: ${who.phone}`);
      if (note) L.push(`📝 ملاحظات: ${note}`);
      L.push(SEP, "💳 *تفاصيل الفاتورة:*", `• السعر / ${unit}: ${moneyText(it.price)}`, `• الإجمالي: *${moneyText(total)}*`, FRAME_BOTTOM);
      return L.join("\n");
    }, meta);
    if (ok) sheet.close();
  });
}

/* ---------------- الاستفسار والمعاينة ---------------- */
function openInquiry(p) {
  const s = S.store;
  const c = customer();
  const today = tzParts(s.timezone, now()).ymd;
  const sel = itemSelect(p, { allowGeneral: true, generalLabel: t("استفسار عام") });
  let kind = "visit";
  const kindSeg = choices("ikind", [
    { value: "visit", icon: "👀", label: t("معاينة") }, { value: "ask", icon: "💬", label: t("استفسار") }, { value: "hold", icon: "📌", label: t("حجز مبدئي") },
  ], kind, (v) => { kind = v; });
  const date = h("input", { class: "input", type: "date", min: today });
  let period = "any";
  const f = nameAndPhone(c);
  const notes = textField(t("تفاصيل إضافية (اختياري)"), { multiline: true, maxlength: "500", placeholder: t("الميزانية، المتطلبات، أسئلتك...") });
  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, t("إرسال الطلب عبر واتساب"));

  const sheet = openSheet({
    title: t("طلب معاينة / استفسار"),
    className: "flow-sheet",
    body: [
      sec(t("العرض"), sel),
      sec(t("نوع الطلب"), kindSeg),
      sec(t("الموعد المفضل"), date, periodChoices("iperiod", (v) => { period = v; })),
      sec(t("بياناتك"), f.name.el, f.phone.el, notes.el),
    ],
    foot: sendBtn,
  });
  bindCooldown(sendBtn, t("إرسال الطلب عبر واتساب"));

  sendBtn.addEventListener("click", async () => {
    const who = validateNamePhone(f);
    if (!who) return;
    saveCustomer({ name: who.name, phone: who.phone });
    const it = S.products.find((x) => x.id === sel.value);
    const kindLabel = { visit: "معاينة على الطبيعة", ask: "استفسار", hold: "حجز مبدئي" }[kind];
    const periodLabel = { am: "صباحاً", pm: "مساءً", any: "أي وقت" }[period];
    const note = multiLine(notes.input.value, 500);
    const meta = { mode: "inquiry", name: who.name, phone: who.phone, kind: kindLabel, date: `${date.value || ""} ${periodLabel}`.trim(), note };
    const ok = await submitToWhatsApp(sendBtn, it ? num(it.price) : 0, it ? [{ n: it.name.slice(0, 60), q: 1, t: num(it.price) }] : [], (no) => {
      const L = [frameTop(`إشعار طلب ${kindLabel} 🏢`), `رقم الطلب: *#RQ-${no}*`, `🏪 ${s.name}`, "", "🔷 *العرض:*"];
      if (it) {
        L.push(`• ${it.name}`);
        if (num(it.price) > 0) L.push(`• السعر المعلن: ${moneyText(it.price)}${it.options_json?.unit ? " / " + it.options_json.unit : ""}`);
        for (const sp of (it.options_json?.specs || []).slice(0, 6)) L.push(`   ▫️ ${sp.label}: ${sp.value}`);
      } else L.push("• استفسار عام");
      L.push("", `📋 نوع الطلب: ${kindLabel}`, `🗓️ الموعد المفضل: ${date.value ? fmtDateMsg(date.value) + " — " : ""}${periodLabel}`,
        `👤 الاسم: ${who.name}`, `📞 الجوال: ${who.phone}`);
      if (note) L.push(`📝 تفاصيل: ${note}`);
      L.push(FRAME_BOTTOM);
      return L.join("\n");
    }, meta);
    if (ok) sheet.close();
  });
}

/* =========================================================
   وضع الجمعيات الخيرية
   ========================================================= */
function openDonation(p) {
  const s = S.store;
  const c = customer();
  const sel = itemSelect(p, { allowGeneral: true, generalLabel: t("تبرع عام") });
  let amount = 100;
  const custom = h("input", { class: "input", type: "number", inputmode: "decimal", min: "1", placeholder: t("اكتب المبلغ"), hidden: true });
  const amountsBox = h("div", { class: "amounts" });

  function renderAmounts() {
    const it = S.products.find((x) => x.id === sel.value);
    const opts = [50, 100, 500].map((v) => ({ v, label: String(v) }));
    if (it && num(it.price) > 0 && ![50, 100, 500].includes(num(it.price))) opts.unshift({ v: num(it.price), label: t("سهم {n}", { n: num(it.price) }) });
    opts.push({ v: "open", label: isEn() ? "Other" : "مفتوح" });
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

  const donor = textField(t("اسم المتبرع (اختياري)"), { value: c.name || "", maxlength: "60", placeholder: t("فاعل خير") });
  const phone = textField(t("رقم الجوال"), { type: "tel", inputmode: "tel", value: c.phone || "", maxlength: "20", placeholder: "05xxxxxxxx", dir: "ltr", style: { "text-align": "right" } });
  const sendBtn = h("button", { class: "btn btn-primary btn-lg btn-block", type: "button" }, t("إرسال إشعار التبرع عبر واتساب"));

  const sheet = openSheet({
    title: t("تبرع الآن"),
    className: "flow-sheet",
    body: [
      sec(t("المبادرة"), sel),
      sec(t("مبلغ التبرع ({c})", { c: CONFIG.CURRENCY }), amountsBox, custom),
      s.iban_number ? sec(t("حوّل المبلغ إلى الآيبان الرسمي"),
        h("div", { class: "iban-box" }, h("code", { text: s.iban_number }),
          h("button", { class: "btn btn-primary btn-sm", type: "button", onClick: () => copyText(s.iban_number, t("تم نسخ الآيبان ✅")) }, t("نسخ"))),
        h("span", { class: "hint", text: t("بعد التحويل أرسل الإشعار وأرفق صورة الإيصال في واتساب.") })) : null,
      sec(t("بيانات المتبرع"), donor.el, phone.el),
    ],
    foot: sendBtn,
  });
  renderAmounts();
  bindCooldown(sendBtn, t("إرسال إشعار التبرع عبر واتساب"));

  sendBtn.addEventListener("click", async () => {
    const value = amount === "open" ? num(custom.value) : num(amount);
    if (!(value >= 1 && value <= 10000000)) { custom.classList.add("invalid"); return toast(t("اكتب مبلغاً صحيحاً"), "error"); }
    if (!isValidPhone(phone.input.value)) { phone.input.classList.add("invalid"); return toast(t("رقم الجوال غير صحيح"), "error"); }
    const name = oneLine(donor.input.value, 60) || "فاعل خير";
    const ph = toLatinDigits(phone.input.value).replace(/[^\d+]/g, "");
    saveCustomer({ phone: ph, ...(name !== "فاعل خير" ? { name } : {}) });
    const it = S.products.find((x) => x.id === sel.value);
    const meta = { mode: "charity", name, phone: ph, kind: it?.name || "تبرع عام", pay: "تحويل بنكي" };
    const ok = await submitToWhatsApp(sendBtn, value, [{ n: (it?.name || "تبرع عام").slice(0, 60), q: 1, t: value }], (no) => [
      frameTop("إشعار تبرع 💚"), `رقم الإشعار: *#DN-${no}*`, `🏛️ ${s.name}`, "",
      "🔷 *التبرع:*", `• المبادرة: ${it?.name || "تبرع عام"}`, `• المبلغ: *${moneyText(value)}*`,
      `• الدفع: ${s.iban_number ? `تحويل بنكي إلى ${s.iban_number}` : "تحويل بنكي"}`, "",
      `👤 المتبرع: ${name}`, `📞 الجوال: ${ph}`, SEP,
      "📎 سأرفق صورة إيصال التحويل في هذه المحادثة.", "جزاكم الله خيراً 🤲", FRAME_BOTTOM,
    ].join("\n"), meta);
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
  const sel = itemSelect(p, { allowGeneral: true, generalLabel: t("غير محدد / أخرى") });
  let kind = "office";
  const kindSeg = choices("lkind", [
    { value: "office", icon: "🏢", label: t("حضورية") }, { value: "remote", icon: "💻", label: t("عن بُعد") }, { value: "contract", icon: "📄", label: t("صياغة عقد") },
  ], kind, (v) => { kind = v; });
  const brief = textField(t("نبذة مختصرة عن القضية / الطلب"), { multiline: true, maxlength: "600", placeholder: t("اكتب ملخصاً موجزاً دون تفاصيل حساسة...") }, t("لا تكتب بيانات سرية هنا؛ سيتم التواصل معك لاستكمال التفاصيل."));
  const date = h("input", { class: "input", type: "date", min: today });
  let period = "any";
  const f = nameAndPhone(c);
  const sendBtn = h("button", { class: "btn btn-accent btn-lg btn-block", type: "button" }, t("إرسال طلب الاستشارة عبر واتساب"));

  const sheet = openSheet({
    title: t("حجز استشارة"),
    className: "flow-sheet",
    body: [
      sec(t("التخصص"), sel),
      sec(t("نوع الاستشارة"), kindSeg),
      sec(null, brief.el),
      sec(t("الوقت المناسب"), date, periodChoices("lperiod", (v) => { period = v; })),
      sec(t("بياناتك"), f.name.el, f.phone.el),
    ],
    foot: sendBtn,
  });
  bindCooldown(sendBtn, t("إرسال طلب الاستشارة عبر واتساب"));

  sendBtn.addEventListener("click", async () => {
    const b = multiLine(brief.input.value, 600);
    if (b.length < 10) { brief.input.classList.add("invalid"); brief.input.focus(); return toast(t("اكتب نبذة مختصرة (10 أحرف على الأقل)"), "error"); }
    const who = validateNamePhone(f);
    if (!who) return;
    saveCustomer({ name: who.name, phone: who.phone });
    const it = S.products.find((x) => x.id === sel.value);
    const kindLabel = { office: "حضورية", remote: "عن بُعد", contract: "صياغة عقد" }[kind];
    const periodLabel = { am: "صباحاً", pm: "مساءً", any: "أي وقت" }[period];
    const fee = it ? num(it.price) : 0;
    const meta = { mode: "legal", name: who.name, phone: who.phone, kind: `${it?.name || "غير محدد"} — ${kindLabel}`, date: `${date.value || ""} ${periodLabel}`.trim(), note: b };
    const ok = await submitToWhatsApp(sendBtn, fee, it ? [{ n: it.name.slice(0, 60), q: 1, t: fee }] : [], (no) => {
      const L = [frameTop("إشعار طلب استشارة ⚖️"), `رقم الطلب: *#LG-${no}*`, `🏛️ ${s.name}`, "",
        "🔷 *الاستشارة:*", `• التخصص: ${it?.name || "غير محدد"}`, `• النوع: ${kindLabel}`,
        `• الوقت المناسب: ${date.value ? fmtDateMsg(date.value) + " — " : ""}${periodLabel}`, "",
        "📝 *نبذة مختصرة:*", b, "", `👤 الاسم: ${who.name}`, `📞 الجوال: ${who.phone}`];
      if (fee > 0) L.push(SEP, "💳 *تفاصيل الفاتورة:*", `• رسوم الاستشارة: *${moneyText(fee)}*`);
      L.push(FRAME_BOTTOM);
      return L.join("\n");
    }, meta);
    if (ok) sheet.close();
  });
}

/* =========================================================
   PWA: t("أضف للشاشة الرئيسية")
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
  const s = S.store;
  const bar = h("div", { class: "sf-install", role: "region", "aria-label": t("تثبيت التطبيق") },
    s.logo_url ? h("img", { class: "app-ico", src: s.logo_url, alt: "" }) : h("div", { class: "app-ico", "aria-hidden": "true" }, initials(s.name)),
    h("div", { class: "grow" }, h("b", { text: t("أضف للشاشة الرئيسية لطلب أسرع") }), h("span", { text: t("افتح المتجر كتطبيق بلمسة وحدة") })),
    h("button", { class: "btn btn-primary btn-sm", type: "button", onClick: install }, t("إضافة")),
    h("button", { class: "btn btn-ghost btn-sm", type: "button", "aria-label": t("إخفاء"),
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
    title: t("إضافة للشاشة الرئيسية"),
    body: h("ol", { class: "stack", style: { margin: "0", "padding-inline-start": "20px" } },
      h("li", {}, t("اضغط زر المشاركة "), h("b", {}, "⬆️"), t(" أسفل المتصفح (Safari).")),
      h("li", {}, t("اختر "), h("b", {}, t("«إضافة إلى الشاشة الرئيسية»")), "."),
      h("li", {}, t("اضغط "), h("b", {}, t("«إضافة»")), t(" — ستظهر أيقونة المتجر كتطبيق."))),
  });
}
