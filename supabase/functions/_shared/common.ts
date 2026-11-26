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
