# اختبارات E2E

تشغّل الواجهة الحقيقية في Chromium (iPhone 13) مقابل Postgres محلي عليه نفس الـ migration.
طلبات `*.supabase.co` تُعترض وتُنفَّذ دوال RPC فعلياً على القاعدة بدور `anon` / `authenticated`،
فتُختبر سياسات RLS والدوال كما هي في الإنتاج.

```bash
cd tests/e2e
npm install
npx playwright install chromium     # إن لم يكن مثبتاً
PGHOST=/var/run/postgresql PGPORT=5432 PGUSER=postgres npm test
```
يحتاج Postgres 15+ مع امتداد pgcrypto وصلاحية إنشاء قاعدة `e2e` (تُحذف وتُنشأ في كل تشغيل).
لقطات الشاشة تُحفظ في `tests/e2e/shots/`.
