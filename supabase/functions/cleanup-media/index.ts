// تنظيف الصور غير المستخدمة من bucket "media"
// يحذف كل ملف لا يشير له أي متجر/صنف، أو يتبع متجراً محذوفاً، بشرط أن يكون أقدم من 24 ساعة
// (حتى لا نحذف صورة رُفعت للتو ولم تُحفظ بعد).
// الاستدعاء: POST مع الترويسة x-cleanup-secret = CLEANUP_SECRET   (?dry_run=1 للمعاينة فقط)
// الجدولة: انظر README (Supabase Cron).
import { adminClient, corsHeaders, json } from "../_shared/common.ts";

const SECRET = Deno.env.get("CLEANUP_SECRET") ?? "";
const GRACE_MS = 24 * 3600 * 1000;
const MARK = "/storage/v1/object/public/media/";

type Obj = { name: string; id: string | null; created_at?: string; updated_at?: string };

async function listAll(prefix: string): Promise<Obj[]> {
  const sb = adminClient();
  const out: Obj[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await sb.storage.from("media").list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw error;
    out.push(...(data as Obj[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (!SECRET || req.headers.get("x-cleanup-secret") !== SECRET) return json(req, { error: "unauthorized" }, 401);
  const dryRun = new URL(req.url).searchParams.get("dry_run") === "1";
  const sb = adminClient();

  const [{ data: refs, error: e1 }, { data: ids, error: e2 }] = await Promise.all([
    sb.rpc("service_media_refs"), sb.rpc("service_store_ids"),
  ]);
  if (e1 || e2) return json(req, { error: "rpc_failed" }, 500);
  const used = new Set((refs as string[]).filter((u) => u.includes(MARK)).map((u) => decodeURIComponent(u.split(MARK)[1].split("?")[0])));
  const stores = new Set(ids as string[]);
  const now = Date.now();

  const toDelete: string[] = [];
  let scanned = 0;
  for (const top of await listAll("")) {
    if (top.id) continue; // ملف في الجذر (غير متوقع) — نتجاهله
    const storeDeleted = !stores.has(top.name);
    for (const kind of await listAll(top.name)) {
      if (kind.id) continue;
      for (const f of await listAll(`${top.name}/${kind.name}`)) {
        if (!f.id) continue;
        scanned++;
        const path = `${top.name}/${kind.name}/${f.name}`;
        const age = now - new Date(f.created_at || f.updated_at || 0).getTime();
        if (age < GRACE_MS) continue;
        if (storeDeleted || !used.has(path)) toDelete.push(path);
      }
    }
  }

  let deleted = 0;
  if (!dryRun) {
    for (let i = 0; i < toDelete.length; i += 100) {
      const { error } = await sb.storage.from("media").remove(toDelete.slice(i, i + 100));
      if (error) return json(req, { error: "remove_failed", deleted }, 500);
      deleted += Math.min(100, toDelete.length - i);
    }
  }
  return json(req, { scanned, orphaned: toDelete.length, deleted, dry_run: dryRun });
});
