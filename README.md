# منصة المنيو الإلكتروني وبوابات الطلب عبر واتساب (Multi-tenant SaaS)

منصة خفيفة وسريعة (HTML/CSS/JS بدون أي خطوة بناء) لإنشاء منيو إلكتروني وبوابات **طلب / حجز / استفسار / تبرع / استشارة** لأي نشاط،
تعتمد على **Click-to-Chat الرسمي (`wa.me`)** — بدون أي بوت واتساب، فلا خطر حظر للأرقام.

```
domain.com/?store=slug          ← صفحة المتجر العامة (PWA قابلة للتثبيت)
domain.com/manage?store=slug    ← لوحة التاجر (PIN)
domain.com/admin                ← لوحة الإدارة العامة (Supabase Auth)
```

## هيكل المشروع

```
public/                         ← الواجهة (تُرفع كما هي على أي استضافة ثابتة)
  index.html  manage.html  admin.html  sw.js
  assets/css/app.css            ← نظام التصميم + 11 قالب عبر CSS Variables
  assets/js/config.js           ← ⚙️ رابط ومفتاح Supabase
  assets/js/common.js           ← بناء DOM آمن، ضغط الصور، أوقات العمل، API
  assets/js/store.js            ← واجهة العميل (5 أوضاع تشغيل + رسالة واتساب)
  assets/js/manage.js           ← لوحة التاجر (4 تبويبات)
  assets/js/admin.js            ← لوحة المدير العام
supabase/
  migrations/20261126000000_init.sql   ← الجداول + RLS + كل دوال RPC + Storage
  functions/sign-upload         ← روابط رفع موقّعة بعد التحقق من جلسة التاجر
  functions/vision-menu         ← استخراج المنيو من صورة (Claude Vision) — خادم فقط
  functions/manifest            ← Manifest ديناميكي لكل متجر (الاسم/الشعار/اللون)
  config.toml
tests/e2e/                      ← اختبارات شاملة (Playwright + Postgres حقيقي)
```

## التشغيل خطوة بخطوة

### 1) قاعدة البيانات
1. أنشئ مشروعاً في Supabase.
2. افتح **SQL Editor** والصق محتوى `supabase/migrations/20261126000000_init.sql` ثم شغّله
   (أو `supabase db push` إن كنت تستخدم CLI). الملف آمن لإعادة التشغيل.
3. أنشئ حساب المدير من **Authentication → Users → Add user** ثم نفّذ:
   ```sql
   insert into private.admins (user_id)
   select id from auth.users where email = 'admin@example.com';
   ```
4. **مهم:** من **Project Settings → API → Exposed schemas** تأكد أن مخطط `private` **غير** مكشوف (الافتراضي `public` فقط).

### 2) Edge Functions
```bash
supabase functions deploy sign-upload --no-verify-jwt
supabase functions deploy vision-menu --no-verify-jwt
supabase functions deploy manifest --no-verify-jwt
supabase secrets set APP_URL=https://your-domain.com ANTHROPIC_API_KEY=sk-ant-...
```
- `APP_URL`: نطاق الواجهة بدون `/` في النهاية (يُستخدم لـ CORS و `start_url` في الـ Manifest).
- `ANTHROPIC_API_KEY`: يبقى في الخادم فقط ولا يصل للمتصفح إطلاقاً.
- اختياري: `VISION_MODEL` (الافتراضي `claude-opus-5-5`). لخفض التكلفة يمكنك ضبطه على `claude-sonnet-5-5` أو `claude-haiku-5-5`.
- `--no-verify-jwt` مقصود: التحقق يتم داخل الدوال برمز جلسة التاجر، و`manifest` يُجلب عبر `<link>` بدون ترويسات.

### 3) الواجهة
1. عدّل `public/assets/js/config.js` بقيمتي `SUPABASE_URL` و `SUPABASE_ANON_KEY` (أو publishable key).
2. ارفع مجلد `public/` على أي استضافة ثابتة:
   - **Vercel**: `vercel.json` جاهز (`cleanUrls` يجعل `/manage` و `/admin` تعمل).
   - **Netlify / Cloudflare Pages**: ملفا `_redirects` و `_headers` جاهزان.
3. إذا كنت تستخدم نطاقاً مخصصاً لـ Supabase (غير `*.supabase.co`) أضفه في وسم CSP داخل الملفات الثلاثة `*.html`.

### 4) الاستخدام
- ادخل `/admin` ← **+ متجر جديد** ← يظهر الرابط + لوحة التاجر + **PIN** (يظهر مرة واحدة) + QR.
- أرسل للتاجر «رسالة الترحيب» بضغطة واحدة، ويبدأ هو بإضافة المنيو من `/manage?store=slug`.

