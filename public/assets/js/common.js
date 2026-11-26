// =========================================================
// أدوات مشتركة: بناء DOM آمن (بدون innerHTML)، تنسيق، صور، API
// =========================================================
import { CONFIG } from "./config.js";

/* ---------------- DOM آمن ---------------- */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster"]);

/** يقبل روابط https/blob/data:image/tel/mailto والروابط النسبية فقط */
export function safeUrl(u) {
  if (typeof u !== "string") return "";
  const v = u.trim();
  if (/^(https:|blob:|tel:|mailto:)/i.test(v)) return v;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(v)) return v;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(v)) return v;
  if (/^[/?#]/.test(v) && !v.startsWith("//")) return v;
  return "";
}

/**
 * h("div", {class: "x", onClick: fn}, "نص", child)
 * النصوص تُضاف دائماً كـ textContent، فلا مجال لحقن HTML.
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = String(v);
      else if (k === "style" && typeof v === "object") {
        for (const [sk, sv] of Object.entries(v)) el.style.setProperty(sk, sv);
      } else if (k === "dataset") Object.assign(el.dataset, v);
      else if (k.startsWith("on")) {
        if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (URL_ATTRS.has(k)) {
        const u = safeUrl(String(v));
        if (u) el.setAttribute(k, u);
      } else if (k === "value") el.value = v;
      else if (k === "checked" || k === "selected") el[k] = !!v;
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

/** بديل آمن لـ replaceChildren يتجاهل null/false (الأصلية تحولها لنص "null") */
export function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false)
    .map((c) => (c instanceof Node ? c : document.createTextNode(String(c)))));
  return el;
}

/* ---------------- اللغة (عربي / English) ---------------- */
export const I18N = { lang: "ar", dict: {} };

/** يترجم النص العربي (المفتاح هو النص العربي نفسه) مع دعم المتغيرات {name} */
export function t(ar, vars) {
  let s = I18N.lang === "en" ? (I18N.dict[ar] ?? ar) : ar;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return s;
}

export function setLang(lang) {
  I18N.lang = lang === "en" ? "en" : "ar";
  document.documentElement.lang = I18N.lang;
  document.documentElement.dir = I18N.lang === "en" ? "ltr" : "rtl";
  try { localStorage.setItem("lang", I18N.lang); } catch { /* ignore */ }
}

export function initLang(dict) {
  I18N.dict = dict || {};
  let saved = null;
  try { saved = localStorage.getItem("lang"); } catch { /* ignore */ }
  const urlLang = new URLSearchParams(location.search).get("lang");
  setLang(urlLang || saved || "ar");
}

export const isEn = () => I18N.lang === "en";

/* ---------------- نصوص وأرقام ---------------- */
export function toLatinDigits(s) {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}

