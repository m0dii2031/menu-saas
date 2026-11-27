#!/usr/bin/env bash
# =====================================================================
# نشر كامل على Supabase من GitHub Actions (بدون أي خطوة يدوية):
#   يجد مشروع "menu-saas" أو ينشئه (فرانكفورت) ← يرحّل قاعدة البيانات ← ينشر الدوال الأربع
#   ← يضبط الأسرار وإعدادات الدخول ← يجدول تنظيف الصور ← يجعل ADMIN_EMAIL مديراً
# المتغيرات: SUPABASE_ACCESS_TOKEN (إلزامي) • APP_URL • ADMIN_EMAIL • ANTHROPIC_API_KEY • PROJECT_NAME
# المخرجات (GITHUB_OUTPUT): supabase_url, anon_key, project_ref
# المستودع عام: لا نطبع أي سر، ونخفي كل قيمة حساسة بـ ::add-mask::
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

API="${SUPABASE_API:-https://api.supabase.com/v1}"
NAME="${PROJECT_NAME:-menu-saas}"
REGION="${SUPABASE_REGION:-eu-central-1}"
OUT="${GITHUB_OUTPUT:-/dev/null}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN missing}"
mask() { [ -n "${1:-}" ] && echo "::add-mask::$1" || true; }
[ -n "${ADMIN_EMAIL:-}" ] && mask "$ADMIN_EMAIL"

# curl للـ Management API: يطبع الجسم، ويفشل برسالة واضحة عند الخطأ
api() {
  local method=$1 path=$2 body=${3:-} code tmp; tmp=$(mktemp)
  if [ -n "$body" ]; then
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H 'Content-Type: application/json' --data-binary @"$body")
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$API$path" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN")
  fi
  if [ "$code" -ge 300 ]; then echo "::error::$method $path → HTTP $code: $(head -c 400 "$tmp")" >&2; rm -f "$tmp"; return 1; fi
  cat "$tmp"; rm -f "$tmp"
}
run_sql() {  # $1 = ملف SQL، $2 = عدد المحاولات (افتراضي 6)
  local body i; body=$(mktemp); jq -Rs '{query: .}' "$1" > "$body"
  for i in $(seq 1 "${2:-6}"); do
    if api POST "/projects/$REF/database/query" "$body" >/dev/null; then rm -f "$body"; return 0; fi
    echo "  retry $i…"; sleep 15
  done
  rm -f "$body"; return 1
}

echo "::group::1) المشروع"
REF=$(api GET /projects | jq -r --arg n "$NAME" '[.[] | select(.name == $n)][0].id // empty')
if [ -z "$REF" ]; then
  ORGS=$(api GET /organizations)
  ORG=$(echo "$ORGS" | jq -r --arg n "$NAME" '([.[] | select(.name == $n)][0] // .[0]) | (.id // .slug // empty)')
  [ -n "$ORG" ] || { echo "::error::لا توجد منظمة في حساب Supabase — أنشئ واحدة من supabase.com/dashboard/new"; exit 1; }
  DBPASS=$(openssl rand -base64 30 | tr -dc 'A-Za-z0-9' | head -c 32); mask "$DBPASS"
  body=$(mktemp)
  jq -n --arg n "$NAME" --arg o "$ORG" --arg p "$DBPASS" --arg r "$REGION" '{name:$n, organization_id:$o, db_pass:$p, region:$r}' > "$body"
  if ! REF=$(api POST /projects "$body" | jq -r '.id // .ref'); then
    jq -n --arg n "$NAME" --arg o "$ORG" --arg p "$DBPASS" --arg r "$REGION" '{name:$n, organization_slug:$o, db_pass:$p, region:$r}' > "$body"
    REF=$(api POST /projects "$body" | jq -r '.id // .ref')
  fi
  rm -f "$body"
  echo "أُنشئ مشروع جديد: $REF (كلمة مرور قاعدة البيانات عشوائية؛ يمكن تغييرها من Project Settings ← Database)"
else
  echo "مشروع موجود: $REF"
fi
for i in $(seq 1 60); do
  st=$(api GET "/projects/$REF" | jq -r .status)
  [ "$st" = "ACTIVE_HEALTHY" ] && break
  echo "  الحالة: $st — انتظار…"; sleep 10
done
[ "$st" = "ACTIVE_HEALTHY" ] || { echo "::error::المشروع لم يجهز (الحالة: $st)"; exit 1; }
SUPABASE_URL="${SUPABASE_URL_OVERRIDE:-https://$REF.supabase.co}"
echo "::endgroup::"

