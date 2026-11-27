// دالة vision-menu — ملف واحد جاهز للصق في محرر Supabase (مولَّد من supabase/functions)
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
// استخراج أصناف المنيو من صورة عبر Claude (Vision) — في الخادم فقط.
// المفتاح ANTHROPIC_API_KEY لا يغادر الخادم. حد أقصى 5 صور يومياً لكل متجر.
import Anthropic from "npm:@anthropic-ai/sdk@^0.136.0";

const DAILY_LIMIT = 5;
const MAX_B64 = 2_900_000; // ≈ 2MB بعد فك الترميز
const MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);
const MODEL = Deno.env.get("VISION_MODEL") ?? "claude-opus-5-5";

const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY") });

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "name", "description", "price", "sizes"],
        properties: {
          category: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          price: { type: "number" },
          sizes: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "price"],
              properties: { name: { type: "string" }, price: { type: "number" } },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `أنت مساعد يستخرج بيانات المنيو من صور قوائم المطاعم والمتاجر العربية.
أعد كل صنف ظاهر في الصورة مع: القسم (category) كما هو مكتوب أو أقرب تصنيف منطقي، الاسم بالعربية كما في الصورة، وصف قصير إن وُجد وإلا نص فارغ، والسعر.
إذا كان للصنف عدة أحجام أو أنواع بأسعار مختلفة (صغير/وسط/كبير، حبة/نص/كامل...) فضعها في sizes واجعل price أقل سعر بينها.
الأسعار أرقام فقط (حوّل الأرقام العربية ٠-٩ إلى أرقام عادية، وتجاهل رمز العملة). إذا لم يظهر سعر ضع 0.
لا تخترع أصنافاً غير موجودة في الصورة.`;

type Item = { category: string; name: string; description: string; price: number; sizes: { name: string; price: number }[] };

function sanitize(items: unknown): Item[] {
  if (!Array.isArray(items)) return [];
  const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n < 10_000_000 ? Math.round(n * 100) / 100 : 0;
  };
  const str = (v: unknown, max: number) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  return items.slice(0, 200).map((it: any) => ({
    category: str(it?.category, 60),
    name: str(it?.name, 120),
    description: str(it?.description, 300),
    price: num(it?.price),
    sizes: Array.isArray(it?.sizes)
      ? it.sizes.slice(0, 20).map((s: any) => ({ name: str(s?.name, 40), price: num(s?.price) })).filter((s: any) => s.name)
      : [],
  })).filter((it) => it.name);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "method_not_allowed" }, 405);

  const body = await readJson(req, MAX_B64 + 4096);
  if (!body) return json(req, { error: "too_large_or_bad_request" }, 413);

  const storeId = await verifyMerchant(body.token);
  if (!storeId) return json(req, { error: "unauthorized" }, 401);

  const mediaType = String(body.media_type ?? "");
  const image = String(body.image_base64 ?? "");
  if (!MEDIA.has(mediaType) || !image || image.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(image)) {
    return json(req, { error: "invalid_image" }, 400);
  }

  const sb = adminClient();
  const { data: remaining, error: qErr } = await sb.rpc("service_consume_vision", {
    p_store_id: storeId, p_limit: DAILY_LIMIT,
  });
  if (qErr) return json(req, { error: "quota_error" }, 500);
  if (remaining === -1) return json(req, { error: "daily_limit", remaining: 0 }, 429);

  try {
    // Server-side refusal fallback مفعّل افتراضياً (fallbacks: "default")
    const params: Record<string, unknown> = {
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: "استخرج كل أصناف المنيو من هذه الصورة." },
        ],
      }],
    };
    // deno-lint-ignore no-explicit-any
    const msg: any = await anthropic.beta.messages.create(params as any);

    if (msg.stop_reason === "refusal") {
      await sb.rpc("service_refund_vision", { p_store_id: storeId });
      return json(req, { error: "refused" }, 422);
    }
    if (msg.stop_reason === "max_tokens") {
      // نعيد ما أمكن تحليله؛ غالباً منيو ضخم جداً
      console.warn("vision-menu: max_tokens reached");
    }
    const text = (msg.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { items: [] }; }

    return json(req, { items: sanitize(parsed.items), remaining });
  } catch (e) {
    await sb.rpc("service_refund_vision", { p_store_id: storeId });
    if (e instanceof Anthropic.RateLimitError) return json(req, { error: "ai_busy" }, 503);
    if (e instanceof Anthropic.APIError) {
      console.error("anthropic", e.status, e.message);
      return json(req, { error: "ai_error" }, 502);
    }
    console.error(e);
    return json(req, { error: "server_error" }, 500);
  }
});