## العملة واللغة
- **رمز الريال السعودي الرسمي ( ⃁ U+20C1):** يُعرض في الواجهة عبر خط مفتوح المصدر (OFL) مستضاف داخل المنصة في `public/assets/fonts/` ومفعّل لهذا الحرف فقط (`unicode-range`)، فيظهر صحيحاً حتى على الأجهزة التي لا تدعمه. في رسائل واتساب تُكتب العملة نصاً «ريال» لأن واتساب قد لا يعرض الرمز الجديد. الإعداد في `config.js` (`CURRENCY` و `CURRENCY_TEXT`).
- **عربي / English:** صفحة العميل ثنائية اللغة مع زر تبديل (EN / ع) أعلى الصفحة، وتنقلب الواجهة تلقائياً من اليمين لليسار. الاختيار يُحفظ في المتصفح، ويمكن فتح الرابط مباشرة بالإنجليزية بإضافة `&lang=en`. القاموس في `public/assets/js/i18n.js`. أسماء الأصناف تُعرض كما كتبها التاجر، ورسالة واتساب تبقى بالعربية لأنها موجهة للتاجر.

## الحماية (Security Hardening)

| المتطلب | التنفيذ |
|---|---|
| RLS صارم | الزوار يقرؤون `stores`/`products` **للمتاجر النشطة غير المنتهية فقط**. لا توجد أي صلاحية كتابة مباشرة لأي دور؛ كل الكتابة عبر RPC `SECURITY DEFINER` بقائمة حقول بيضاء. |
| إخفاء PIN | لا يوجد عمود PIN في `stores` إطلاقاً؛ يُخزّن **مُجزّأً bcrypt** في `private.store_secrets` (مخطط غير مكشوف عبر API)، فلا يمكن لأي استعلام عام أو حدث Realtime أن يراه. |
| دخول التاجر | `merchant_login` في الخادم: قفل **15 دقيقة بعد 5 محاولات خاطئة** للمتجر و10 لكل IP، ثم يصدر رمز جلسة عشوائي 256-bit (يُخزّن hash فقط) صالح 7 أيام. تغيير PIN يُنهي باقي الجلسات. |
| المدير العام | Supabase Auth + جدول `private.admins`؛ كل دوال `admin_*` تتحقق داخلياً. دخول المدير للوحة التاجر بجلسة مؤقتة ساعتين. |
| Vision API | في Edge Function فقط، المفتاح سري في الخادم، **5 صور يومياً لكل متجر** (عدّاد ذري في القاعدة، ويُعاد الرصيد إذا فشل الاستدعاء). |
| Storage | bucket `media`: **JPEG/PNG/WebP فقط، 2MB حد أقصى** مفروض على مستوى الـ bucket، والرفع فقط عبر روابط موقّعة بعد التحقق من الجلسة (60 رفعة/ساعة). الصور تُضغط في المتصفح قبل الرفع (WebP). |
| analytics_events | إلحاق فقط عبر `log_event` (Trigger يمنع UPDATE/DELETE حتى من service_role)، قيود CHECK على النوع والمبلغ وحجم JSON، Rate limit لكل IP (5 طلبات/10 دقائق لكل متجر). |
| زر الطلب | مهلة 30 ثانية بين الطلبات في المتصفح + حد الخادم أعلاه. |
| XSS | **لا يوجد `innerHTML` في أي مكان**؛ كل النصوص تُضاف كـ `textContent` عبر `h()`، والروابط تمر على `safeUrl()`، والخادم ينظّف النصوص والروابط (`https://` فقط)، مع CSP صارم بدون `unsafe-inline` للسكربتات. |

## ملاحظات تشغيلية
- **التحديث الفوري:** كل دالة RPC للتاجر تحدّث `stores.updated_at`، وصفحة المتجر مشتركة في Supabase Realtime على صف متجرها فتعيد الجلب فوراً (مع تحديث احتياطي كل دقيقتين وعند العودة للتبويب).
- **أوقات العمل:** تُحسب بتوقيت المتجر (`timezone`، افتراضياً `Asia/Riyadh`) وبساعة الخادم لتفادي اختلاف ساعة الجهاز، وتدعم الدوام بعد منتصف الليل (مثل 4:00م → 2:00ص). ترك الوقتين فارغين = 24 ساعة.
- **رقم الطلب:** عدّاد متسلسل لكل متجر من الخادم (#1001، #1002...)، مع رقم احتياطي إذا تأخر الخادم كي لا يتعطل الطلب.
- جدول `stores` مقروء للزوار (للمتاجر النشطة) حتى يعمل Realtime؛ هذا يكشف أسماء المتاجر النشطة وأرقام واتسابها، وهي عامة أصلاً في صفحاتها.

## الاختبارات
`tests/e2e/` يشغّل الواجهة الحقيقية في Chromium (مقاس iPhone) مقابل Postgres محلي عليه نفس الـ migration، ويتحقق من 41 سيناريو:
رحلة المدير والتاجر والعميل كاملة، نص رسالة واتساب وترتيبها، الأوضاع الخمسة، الدوام بعد منتصف الليل، الإغلاق الطارئ، انتهاء الاشتراك، XSS، ضغط الصور، المهلة، وعدم وجود أخطاء JS أو تجاوز أفقي للشاشة.
راجع `tests/e2e/README.md` لطريقة التشغيل.
