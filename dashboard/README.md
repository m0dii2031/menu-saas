# النشر من لوحة Supabase (نسخ ولصق — بدون أي أوامر)

كل الملفات في هذا المجلد. لنسخ أي ملف: افتحه على GitHub ← زر **Copy raw file** (أيقونة النسخ أعلى يمين الملف).

> هذا المجلد مولَّد من `supabase/` عبر `python3 scripts/build-dashboard.py` — لا تعدّله يدوياً.

---

## 1) إنشاء المشروع
1. https://supabase.com/dashboard/new ← **New project**
2. Name: `menu-saas` • Database Password: **Generate** (احفظها عندك) • Region: **Frankfurt (eu-central-1)** • **Create**
3. انتظر حتى يجهز (دقيقتان).

## 2) قاعدة البيانات
1. القائمة الجانبية ← **SQL Editor** ← **+ New query**
2. الصق محتوى **`1-database.sql`** كاملاً ← **Run** (أسفل اليمين).
3. إذا ظهرت رسالة تحذير «destructive operation» اضغط **Run this query** — الملف آمن ولا يحذف بيانات.
4. النتيجة المتوقعة: `Success. No rows returned`.

## 3) الدوال الأربع (Edge Functions)
كرر لكل ملف في `functions/`:

| اسم الدالة (بالضبط) | الملف |
|---|---|
| `sign-upload` | `functions/sign-upload.ts` |
| `vision-menu` | `functions/vision-menu.ts` |
| `manifest` | `functions/manifest.ts` |
| `cleanup-media` | `functions/cleanup-media.ts` |

1. القائمة الجانبية ← **Edge Functions** ← **Deploy a new function** ← **Via Editor**
2. امسح الكود الموجود والصق محتوى الملف.
3. أسفل الصفحة: **Function name** = الاسم من الجدول بالضبط ← **Deploy function**
4. بعد النشر: تبويب **Details** ← أطفئ **Verify JWT with legacy secret** (أو **Enforce JWT Verification**) ← **Save changes**.
   ⚠️ هذه الخطوة ضرورية؛ بدونها الدوال ترفض الطلبات (التحقق يتم داخل الدالة نفسها).

## 4) الأسرار
**Edge Functions** ← **Secrets** ← أضف:

| Name | Value |
|---|---|
| `APP_URL` | رابط موقعك (مثلاً `https://menu-saas.vercel.app`) — يمكن إضافته لاحقاً بعد خطوة Vercel |
| `ANTHROPIC_API_KEY` | مفتاحك من https://console.anthropic.com/settings/keys (اختياري: لميزة «منيو من صورة») |
| `CLEANUP_SECRET` | أي كلمة عشوائية طويلة (مثلاً 40 حرف وأرقام) — احفظها للخطوة 6 |

## 5) حساب المدير
1. **Authentication** ← **Users** ← **Add user** ← **Create new user**: بريدك + كلمة مرور قوية + فعّل **Auto Confirm User** ← **Create user**
2. **SQL Editor** ← **New query** ← الصق **`2-admin.sql`** وغيّر `YOUR-EMAIL@example.com` لبريدك ← **Run**
3. يجب أن يظهر بريدك وبجانبه `admin ✅`.

## 6) تنظيف الصور اليومي (اختياري)
1. **Integrations** ← فعّل **Cron** و **pg_net** (إن طُلب).
2. **SQL Editor** ← الصق **`3-cron.sql`** واستبدل:
   - `PROJECT_REF` برقم مشروعك (الحروف في رابط اللوحة: `supabase.com/dashboard/project/xxxx`)
   - `CLEANUP_SECRET` بنفس الكلمة من الخطوة 4
3. **Run**.

## 7) ربط الواجهة
**Project Settings** ← **API Keys** (أو **Data API**) وانسخ:
- **Project URL**: `https://xxxx.supabase.co`
- **Publishable key** (`sb_publishable_...`) أو **anon public** — هذا مفتاح عام وليس سرياً.

ضعهما في `public/assets/js/config.js` (أو أرسلهما لـ Claude ليضعهما ويرفع التعديل).

## 8) الاستضافة على Vercel (مجاناً)
1. https://vercel.com/new ← سجّل بـ GitHub ← اختر `menu-saas` ← **Import**
2. **Environment Variables**: `SUPABASE_URL` = Project URL • `SUPABASE_ANON_KEY` = المفتاح العام (لمعاينة الروابط في واتساب)
3. **Deploy** ← خذ رابط الموقع وضعه في سر `APP_URL` (الخطوة 4).

## 9) التجربة
- `https://موقعك/admin` ← ادخل ببريد المدير ← **متجر جديد** ← انسخ رمز PIN.
- افتح رابط المتجر من الجوال واطلب طلباً تجريبياً، ثم ادخل لوحة التاجر `…/manage?store=…` بالرمز.
- راجع `docs/DEVICE_TESTING.md`.
