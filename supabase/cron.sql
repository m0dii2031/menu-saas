-- =====================================================================
-- جدولة تنظيف الصور غير المستخدمة يومياً (Supabase Cron = pg_cron + pg_net)
-- استبدل PROJECT_REF و CLEANUP_SECRET ثم نفّذ الملف في SQL Editor.
-- لمعاينة ما سيُحذف بدون حذف: أضف ?dry_run=1 لرابط الدالة واستدعها يدوياً.
-- =====================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('cleanup-media-daily')
where exists (select 1 from cron.job where jobname = 'cleanup-media-daily');

select cron.schedule(
  'cleanup-media-daily',
  '23 3 * * *',   -- 3:23 فجراً بتوقيت UTC يومياً
  $$
  select net.http_post(
    url     := 'https://PROJECT_REF.supabase.co/functions/v1/cleanup-media',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cleanup-secret', 'CLEANUP_SECRET'),
    body    := '{}'::jsonb
  );
  $$
);
