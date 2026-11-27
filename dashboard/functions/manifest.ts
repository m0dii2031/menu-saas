// دالة manifest — ملف واحد جاهز للصق في محرر Supabase (مولَّد من supabase/functions)
// ======== الأدوات المشتركة ========
// أدوات مشتركة بين Edge Functions
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

const APP_URL = (Deno.env.get("APP_URL") ?? "").replace(/\/+$/, "");

export function appUrl(): string {
  return APP_URL;
}

export function corsHeaders(req: Request): Record<string, string> {
  // إذا تم ضبط APP_URL نقصر CORS على نطاق التطبيق فقط
  const origin = req.headers.get("origin") ?? "";
  let allow = "*";
  if (APP_URL) {
    const appOrigin = new URL(APP_URL).origin;
    allow = origin === appOrigin ? origin : appOrigin;
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", ...extra },
  });
}

let _admin: SupabaseClient | null = null;
export function adminClient(): SupabaseClient {
  if (!_admin) {
    _admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _admin;
}

/** يتحقق من رمز جلسة التاجر عبر RPC ويرجع store_id أو null */
export async function verifyMerchant(token: unknown): Promise<string | null> {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
  const { data, error } = await adminClient().rpc("service_verify_merchant", { p_token: token });
  if (error || !data) return null;
  return data as string;
}

export async function readJson(req: Request, maxBytes: number): Promise<Record<string, unknown> | null> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > maxBytes) return null;
  const text = await req.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// ======== الدالة ========
// Manifest ديناميكي لكل متجر (اسم المتجر + شعاره + لونه) لتثبيته كتطبيق PWA

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
