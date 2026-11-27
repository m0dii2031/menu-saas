// ⚙️ عدّل هذه القيم ببيانات مشروع Supabase الخاص بك
// (Project Settings → API). مفتاح anon/publishable آمن للواجهة لأن
// الحماية الفعلية مفروضة عبر RLS ودوال RPC في قاعدة البيانات.
export const CONFIG = {
  SUPABASE_URL: "https://yvklaenqiosnowfvfprp.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_qmYQ4eVKnJCj01bg9ADb8g_jRtR1_yS",
  // رمز الريال السعودي الرسمي (U+20C1) — يُعرض عبر خط مستضاف داخل المنصة
  CURRENCY: "\u20C1",
  // رمز العملة في رسائل واتساب: ﷼ (U+FDFC) يعرضه واتساب على كل الأجهزة
  CURRENCY_TEXT: "\uFDFC",
  ORDER_COOLDOWN_SECONDS: 30,
};
