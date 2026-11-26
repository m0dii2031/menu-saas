// Manifest ديناميكي لكل متجر (اسم المتجر + شعاره + لونه) لتثبيته كتطبيق PWA
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { appUrl, corsHeaders } from "../_shared/common.ts";

const THEME_COLORS: Record<string, [string, string]> = {
  "theme-restaurant": ["#ea580c", "#ffffff"],
  "theme-cafe": ["#c2741f", "#100d0b"],
  "theme-pharmacy": ["#059669", "#ffffff"],
  "theme-store": ["#2563eb", "#ffffff"],
  "theme-service": ["#0284c7", "#ffffff"],
  "theme-chalet": ["#0f766e", "#ffffff"],
  "theme-realestate": ["#1e3a8a", "#ffffff"],
  "theme-bakery": ["#be185d", "#ffffff"],
  "theme-charity": ["#0d9488", "#ffffff"],
  "theme-legal": ["#1e293b", "#ffffff"],
  "theme-general": ["#18181b", "#ffffff"],
};

const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
  auth: { persistSession: false },
});

function iconType(url: string): string {
  if (/\.png(\?|$)/i.test(url)) return "image/png";
  if (/\.jpe?g(\?|$)/i.test(url)) return "image/jpeg";
  return "image/webp";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  const base = appUrl();
  const slug = (new URL(req.url).searchParams.get("store") ?? "").toLowerCase();
  if (!base || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(slug)) {
    return new Response("bad request", { status: 400, headers: corsHeaders(req) });
  }

  const { data } = await anon.rpc("get_store_public", { p_slug: slug });
  const store = data?.store ?? {};
  const [primary, bg] = THEME_COLORS[store.theme_style] ?? THEME_COLORS["theme-general"];
  const name: string = store.name ?? "المنيو";
  const logo: string | null = typeof store.logo_url === "string" && store.logo_url.startsWith("https://") ? store.logo_url : null;

  const icons = logo
    ? [
      { src: logo, sizes: "512x512", type: iconType(logo), purpose: "any" },
      { src: logo, sizes: "192x192", type: iconType(logo), purpose: "any" },
    ]
    : [
      { src: `${base}/assets/icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `${base}/assets/icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ];

  const manifest = {
    id: `/?store=${slug}`,
    name,
    short_name: name.length > 12 ? name.slice(0, 12) : name,
    description: `اطلب من ${name} مباشرة`,
    lang: "ar",
    dir: "rtl",
    start_url: `${base}/?store=${slug}&source=pwa`,
    scope: `${base}/`,
    display: "standalone",
    orientation: "portrait",
    theme_color: store.custom_primary_color ?? primary,
    background_color: bg,
    icons,
  };

  return new Response(JSON.stringify(manifest), {
    headers: {
      ...corsHeaders(req),
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});