echo "::group::2) قاعدة البيانات"
for m in supabase/migrations/*.sql; do echo "  $m"; run_sql "$m"; done
echo "::endgroup::"

echo "::group::3) المفاتيح"
KEYS=$(api GET "/projects/$REF/api-keys?reveal=true")
ANON=$(echo "$KEYS" | jq -r '[.[] | select(.type == "publishable")][0].api_key // empty')
[ -n "$ANON" ] || ANON=$(echo "$KEYS" | jq -r '[.[] | select(.name == "anon")][0].api_key // empty')
SERVICE=$(echo "$KEYS" | jq -r '[.[] | select(.name == "service_role")][0].api_key // empty')
[ -n "$SERVICE" ] || SERVICE=$(echo "$KEYS" | jq -r '[.[] | select(.type == "secret")][0].api_key // empty')
mask "$SERVICE"
[ -n "$ANON" ] && [ -n "$SERVICE" ] || { echo "::error::تعذر قراءة مفاتيح المشروع"; exit 1; }
echo "::endgroup::"

echo "::group::4) الأسرار"
CLEANUP_SECRET=$(openssl rand -hex 24); mask "$CLEANUP_SECRET"
body=$(mktemp)
jq -n --arg a "${APP_URL%/}" --arg c "$CLEANUP_SECRET" --arg k "${ANTHROPIC_API_KEY:-}" \
  '[{name:"APP_URL", value:$a}, {name:"CLEANUP_SECRET", value:$c}] + (if $k != "" then [{name:"ANTHROPIC_API_KEY", value:$k}] else [] end)' > "$body"
api POST "/projects/$REF/secrets" "$body" >/dev/null; rm -f "$body"
[ -n "${ANTHROPIC_API_KEY:-}" ] && echo "  ANTHROPIC_API_KEY ✅" || echo "  ANTHROPIC_API_KEY غير مضبوط — ميزة «منيو من صورة» معطلة"
echo "::endgroup::"

echo "::group::5) الدوال"
for fn in sign-upload vision-menu manifest cleanup-media; do
  supabase functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-api --yes
done
echo "::endgroup::"

echo "::group::6) إعدادات الدخول"
if [ -n "${APP_URL:-}" ]; then
  body=$(mktemp)
  jq -n --arg u "${APP_URL%/}" '{site_url:$u, uri_allow_list:($u + "/**"), mfa_totp_enroll_enabled:true, mfa_totp_verify_enabled:true}' > "$body"
  api PATCH "/projects/$REF/config/auth" "$body" >/dev/null || echo "::warning::تعذر ضبط إعدادات الدخول — اضبط Site URL يدوياً من Authentication ← URL Configuration"
  rm -f "$body"
fi
echo "::endgroup::"

echo "::group::7) تنظيف الصور اليومي"
tmp=$(mktemp)
sed -e "s/PROJECT_REF/$REF/" -e "s/CLEANUP_SECRET/$CLEANUP_SECRET/" supabase/cron.sql > "$tmp"
run_sql "$tmp" 1 && echo "  مجدول ✅" || echo "::warning::تعذرت الجدولة — فعّل Cron من Integrations ثم أعد التشغيل"
rm -f "$tmp"
echo "::endgroup::"

echo "::group::8) المدير"
if [ -n "${ADMIN_EMAIL:-}" ]; then
  email=$(echo "$ADMIN_EMAIL" | tr 'A-Z' 'a-z' | tr -d ' ')
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$SUPABASE_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg e "$email" '{email:$e, email_confirm:true}')")
  case "$code" in 2*) echo "  أُنشئ حساب المدير";; 422) echo "  حساب المدير موجود";; *) echo "::warning::إنشاء المستخدم أعاد HTTP $code";; esac
  tmp=$(mktemp)
  printf "insert into private.admins (user_id) select id from auth.users where lower(email) = '%s' on conflict do nothing;\n" "${email//\'/\'\'}" > "$tmp"
  run_sql "$tmp" && echo "  صلاحية المدير ✅ — ادخل من ${APP_URL%/}/admin بزر «أرسل رابط دخول لبريدي»"
  rm -f "$tmp"
else
  echo "::warning::ADMIN_EMAIL غير مضبوط — لن يُنشأ حساب مدير"
fi
echo "::endgroup::"

{ echo "supabase_url=$SUPABASE_URL"; echo "anon_key=$ANON"; echo "project_ref=$REF"; } >> "$OUT"
echo "✅ Supabase جاهز: $SUPABASE_URL"
