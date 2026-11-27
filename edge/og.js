// =========================================================
// معاينة الروابط (Open Graph) لكل متجر
// عند مشاركة domain.com/?store=slug في واتساب/تويتر/تيليجرام، يقرأ "الزاحف"
// صفحة صغيرة فيها اسم المتجر ووصفه وصورته. الزوار العاديون لا يتأثرون.
// يُستخدم من: middleware.js (Vercel) و netlify/edge-functions/og.js (Netlify)
// =========================================================

export const BOT_UA = /bot|crawler|spider|preview|facebookexternalhit|whatsapp|telegram|twitter|slack|discord|linkedin|pinterest|skype|embedly|vkshare|applebot|googlebot|bingbot|redditbot|snapchat|quora|tumblr/i;
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const httpsOnly = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : "");

const MODE_DESC = {
  order: "اطلب الآن عبر واتساب 🛵",
  booking: "احجز الآن عبر واتساب 📅",
  inquiry: "اطلب معاينة أو استفسر عبر واتساب 🏢",
  charity: "تبرع الآن 💚",
  legal: "احجز استشارتك عبر واتساب ⚖️",
};

/** يرجع Response للزواحف فقط، أو null لتكمل الطلب كالمعتاد */
export async function ogResponse(request, { supabaseUrl, anonKey, fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get("store") || "").toLowerCase();
  const ua = request.headers.get("user-agent") || "";
  if (!slug || !SLUG.test(slug) || !BOT_UA.test(ua) || !supabaseUrl || !anonKey) return null;

  let store = null;
  try {
    const headers = { "Content-Type": "application/json", apikey: anonKey };
    if (anonKey.startsWith("eyJ")) headers.Authorization = `Bearer ${anonKey}`;
    const res = await fetchImpl(`${supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/get_store_public`, {
      method: "POST", headers, body: JSON.stringify({ p_slug: slug }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.status === "ok") store = data.store;
    }
  } catch { /* نكمل بالصفحة العادية */ }
  if (!store) return null;

  const pageUrl = `${url.origin}/?store=${slug}`;
  const title = store.name;
  const desc = [store.business_type, store.banner_active && store.banner_text, MODE_DESC[store.business_mode] || MODE_DESC.order]
    .filter(Boolean).join(" • ");
  const image = httpsOnly(store.cover_url) || httpsOnly(store.logo_url) || `${url.origin}/assets/icons/icon-512.png`;

  const html = `<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(title)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(pageUrl)}">
<meta property="og:locale" content="ar_SA">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="canonical" href="${esc(pageUrl)}">
</head><body><a href="${esc(pageUrl)}">${esc(title)}</a></body></html>`;

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=600", "Vary": "User-Agent" },
  });
}