/** سطر واحد نظيف بطول محدد */
export function oneLine(s, max = 120) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f‎‏‪-‮]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** نص متعدد الأسطر نظيف */
export function multiLine(s, max = 600) {
  return String(s ?? "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮]/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

export function num(v) {
  const n = Number(toLatinDigits(v));
  return Number.isFinite(n) ? n : 0;
}

function fmtAmount(n) {
  const v = Math.round(num(n) * 100) / 100;
  const s = Number.isInteger(v) ? String(v) : v.toFixed(2);
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** مبلغ للعرض في الواجهة برمز الريال الرسمي */
export function money(n) {
  return `${fmtAmount(n)}\u00A0${CONFIG.CURRENCY}`;
}

/** مبلغ لرسائل واتساب والنسخ: "25.00 ﷼" */
export function moneyText(n) {
  const v = (Math.round(num(n) * 100) / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${v} ${CONFIG.CURRENCY_TEXT}`;
}

/** توحيد رقم الجوال لصيغة دولية بدون + (يدعم 05xxxxxxxx السعودية) */
export function normalizePhone(p) {
  let v = toLatinDigits(p).replace(/\D/g, "");
  if (v.startsWith("00")) v = v.slice(2);
  if (/^05\d{8}$/.test(v)) v = "966" + v.slice(1);
  else if (/^5\d{8}$/.test(v)) v = "966" + v;
  return v;
}
export const isValidPhone = (p) => /^[1-9]\d{7,14}$/.test(normalizePhone(p));

export function waLink(phone, text) {
  return `https://wa.me/${normalizePhone(phone)}?text=${encodeURIComponent(text)}`;
}

export function initials(name) {
  return oneLine(name, 40).charAt(0) || "؟";
}

/* ---------------- تخزين محلي آمن ---------------- */
export const store = {
  get(k, fallback = null, session = false) {
    try {
      const raw = (session ? sessionStorage : localStorage).getItem(k);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(k, v, session = false) {
    try { (session ? sessionStorage : localStorage).setItem(k, JSON.stringify(v)); } catch { /* ignore */ }
  },
  del(k, session = false) {
    try { (session ? sessionStorage : localStorage).removeItem(k); } catch { /* ignore */ }
  },
};

/* ---------------- Toast ---------------- */
let toastWrap;
export function toast(msg, type = "") {
  if (!toastWrap) {
    toastWrap = h("div", { class: "toasts", role: "status", "aria-live": "polite" });
    document.body.append(toastWrap);
  }
  const t = h("div", { class: `toast ${type}` }, msg);
  while (toastWrap.children.length >= 2) toastWrap.firstElementChild.remove();
  toastWrap.append(t);
  setTimeout(() => t.remove(), type === "error" ? 4500 : 3000);
}

/* ---------------- النوافذ السفلية ---------------- */
export function openSheet({ title, body, foot, onClose, label, className = "" }) {
  const prevFocus = document.activeElement;
  const closeBtn = h("button", { class: "btn btn-ghost icon-btn", "aria-label": t("إغلاق"), type: "button" }, "✕");
  const sheet = h("div", { class: `sheet ${className}`.trim(), role: "dialog", "aria-modal": "true", "aria-label": label || title || "" },
    h("div", { class: "sheet-head" }, h("h3", { text: title || "" }), closeBtn),
    h("div", { class: "sheet-body" }, body),
    foot ? h("div", { class: "sheet-foot" }, foot) : null,
  );
  const backdrop = h("div", { class: "sheet-backdrop" }, sheet);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (!document.querySelector(".sheet-backdrop")) document.body.style.removeProperty("overflow");
    onClose?.();
    prevFocus?.focus?.();
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
  document.body.style.setProperty("overflow", "hidden");
  document.body.append(backdrop);
  setTimeout(() => closeBtn.focus(), 30);
  return { close, sheet, body: sheet.querySelector(".sheet-body"), foot: sheet.querySelector(".sheet-foot") };
}

export function confirmDialog(message, { okText = t("تأكيد"), danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const ok = h("button", { class: `btn ${danger ? "btn-danger" : "btn-primary"} btn-block`, type: "button" }, okText);
    const cancel = h("button", { class: "btn btn-block", type: "button" }, t("إلغاء"));
    const s = openSheet({
      title: t("تأكيد"), body: h("p", { text: message, style: { margin: "0" } }),
      foot: [ok, cancel], onClose: () => { if (!answered) resolve(false); },
    });
    ok.onclick = () => { answered = true; s.close(); resolve(true); };
    cancel.onclick = () => { answered = true; s.close(); resolve(false); };
  });
}

export async function copyText(text, okMsg = t("تم النسخ ✅")) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h("textarea", { value: text, style: { position: "fixed", opacity: "0" } });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  toast(okMsg, "success");
}

/* ---------------- القوالب والأوضاع ---------------- */
export const THEMES = [
  { id: "theme-restaurant", label: "مطعم", primary: "#ea580c", bg: "#fff7ed" },
  { id: "theme-cafe", label: "كافيه", primary: "#b45309", bg: "#181512" },
  { id: "theme-pharmacy", label: "صيدلية", primary: "#059669", bg: "#f0fdf4" },
  { id: "theme-store", label: "متجر / بقالة", primary: "#2563eb", bg: "#f8fafc" },
  { id: "theme-service", label: "مغسلة / خدمات", primary: "#0284c7", bg: "#f0f9ff" },
  { id: "theme-chalet", label: "شاليه / استراحة", primary: "#0f766e", bg: "#f0fdfa" },
  { id: "theme-realestate", label: "عقار", primary: "#1e3a8a", bg: "#f8fafc" },
  { id: "theme-bakery", label: "أسر منتجة / حلويات", primary: "#be185d", bg: "#fdf2f8" },
  { id: "theme-charity", label: "جمعية خيرية", primary: "#0d9488", bg: "#f0fdfa" },
  { id: "theme-legal", label: "محاماة / استشارات", primary: "#1e293b", bg: "#b45309" },
  { id: "theme-general", label: "عام", primary: "#18181b", bg: "#fafafa" },
];
export const themeById = (id) => THEMES.find((t) => t.id === id) || THEMES[THEMES.length - 1];

export const MODES = {
  order: { label: "طلبات", items: "الأصناف", item: "صنف", icon: "🛒" },
  booking: { label: "حجوزات", items: "الوحدات", item: "وحدة", icon: "📅" },
  inquiry: { label: "استفسار ومعاينة", items: "العروض", item: "عرض", icon: "🏢" },
  charity: { label: "تبرعات", items: "المبادرات", item: "مبادرة", icon: "💚" },
  legal: { label: "استشارات قانونية", items: "التخصصات", item: "تخصص", icon: "⚖️" },
};

export function applyTheme(s, target = document.body) {
  for (const t of THEMES) target.classList.remove(t.id);
  target.classList.add(themeById(s?.theme_style).id);
  if (s?.custom_primary_color && /^#[0-9a-f]{6}$/i.test(s.custom_primary_color)) {
    target.style.setProperty("--primary", s.custom_primary_color);
  } else {
    target.style.removeProperty("--primary");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", s?.custom_primary_color || themeById(s?.theme_style).primary);
}

/* ---------------- الوقت وأوقات العمل ---------------- */
export function tzParts(tz, date = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz || "Asia/Riyadh", hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).formatToParts(date);
  } catch {
    return tzParts("Asia/Riyadh", date);
  }
  const g = (t) => parts.find((p) => p.type === t)?.value;
  const hour = Number(g("hour")) % 24;
  return { y: g("year"), mo: g("month"), d: g("day"), hour, minute: Number(g("minute")),
           ymd: `${g("year")}-${g("month")}-${g("day")}` };
}

const toMin = (t) => { const [hh, mm] = String(t).split(":").map(Number); return hh * 60 + (mm || 0); };

/** يدعم الدوام الممتد بعد منتصف الليل (مثل 4:00م → 2:00ص) */
export function openState(s, now = new Date()) {
  if (!s) return { open: false };
  if (!s.is_open) return { open: false, manual: true };
  if (!s.open_time || !s.close_time) return { open: true, allDay: true };
  const p = tzParts(s.timezone, now);
  const cur = p.hour * 60 + p.minute;
  const o = toMin(s.open_time), c = toMin(s.close_time);
  if (o === c) return { open: true, allDay: true };
  const open = o < c ? cur >= o && cur < c : cur >= o || cur < c;
  return { open, opensAt: s.open_time, closesAt: s.close_time };
}

export function fmtTime12(t) {
  if (!t) return "";
  const [hh, mm] = String(t).split(":").map(Number);
  if (hh === 0 && mm === 0) return I18N.lang === "en" ? "12:00 AM" : "12:00 منتصف الليل";
  const suffix = I18N.lang === "en" ? (hh < 12 ? "AM" : "PM") : (hh < 12 ? "ص" : "م");
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${suffix}`;
}

/** تاريخ عربي دائماً (لرسائل واتساب الموجهة للتاجر) */
export function fmtDateMsg(ymd) {
  try {
    return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("ar-u-ca-gregory-nu-latn", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  } catch { return ymd; }
}

export function fmtDateAr(ymd) {
  try {
    const d = new Date(`${ymd}T12:00:00Z`);
    return d.toLocaleDateString(I18N.lang === "en" ? "en-GB" : "ar-u-ca-gregory-nu-latn", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  } catch { return ymd; }
}

export function addDays(ymd, n) {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysLeft(iso) {
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

/* ---------------- ضغط الصور في المتصفح ---------------- */
let webpOk;
function canWebp() {
  if (webpOk === undefined) {
    try { webpOk = document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp"); }
    catch { webpOk = false; }
  }
  return webpOk;
}

async function loadBitmap(file) {
  if ("createImageBitmap" in window) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* fallback */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("تعذر قراءة الصورة")); };
    img.src = url;
  });
}

const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

/**
 * يضغط الصورة قبل الرفع: تصغير الأبعاد + WebP (أو JPEG) + ضمان الحجم < maxBytes
 * square=true يقص الصورة مربعاً (للشعار وأيقونة التطبيق)
 */
export async function compressImage(file, { maxSize = 1280, square = false, quality = 0.82,
  maxBytes = 1.8 * 1024 * 1024, forceJpeg = false } = {}) {
  if (!file || !String(file.type).startsWith("image/")) throw new Error("الملف المختار ليس صورة");
  if (file.size > 30 * 1024 * 1024) throw new Error("الصورة كبيرة جداً");
  const bmp = await loadBitmap(file);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
  }
  const type = !forceJpeg && canWebp() ? "image/webp" : "image/jpeg";
  let scale = Math.min(1, maxSize / Math.max(sw, sh));
  for (let attempt = 0; attempt < 6; attempt++) {
    const w = Math.max(1, Math.round(sw * scale)), hh = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = hh;
    const ctx = canvas.getContext("2d");
    if (type === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, hh); }
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, hh);
    for (let q = quality; q >= 0.5; q -= 0.12) {
      const blob = await toBlob(canvas, type, q);
      if (blob && blob.size <= maxBytes) return blob;
    }
    scale *= 0.75;
  }
  throw new Error("تعذر ضغط الصورة إلى أقل من 2MB");
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export function pickFile(accept = "image/*") {
  return new Promise((resolve) => {
    const inp = h("input", { type: "file", accept, style: { display: "none" } });
    inp.addEventListener("change", () => { resolve(inp.files?.[0] || null); inp.remove(); });
    document.body.append(inp);
    inp.click();
  });
}

/* ---------------- Supabase ---------------- */
export function createSb({ persist = false } = {}) {
  if (!window.supabase?.createClient) throw new Error("supabase-js not loaded");
  return window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: { persistSession: persist, autoRefreshToken: persist, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
}

const ERRORS = {
  unauthorized: "انتهت الجلسة، الرجاء تسجيل الدخول مجدداً",
  forbidden: "ليست لديك صلاحية لهذا الإجراء",
  invalid_phone: "رقم الجوال غير صحيح",
  invalid_iban: "رقم الآيبان غير صحيح (مثال: SA0000000000000000000000)",
  invalid_name: "الاسم مطلوب",
  invalid_fee: "رسوم التوصيل غير صحيحة",
  invalid_price: "السعر غير صحيح",
  invalid_pin: "رمز PIN يجب أن يكون من 4 إلى 8 أرقام",
  invalid_days: "مدة غير صحيحة",
  slug_taken: "هذا الرابط مستخدم لمتجر آخر",
  limit_reached: "وصلت للحد الأقصى لعدد العناصر (500)",
  not_found: "العنصر غير موجود",
  rate_limited: "محاولات كثيرة، انتظر قليلاً ثم حاول مجدداً",
  daily_limit: "استهلكت الحد اليومي (5 صور). جرّب غداً",
  invalid_image: "الصورة غير صالحة",
  too_large_or_bad_request: "الصورة كبيرة جداً",
  ai_busy: "خدمة التحليل مشغولة، حاول بعد دقيقة",
  ai_error: "تعذر تحليل الصورة، حاول مجدداً",
  refused: "تعذر تحليل هذه الصورة",
};

export function friendlyError(e) {
  const m = String(e?.message || e?.error || e || "");
  for (const k of Object.keys(ERRORS)) if (m.includes(k)) return ERRORS[k];
  if (/check constraint|violates/i.test(m)) return "إحدى القيم المدخلة غير صالحة";
  if (/fetch|network|Failed/i.test(m)) return "تعذر الاتصال، تحقق من الإنترنت";
  return "حدث خطأ غير متوقع";
}

export async function rpc(sb, fn, args) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    const err = new Error(error.message || "rpc_error");
    err.code = error.code;
    throw err;
  }
  return data;
}

export async function callFunction(name, body) {
  const headers = { "Content-Type": "application/json", apikey: CONFIG.SUPABASE_ANON_KEY };
  if (CONFIG.SUPABASE_ANON_KEY.startsWith("eyJ")) headers.Authorization = `Bearer ${CONFIG.SUPABASE_ANON_KEY}`;
  const res = await fetch(`${CONFIG.SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(data?.error || `http_${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/** رفع صورة عبر رابط موقّع تصدره Edge Function بعد التحقق من جلسة التاجر */
export async function uploadImage(sb, token, kind, blob) {
  const signed = await callFunction("sign-upload", { token, kind, content_type: blob.type });
  const { error } = await sb.storage.from("media").uploadToSignedUrl(signed.path, signed.token, blob, {
    contentType: blob.type, cacheControl: "31536000",
  });
  if (error) throw new Error(error.message);
  return signed.public_url;
}

export function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function getStoreSlug() {
  const s = new URLSearchParams(location.search).get("store") || "";
  return /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(s.toLowerCase()) ? s.toLowerCase() : "";
}

export function appBase() {
  return location.origin;
}
