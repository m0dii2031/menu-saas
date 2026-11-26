// يصدر رابط رفع موقّع لصورة واحدة بعد التحقق من جلسة التاجر.
// القيود الفعلية (JPEG/PNG/WebP و 2MB) مفروضة على مستوى الـ bucket نفسه.
import { adminClient, corsHeaders, json, readJson, verifyMerchant } from "../_shared/common.ts";

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
