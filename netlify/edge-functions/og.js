// Netlify Edge Function: معاينة روابط المتاجر للزواحف (واتساب وغيره)
// يحتاج متغيرات البيئة في Netlify: SUPABASE_URL و SUPABASE_ANON_KEY
import { ogResponse } from "../../edge/og.js";

export default async (request, context) => {
  const res = await ogResponse(request, {
    supabaseUrl: Netlify.env.get("SUPABASE_URL"),
    anonKey: Netlify.env.get("SUPABASE_ANON_KEY"),
  });
  return res || context.next();
};

export const config = { path: "/" };
