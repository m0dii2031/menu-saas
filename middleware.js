// Vercel Routing Middleware: معاينة روابط المتاجر للزواحف (واتساب وغيره)
// يحتاج متغيرات البيئة في Vercel: SUPABASE_URL و SUPABASE_ANON_KEY
import { ogResponse } from "./edge/og.js";

export const config = { matcher: ["/"] };

export default async function middleware(request) {
  const res = await ogResponse(request, {
    supabaseUrl: process.env.SUPABASE_URL,
    anonKey: process.env.SUPABASE_ANON_KEY,
  });
  return res || undefined; // undefined = أكمل للصفحة العادية
}
