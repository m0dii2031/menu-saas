#!/usr/bin/env bash
# =========================================================
# نشر المنصة على Supabase بأمر واحد
#
# الاستخدام:
#   export SUPABASE_PROJECT_REF=abcdefghijklmnop      # من رابط مشروعك
#   export SUPABASE_ANON_KEY=eyJ...  (أو sb_publishable_...)
#   export APP_URL=https://menu.example.com           # نطاق الواجهة بدون / في النهاية
#   export ANTHROPIC_API_KEY=sk-ant-...               # لميزة "منيو من صورة"
#   ./scripts/deploy.sh
#
# يتطلب: Supabase CLI (npm i -g supabase) وتسجيل الدخول: supabase login
# =========================================================
set -euo pipefail
cd "$(dirname "$0")/.."

: "${SUPABASE_PROJECT_REF:?اضبط SUPABASE_PROJECT_REF}"
: "${SUPABASE_ANON_KEY:?اضبط SUPABASE_ANON_KEY}"
: "${APP_URL:?اضبط APP_URL}"
: "${ANTHROPIC_API_KEY:?اضبط ANTHROPIC_API_KEY}"
command -v supabase >/dev/null || { echo "ثبّت Supabase CLI أولاً: npm i -g supabase"; exit 1; }

SUPABASE_URL="https://${SUPABASE_PROJECT_REF}.supabase.co"
CLEANUP_SECRET="${CLEANUP_SECRET:-$(openssl rand -hex 24)}"

echo "1) ربط المشروع..."
supabase link --project-ref "$SUPABASE_PROJECT_REF"

echo "2) ترحيل قاعدة البيانات (الجداول + RLS + الدوال + Storage)..."
supabase db push

echo "3) نشر Edge Functions..."
for fn in sign-upload vision-menu manifest cleanup-media; do
  supabase functions deploy "$fn" --no-verify-jwt
done

echo "4) ضبط الأسرار..."
supabase secrets set APP_URL="${APP_URL%/}" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" CLEANUP_SECRET="$CLEANUP_SECRET"

echo "5) تحديث إعدادات الواجهة (public/assets/js/config.js)..."
sed -i.bak \
  -e "s#SUPABASE_URL: \".*\"#SUPABASE_URL: \"${SUPABASE_URL}\"#" \
  -e "s#SUPABASE_ANON_KEY: \".*\"#SUPABASE_ANON_KEY: \"${SUPABASE_ANON_KEY}\"#" \
  public/assets/js/config.js && rm -f public/assets/js/config.js.bak

cat <<EOF

✅ تم النشر.

الخطوات المتبقية:
  • ارفع مجلد public/ على Vercel أو Netlify، وأضف هناك متغيري البيئة
    SUPABASE_URL=${SUPABASE_URL}
    SUPABASE_ANON_KEY=<نفس المفتاح>
    (لمعاينة روابط المتاجر في واتساب)
  • أنشئ حساب المدير من Authentication > Users ثم نفّذ في SQL Editor:
      insert into private.admins (user_id) select id from auth.users where email = 'you@example.com';
  • جدولة تنظيف الصور اليومي: نفّذ supabase/cron.sql بعد وضع:
      PROJECT_REF = ${SUPABASE_PROJECT_REF}
      CLEANUP_SECRET = ${CLEANUP_SECRET}
EOF
