// دالة sign-upload — ملف واحد جاهز للصق في محرر Supabase (مولَّد من supabase/functions)
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
// يصدر رابط رفع موقّع لصورة واحدة بعد التحقق من جلسة التاجر.
// القيود الفعلية (JPEG/PNG/WebP و 2MB) مفروضة على مستوى الـ bucket نفسه.

const KINDS = new Set(["logo", "cover", "banner", "product", "gallery"]);
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  const body = await readJson(req, 4096);
  if (!body) return json(req, { error: "bad_request" }, 400);

  const storeId = await verifyMerchant(body.token);
  if (!storeId) return json(req, { error: "unauthorized" }, 401);

  const kind = String(body.kind ?? "");
  const contentType = String(body.content_type ?? "");
  if (!KINDS.has(kind) || !TYPES[contentType]) return json(req, { error: "invalid_type" }, 400);

  const sb = adminClient();
  const { data: allowed } = await sb.rpc("service_rate_limit", {
    p_bucket: "upload", p_key: storeId, p_max: 60, p_window_seconds: 3600,
  });
  if (!allowed) return json(req, { error: "rate_limited" }, 429);

  const path = `${storeId}/${kind}/${crypto.randomUUID()}.${TYPES[contentType]}`;
  const { data, error } = await sb.storage.from("media").createSignedUploadUrl(path);
  if (error || !data) return json(req, { error: "sign_failed" }, 500);

  const { data: pub } = sb.storage.from("media").getPublicUrl(path);
  return json(req, { path: data.path, token: data.token, public_url: pub.publicUrl });
});
