// ⚙️ عدّل هذه القيم ببيانات مشروع Supabase الخاص بك
// (Project Settings → API). مفتاح anon/publishable آمن للواجهة لأن
// الحماية الفعلية مفروضة عبر RLS ودوال RPC في قاعدة البيانات.
export const CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-OR-PUBLISHABLE-KEY",
  // رمز الريال السعودي الرسمي (U+20C1) — يُعرض عبر خط مستضاف داخل المنصة
  CURRENCY: "\u20C1",
  // نص العملة في رسائل واتساب (قد لا يعرض واتساب الرمز الجديد على كل الأجهزة)
  CURRENCY_TEXT: "ريال",
  ORDER_COOLDOWN_SECONDS: 30,
};
