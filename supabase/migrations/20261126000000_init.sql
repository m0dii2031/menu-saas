-- =====================================================================
--  منصة المنيو الإلكتروني متعددة المتاجر (Multi-tenant SaaS)
--  Supabase schema + RLS + RPC  —  شغّل هذا الملف مرة واحدة في SQL Editor
-- =====================================================================
--  مبادئ الحماية:
--   * الجداول العامة (stores / products) قراءة فقط للزوار، والقراءة مقصورة
--     على المتاجر النشطة غير المنتهية عبر RLS.
--   * لا توجد أي صلاحية INSERT/UPDATE/DELETE مباشرة للزوار أو التجار؛
--     كل الكتابة تتم عبر دوال RPC (SECURITY DEFINER) تتحقق من الصلاحية.
--   * رمز PIN لا يُخزَّن في stores إطلاقاً؛ يُخزَّن مُجزّأً (bcrypt) في
--     private.store_secrets — مخطط غير مكشوف عبر API، فلا يمكن لأي
--     استعلام عام أو Realtime أن يراه.
--   * analytics_events إلحاق فقط (append-only) عبر RPC مع Rate Limiting.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

create schema if not exists private;
revoke all on schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema private from anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 1) الجداول العامة
-- ---------------------------------------------------------------------
create table if not exists public.stores (
  id                   uuid primary key default gen_random_uuid(),
  slug                 text not null unique
                       check (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
  name                 text not null check (char_length(name) between 2 and 80),
  logo_url             text check (logo_url is null or (logo_url ~ '^https://' and char_length(logo_url) <= 600)),
  cover_url            text check (cover_url is null or (cover_url ~ '^https://' and char_length(cover_url) <= 600)),
  whatsapp_phone       text not null check (whatsapp_phone ~ '^[1-9][0-9]{7,14}$'),
  delivery_fee         numeric(10,2) not null default 0 check (delivery_fee between 0 and 10000),
  theme_style          text not null default 'theme-general' check (theme_style in (
                         'theme-restaurant','theme-cafe','theme-pharmacy','theme-store','theme-service',
                         'theme-chalet','theme-realestate','theme-bakery','theme-charity','theme-legal','theme-general')),
  custom_primary_color text check (custom_primary_color is null or custom_primary_color ~ '^#[0-9a-fA-F]{6}$'),
  business_type        text check (business_type is null or char_length(business_type) <= 60),
  business_mode        text not null default 'order'
                       check (business_mode in ('order','booking','inquiry','charity','legal')),
  is_active            boolean not null default true,
  is_open              boolean not null default true,      -- زر الإغلاق الطارئ
  open_time            time,
  close_time           time,
  timezone             text not null default 'Asia/Riyadh' check (char_length(timezone) <= 60),
  expires_at           timestamptz not null default (now() + interval '30 days'),
  iban_number          text check (iban_number is null or iban_number ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$'),
  banner_active        boolean not null default false,
  banner_image_url     text check (banner_image_url is null or (banner_image_url ~ '^https://' and char_length(banner_image_url) <= 600)),
  banner_text          text check (banner_text is null or char_length(banner_text) <= 200),
  banner_expires_at    timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint stores_hours_pair check ((open_time is null) = (close_time is null))
);

create table if not exists public.products (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  category      text not null default '' check (char_length(category) <= 60),
  name          text not null check (char_length(name) between 1 and 120),
  description   text check (description is null or char_length(description) <= 1000),
  price         numeric(12,2) not null default 0 check (price between 0 and 10000000),
  image_url     text check (image_url is null or (image_url ~ '^https://' and char_length(image_url) <= 600)),
  gallery_json  jsonb not null default '[]'::jsonb
                check (jsonb_typeof(gallery_json) = 'array' and jsonb_array_length(gallery_json) <= 8),
  options_json  jsonb not null default '{}'::jsonb
                check (jsonb_typeof(options_json) = 'object' and pg_column_size(options_json) <= 16000),
  is_available  boolean not null default true,
  sort_order    integer not null default 0 check (sort_order between -100000 and 100000),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists products_store_idx on public.products (store_id, sort_order, created_at);

create table if not exists public.analytics_events (
  id           bigint generated always as identity primary key,
  store_id     uuid not null references public.stores(id) on delete cascade,
  event_type   text not null check (event_type in ('view','order_click')),
  order_total  numeric(12,2) check (order_total is null or order_total between 0 and 10000000),
  items_json   jsonb check (items_json is null or (jsonb_typeof(items_json) = 'array' and pg_column_size(items_json) <= 8000)),
  created_at   timestamptz not null default now(),
  constraint analytics_total_only_orders check (event_type = 'order_click' or (order_total is null and items_json is null))
);
create index if not exists analytics_store_time_idx on public.analytics_events (store_id, created_at desc);

-- ---------------------------------------------------------------------
-- 2) الجداول الخاصة (غير مكشوفة عبر PostgREST)
-- ---------------------------------------------------------------------
create table if not exists private.store_secrets (
  store_id  uuid primary key references public.stores(id) on delete cascade,
  pin_hash  text not null
);

create table if not exists private.admins (
  user_id    uuid primary key,
  created_at timestamptz not null default now()
);

create table if not exists private.merchant_sessions (
  token_hash  bytea primary key,
  store_id    uuid not null references public.stores(id) on delete cascade,
  is_admin    boolean not null default false,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists merchant_sessions_store_idx on private.merchant_sessions (store_id);

create table if not exists private.login_failures (
  id        bigint generated always as identity primary key,
  store_id  uuid,
  ip        text not null,
  at        timestamptz not null default now()
);
create index if not exists login_failures_store_idx on private.login_failures (store_id, at);
create index if not exists login_failures_ip_idx on private.login_failures (ip, at);

create table if not exists private.rate_limits (
  bucket        text not null,
  key           text not null,
  window_start  timestamptz not null default now(),
  hits          integer not null default 0,
  primary key (bucket, key)
);

create table if not exists private.order_counters (
  store_id  uuid primary key references public.stores(id) on delete cascade,
  seq       integer not null default 1000
);

create table if not exists private.vision_usage (
  store_id  uuid not null references public.stores(id) on delete cascade,
  day       date not null,
  used      integer not null default 0,
  primary key (store_id, day)
);

-- ---------------------------------------------------------------------
-- 3) دوال مساعدة داخلية
-- ---------------------------------------------------------------------
-- نص سطر واحد: يحذف محارف التحكم والأسطر الجديدة ويقص الطول
create or replace function private.clean_line(p text, p_max int)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(coalesce(p, ''), '[[:cntrl:]]+', ' ', 'g')), p_max), '')
$$;

-- نص متعدد الأسطر: يبقي \n فقط
create or replace function private.clean_text(p text, p_max int)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(btrim(regexp_replace(replace(coalesce(p, ''), E'\r', ''), E'[\\x01-\\x09\\x0B-\\x1F\\x7F]+', ' ', 'g')), p_max), '')
$$;

create or replace function private.clean_url(p text)
returns text language sql immutable set search_path = '' as $$
  select case when p ~ '^https://[^[:space:]"''<>`]+$' and char_length(p) <= 600 then p else null end
$$;

create or replace function private.to_num(p text, p_max numeric default 10000000)
returns numeric language sql immutable set search_path = '' as $$
  select case when btrim(coalesce(p, '')) ~ '^[0-9]{1,9}(\.[0-9]{1,2})?$'
              then least(btrim(p)::numeric, p_max) else null end
$$;

-- توحيد أرقام الجوال (يدعم الأرقام العربية والصيغ السعودية 05xxxxxxxx)
create or replace function private.norm_phone(p text)
returns text language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  v := translate(coalesce(p, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789');
  v := regexp_replace(v, '[^0-9]', '', 'g');
  if v like '00%' then v := substr(v, 3); end if;
  if v ~ '^05[0-9]{8}$' then v := '966' || substr(v, 2);
  elsif v ~ '^5[0-9]{8}$' then v := '966' || v;
  end if;
  if v !~ '^[1-9][0-9]{7,14}$' then
    raise exception 'invalid_phone' using errcode = '22023';
  end if;
  return v;
end $$;

-- تنظيف خيارات الصنف: sizes / addons / specs / unit
create or replace function private.clean_options(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  v_unit text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return v; end if;

  if jsonb_typeof(p->'sizes') = 'array' then
    v := v || jsonb_build_object('sizes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name',  private.clean_line(e->>'name', 40),
               'price', coalesce(private.to_num(e->>'price'), 0)))
      from (select e from jsonb_array_elements(p->'sizes') e
            where jsonb_typeof(e) = 'object' and private.clean_line(e->>'name', 40) is not null
            limit 20) s), '[]'::jsonb));
  end if;

  if jsonb_typeof(p->'addons') = 'array' then
    v := v || jsonb_build_object('addons', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name',  private.clean_line(e->>'name', 40),
               'price', coalesce(private.to_num(e->>'price'), 0)))
      from (select e from jsonb_array_elements(p->'addons') e
            where jsonb_typeof(e) = 'object' and private.clean_line(e->>'name', 40) is not null
            limit 30) s), '[]'::jsonb));
  end if;

  if jsonb_typeof(p->'specs') = 'array' then
    v := v || jsonb_build_object('specs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', private.clean_line(e->>'label', 40),
               'value', coalesce(private.clean_line(e->>'value', 120), '')))
      from (select e from jsonb_array_elements(p->'specs') e
            where jsonb_typeof(e) = 'object' and private.clean_line(e->>'label', 40) is not null
            limit 20) s), '[]'::jsonb));
  end if;

  v_unit := private.clean_line(p->>'unit', 20);
  if v_unit in ('ليلة','يوم','ساعة','شهر','جلسة','سهم') then
    v := v || jsonb_build_object('unit', v_unit);
  end if;
  return v;
end $$;

create or replace function private.clean_gallery(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce((
    select jsonb_agg(u) from (
      select u from (
        select private.clean_url(e #>> '{}') u
        from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) e
        where jsonb_typeof(e) = 'string'
      ) a where u is not null limit 8
    ) s
  ), '[]'::jsonb)
$$;

-- IP العميل من ترويسات PostgREST
create or replace function private.client_ip()
returns text language sql stable set search_path = '' as $$
  select coalesce(
    nullif(btrim((nullif(current_setting('request.headers', true), '')::json)->>'cf-connecting-ip'), ''),
    nullif(btrim(split_part((nullif(current_setting('request.headers', true), '')::json)->>'x-forwarded-for', ',', 1)), ''),
    'unknown')
$$;

-- نافذة ثابتة لتحديد المعدل: ترجع true إذا كان الطلب مسموحاً
create or replace function private.rate_limit_ok(p_bucket text, p_key text, p_max int, p_window interval)
returns boolean language plpgsql volatile set search_path = '' as $$
declare v_hits int;
begin
  insert into private.rate_limits as r (bucket, key, window_start, hits)
  values (p_bucket, p_key, now(), 1)
  on conflict (bucket, key) do update set
    hits         = case when r.window_start < now() - p_window then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_max;
end $$;

create or replace function private.store_is_live(p_store public.stores)
returns boolean language sql stable set search_path = '' as $$
  select p_store.is_active and p_store.expires_at > now()
$$;

create or replace function private.touch_store(p_store_id uuid)
returns void language sql volatile set search_path = '' as $$
  update public.stores set updated_at = now() where id = p_store_id
$$;

create or replace function private.store_stats(p_store_id uuid, p_since timestamptz)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'views',   count(*) filter (where event_type = 'view'),
    'orders',  count(*) filter (where event_type = 'order_click'),
    'revenue', coalesce(sum(order_total) filter (where event_type = 'order_click'), 0))
  from public.analytics_events
  where store_id = p_store_id and created_at >= p_since
$$;

create or replace function private.random_pin()
returns text language sql volatile set search_path = '' as $$
  select lpad(((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint) % 1000000)::text, 6, '0')
$$;

create or replace function private.new_session(p_store_id uuid, p_ttl interval, p_admin boolean)
returns text language plpgsql volatile set search_path = '' as $$
declare v_token text := encode(extensions.gen_random_bytes(32), 'hex');
begin
  delete from private.merchant_sessions where expires_at < now();
  insert into private.merchant_sessions (token_hash, store_id, is_admin, expires_at)
  values (extensions.digest(v_token, 'sha256'), p_store_id, p_admin, now() + p_ttl);
  return v_token;
end $$;

-- يتحقق من رمز جلسة التاجر ويرجع store_id أو يرفع خطأ
create or replace function private.merchant_auth(p_token text)
returns uuid language plpgsql stable set search_path = '' as $$
declare v uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  select store_id into v from private.merchant_sessions
  where token_hash = extensions.digest(p_token, 'sha256') and expires_at > now();
  if v is null then
    raise exception 'unauthorized' using errcode = '28000';
  end if;
  return v;
end $$;

-- ---------------------------------------------------------------------
-- 4) حماية analytics_events (إلحاق فقط)
-- ---------------------------------------------------------------------
create or replace function private.block_analytics_mutation()
returns trigger language plpgsql set search_path = '' as $$
begin
  -- يُسمح بالحذف المتتالي فقط عند حذف المتجر نفسه (ON DELETE CASCADE)
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception 'analytics_events is append-only' using errcode = '42501';
end $$;

drop trigger if exists analytics_no_update on public.analytics_events;
create trigger analytics_no_update before update or delete on public.analytics_events
  for each row execute function private.block_analytics_mutation();

-- ---------------------------------------------------------------------
-- 5) صلاحيات المدير العام
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from private.admins where user_id = auth.uid())
$$;

create or replace function private.require_admin()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 6) RLS
-- ---------------------------------------------------------------------
alter table public.stores           enable row level security;
alter table public.products         enable row level security;
alter table public.analytics_events enable row level security;
alter table public.stores           force row level security;
alter table public.products         force row level security;
alter table public.analytics_events force row level security;

drop policy if exists stores_public_read on public.stores;
create policy stores_public_read on public.stores
  for select to anon, authenticated
  using (is_active and expires_at > now());

drop policy if exists stores_admin_read on public.stores;
create policy stores_admin_read on public.stores
  for select to authenticated
  using (public.is_admin());

drop policy if exists products_public_read on public.products;
create policy products_public_read on public.products
  for select to anon, authenticated
  using (exists (select 1 from public.stores s
                 where s.id = products.store_id and s.is_active and s.expires_at > now()));

drop policy if exists products_admin_read on public.products;
create policy products_admin_read on public.products
  for select to authenticated
  using (public.is_admin());

drop policy if exists analytics_admin_read on public.analytics_events;
create policy analytics_admin_read on public.analytics_events
  for select to authenticated
  using (public.is_admin());
-- لا توجد أي سياسة INSERT/UPDATE/DELETE: كل الكتابة عبر RPC فقط.

-- ---------------------------------------------------------------------
-- 7) RPC عامة (الزوار)
-- ---------------------------------------------------------------------
create or replace function public.get_store_public(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.stores;
begin
  select * into s from public.stores where slug = lower(btrim(coalesce(p_slug, '')));
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not private.store_is_live(s) then
    return jsonb_build_object('status', 'suspended', 'store',
      jsonb_build_object('name', s.name, 'logo_url', s.logo_url, 'theme_style', s.theme_style,
                         'custom_primary_color', s.custom_primary_color));
  end if;
  return jsonb_build_object(
    'status', 'ok',
    'server_time', now(),
    'store', jsonb_build_object(
      'id', s.id, 'slug', s.slug, 'name', s.name, 'logo_url', s.logo_url, 'cover_url', s.cover_url,
      'whatsapp_phone', s.whatsapp_phone, 'delivery_fee', s.delivery_fee, 'theme_style', s.theme_style,
      'custom_primary_color', s.custom_primary_color, 'business_type', s.business_type,
      'business_mode', s.business_mode, 'is_open', s.is_open,
      'open_time', to_char(s.open_time, 'HH24:MI'), 'close_time', to_char(s.close_time, 'HH24:MI'),
      'timezone', s.timezone, 'iban_number', s.iban_number,
      'banner_active', s.banner_active and (s.banner_expires_at is null or s.banner_expires_at > now()),
      'banner_image_url', s.banner_image_url, 'banner_text', s.banner_text,
      'banner_expires_at', s.banner_expires_at, 'updated_at', s.updated_at),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'category', p.category, 'name', p.name, 'description', p.description,
               'price', p.price, 'image_url', p.image_url, 'gallery_json', p.gallery_json,
               'options_json', p.options_json, 'is_available', p.is_available)
             order by p.sort_order, p.created_at)
      from public.products p where p.store_id = s.id), '[]'::jsonb));
end $$;

-- تسجيل حدث (مشاهدة / ضغط زر الطلب) مع Rate Limiting بحسب IP
-- ترجع رقم الطلب المتسلسل للمتجر عند order_click
create or replace function public.log_event(
  p_store_id uuid, p_event_type text, p_order_total numeric default null, p_items jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.stores;
  v_ip text := private.client_ip();
  v_seq int;
begin
  if p_event_type not in ('view', 'order_click') then
    raise exception 'invalid_event' using errcode = '22023';
  end if;
  select * into s from public.stores where id = p_store_id;
  if not found or not private.store_is_live(s) then
    return jsonb_build_object('ok', false, 'error', 'store_unavailable');
  end if;

  if p_event_type = 'view' then
    if not private.rate_limit_ok('view', v_ip || ':' || s.id, 3, interval '30 minutes')
       or not private.rate_limit_ok('view_ip', v_ip, 120, interval '1 hour') then
      return jsonb_build_object('ok', true, 'counted', false);
    end if;
    insert into public.analytics_events (store_id, event_type) values (s.id, 'view');
    return jsonb_build_object('ok', true, 'counted', true);
  end if;

  -- order_click
  if not private.rate_limit_ok('order', v_ip || ':' || s.id, 5, interval '10 minutes')
     or not private.rate_limit_ok('order_ip', v_ip, 20, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into private.order_counters as c (store_id, seq) values (s.id, 1001)
  on conflict (store_id) do update set seq = c.seq + 1
  returning seq into v_seq;

  insert into public.analytics_events (store_id, event_type, order_total, items_json)
  values (s.id, 'order_click',
          case when p_order_total is null then null else round(greatest(0, least(p_order_total, 10000000)), 2) end,
          case when jsonb_typeof(p_items) = 'array' and pg_column_size(p_items) <= 8000 then p_items else null end);

  return jsonb_build_object('ok', true, 'order_no', v_seq);
end $$;

-- ---------------------------------------------------------------------
-- 8) RPC التاجر (PIN + رمز جلسة)
-- ---------------------------------------------------------------------
create or replace function public.merchant_login(p_slug text, p_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ip   text := private.client_ip();
  v_id   uuid;
  v_hash text;
  v_store_fails int;
  v_ip_fails int;
begin
  select s.id, sec.pin_hash into v_id, v_hash
  from public.stores s join private.store_secrets sec on sec.store_id = s.id
  where s.slug = lower(btrim(coalesce(p_slug, '')));

  select count(*) into v_ip_fails from private.login_failures
  where ip = v_ip and at > now() - interval '15 minutes';
  if v_id is not null then
    select count(*) into v_store_fails from private.login_failures
    where store_id = v_id and at > now() - interval '15 minutes';
  else
    v_store_fails := 0;
  end if;

  if v_store_fails >= 5 or v_ip_fails >= 10 then
    return jsonb_build_object('ok', false, 'error', 'locked', 'retry_after_minutes', 15);
  end if;

  if v_id is null or p_pin is null or p_pin !~ '^[0-9]{4,8}$'
     or extensions.crypt(p_pin, v_hash) <> v_hash then
    insert into private.login_failures (store_id, ip) values (v_id, v_ip);
    delete from private.login_failures where at < now() - interval '1 day';
    perform pg_sleep(0.4);
    return jsonb_build_object('ok', false, 'error', 'invalid',
                              'remaining', greatest(0, 4 - v_store_fails));
  end if;

  delete from private.login_failures where store_id = v_id;
  return jsonb_build_object('ok', true, 'store_id', v_id,
                            'token', private.new_session(v_id, interval '7 days', false));
end $$;

create or replace function public.merchant_logout(p_token text)
returns void language sql volatile security definer set search_path = '' as $$
  delete from private.merchant_sessions where token_hash = extensions.digest(coalesce(p_token, ''), 'sha256')
$$;

create or replace function public.merchant_get_dashboard(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  s public.stores;
  v_today date;
begin
  select * into s from public.stores where id = v_store;
  v_today := (now() at time zone s.timezone)::date;
  return jsonb_build_object(
    'store', to_jsonb(s) || jsonb_build_object(
               'open_time', to_char(s.open_time, 'HH24:MI'),
               'close_time', to_char(s.close_time, 'HH24:MI'),
               'is_live', private.store_is_live(s)),
    'products', coalesce((select jsonb_agg(to_jsonb(p) order by p.sort_order, p.created_at)
                          from public.products p where p.store_id = v_store), '[]'::jsonb),
    'stats', jsonb_build_object(
               'today', private.store_stats(v_store, (v_today::timestamp at time zone s.timezone)),
               'last_30d', private.store_stats(v_store, now() - interval '30 days')),
    'vision_left', greatest(0, 5 - coalesce((select used from private.vision_usage
                                             where store_id = v_store and day = current_date), 0)));
end $$;

-- تحديث إعدادات/تصميم/بنر المتجر — قائمة بيضاء للحقول المسموح بها فقط
create or replace function public.merchant_update_store(p_token text, p_patch jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  p jsonb := coalesce(p_patch, '{}'::jsonb);
  v_iban text;
begin
  if jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_patch' using errcode = '22023';
  end if;
  if p ? 'name' and private.clean_line(p->>'name', 80) is null then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if p ? 'delivery_fee' and p->>'delivery_fee' is not null and private.to_num(p->>'delivery_fee', 10000) is null then
    raise exception 'invalid_fee' using errcode = '22023';
  end if;
  if p ? 'iban_number' then
    v_iban := nullif(upper(regexp_replace(coalesce(p->>'iban_number', ''), '[^A-Za-z0-9]', '', 'g')), '');
    if v_iban is not null and v_iban !~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{10,30}$' then
      raise exception 'invalid_iban' using errcode = '22023';
    end if;
  end if;

  update public.stores set
    name                 = case when p ? 'name' then private.clean_line(p->>'name', 80) else name end,
    business_type        = case when p ? 'business_type' then private.clean_line(p->>'business_type', 60) else business_type end,
    logo_url             = case when p ? 'logo_url' then private.clean_url(p->>'logo_url') else logo_url end,
    cover_url            = case when p ? 'cover_url' then private.clean_url(p->>'cover_url') else cover_url end,
    whatsapp_phone       = case when p ? 'whatsapp_phone' then private.norm_phone(p->>'whatsapp_phone') else whatsapp_phone end,
    delivery_fee         = case when p ? 'delivery_fee' then coalesce(private.to_num(p->>'delivery_fee', 10000), 0) else delivery_fee end,
    theme_style          = case when p ? 'theme_style' then p->>'theme_style' else theme_style end,
    custom_primary_color = case when p ? 'custom_primary_color' then nullif(p->>'custom_primary_color', '') else custom_primary_color end,
    is_open              = case when p ? 'is_open' then coalesce((p->>'is_open')::boolean, true) else is_open end,
    open_time            = case when p ? 'open_time' then nullif(p->>'open_time', '')::time else open_time end,
    close_time           = case when p ? 'close_time' then nullif(p->>'close_time', '')::time else close_time end,
    iban_number          = case when p ? 'iban_number' then v_iban else iban_number end,
    banner_active        = case when p ? 'banner_active' then coalesce((p->>'banner_active')::boolean, false) else banner_active end,
    banner_text          = case when p ? 'banner_text' then private.clean_line(p->>'banner_text', 200) else banner_text end,
    banner_image_url     = case when p ? 'banner_image_url' then private.clean_url(p->>'banner_image_url') else banner_image_url end,
    banner_expires_at    = case when p ? 'banner_expires_at' then nullif(p->>'banner_expires_at', '')::timestamptz else banner_expires_at end,
    updated_at           = now()
  where id = v_store;

  return public.merchant_get_dashboard(p_token);
end $$;

create or replace function public.merchant_save_product(p_token text, p_product jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  p jsonb := coalesce(p_product, '{}'::jsonb);
  v_id uuid;
  v_name text := private.clean_line(p->>'name', 120);
  v_price numeric := coalesce(private.to_num(p->>'price'), 0);
  v_row public.products;
begin
  if v_name is null then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  if nullif(p->>'id', '') is not null then
    v_id := (p->>'id')::uuid;
    update public.products set
      category     = coalesce(private.clean_line(p->>'category', 60), ''),
      name         = v_name,
      description  = private.clean_text(p->>'description', 1000),
      price        = v_price,
      image_url    = private.clean_url(p->>'image_url'),
      gallery_json = private.clean_gallery(p->'gallery_json'),
      options_json = private.clean_options(p->'options_json'),
      is_available = coalesce((p->>'is_available')::boolean, true),
      sort_order   = coalesce((p->>'sort_order')::int, sort_order),
      updated_at   = now()
    where id = v_id and store_id = v_store
    returning * into v_row;
    if not found then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
  else
    if (select count(*) from public.products where store_id = v_store) >= 500 then
      raise exception 'limit_reached' using errcode = '54000';
    end if;
    insert into public.products (store_id, category, name, description, price, image_url,
                                 gallery_json, options_json, is_available, sort_order)
    values (v_store, coalesce(private.clean_line(p->>'category', 60), ''), v_name,
            private.clean_text(p->>'description', 1000), v_price, private.clean_url(p->>'image_url'),
            private.clean_gallery(p->'gallery_json'), private.clean_options(p->'options_json'),
            coalesce((p->>'is_available')::boolean, true),
            coalesce((p->>'sort_order')::int,
                     (select coalesce(max(sort_order), 0) + 1 from public.products where store_id = v_store)))
    returning * into v_row;
  end if;

  perform private.touch_store(v_store);
  return to_jsonb(v_row);
end $$;

-- تعديل سريع: إظهار/إخفاء أو السعر
create or replace function public.merchant_quick_update(
  p_token text, p_id uuid, p_is_available boolean default null, p_price numeric default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  v_row public.products;
begin
  if p_price is not null and (p_price < 0 or p_price > 10000000) then
    raise exception 'invalid_price' using errcode = '22023';
  end if;
  update public.products set
    is_available = coalesce(p_is_available, is_available),
    price        = coalesce(round(p_price, 2), price),
    updated_at   = now()
  where id = p_id and store_id = v_store
  returning * into v_row;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform private.touch_store(v_store);
  return to_jsonb(v_row);
end $$;

create or replace function public.merchant_delete_product(p_token text, p_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_store uuid := private.merchant_auth(p_token);
begin
  delete from public.products where id = p_id and store_id = v_store;
  if not found then return false; end if;
  perform private.touch_store(v_store);
  return true;
end $$;

-- اعتماد الأصناف المستخرجة من صورة المنيو دفعة واحدة
create or replace function public.merchant_import_products(p_token text, p_items jsonb)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  v_existing int;
  v_count int;
  v_base int;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 200 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  select count(*), coalesce(max(sort_order), 0) into v_existing, v_base
  from public.products where store_id = v_store;
  if v_existing + jsonb_array_length(p_items) > 500 then
    raise exception 'limit_reached' using errcode = '54000';
  end if;

  insert into public.products (store_id, category, name, description, price, options_json, sort_order)
  select v_store,
         coalesce(private.clean_line(e->>'category', 60), ''),
         private.clean_line(e->>'name', 120),
         private.clean_text(e->>'description', 1000),
         coalesce(private.to_num(e->>'price'), 0),
         private.clean_options(jsonb_build_object('sizes', coalesce(e->'sizes', '[]'::jsonb))),
         v_base + ord::int
  from jsonb_array_elements(p_items) with ordinality as t(e, ord)
  where jsonb_typeof(e) = 'object' and private.clean_line(e->>'name', 120) is not null;
  get diagnostics v_count = row_count;

  perform private.touch_store(v_store);
  return v_count;
end $$;

create or replace function public.merchant_change_pin(p_token text, p_old_pin text, p_new_pin text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  v_hash text;
begin
  if p_new_pin is null or p_new_pin !~ '^[0-9]{4,8}$' then
    return jsonb_build_object('ok', false, 'error', 'weak_pin');
  end if;
  if not private.rate_limit_ok('pin_change', v_store::text, 5, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select pin_hash into v_hash from private.store_secrets where store_id = v_store;
  if v_hash is null or p_old_pin is null or extensions.crypt(p_old_pin, v_hash) <> v_hash then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  update private.store_secrets set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 10))
  where store_id = v_store;
  -- إنهاء كل الجلسات الأخرى
  delete from private.merchant_sessions
  where store_id = v_store and token_hash <> extensions.digest(p_token, 'sha256');
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 9) RPC خاصة بـ Edge Functions (service_role فقط)
-- ---------------------------------------------------------------------
create or replace function public.service_verify_merchant(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select private.merchant_auth(p_token)
$$;

-- يستهلك من الحصة اليومية لتحليل الصور، ويرجع المتبقي أو -1 إذا انتهت
create or replace function public.service_consume_vision(p_store_id uuid, p_limit int default 5)
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare v_used int;
begin
  insert into private.vision_usage as u (store_id, day, used) values (p_store_id, current_date, 1)
  on conflict (store_id, day) do update set used = u.used + 1
  where u.used < p_limit
  returning used into v_used;
  if v_used is null then return -1; end if;
  return p_limit - v_used;
end $$;

-- إعادة الحصة إذا فشل الاستدعاء الخارجي
create or replace function public.service_refund_vision(p_store_id uuid)
returns void language sql volatile security definer set search_path = '' as $$
  update private.vision_usage set used = greatest(0, used - 1)
  where store_id = p_store_id and day = current_date
$$;

create or replace function public.service_rate_limit(p_bucket text, p_key text, p_max int, p_window_seconds int)
returns boolean language sql volatile security definer set search_path = '' as $$
  select private.rate_limit_ok(p_bucket, p_key, p_max, make_interval(secs => p_window_seconds))
$$;

-- ---------------------------------------------------------------------
-- 10) RPC المدير العام (Supabase Auth + جدول private.admins)
-- ---------------------------------------------------------------------
create or replace function public.admin_list_stores()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(s)
             || jsonb_build_object(
                  'open_time', to_char(s.open_time, 'HH24:MI'),
                  'close_time', to_char(s.close_time, 'HH24:MI'),
                  'stats_30d', private.store_stats(s.id, now() - interval '30 days'),
                  'stats_all', private.store_stats(s.id, '-infinity'::timestamptz))
             order by s.created_at desc)
    from public.stores s), '[]'::jsonb);
end $$;

create or replace function public.admin_create_store(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_pin  text := nullif(btrim(coalesce(p->>'pin', '')), '');
  v_days int  := coalesce(nullif(p->>'days', '')::int, 30);
  v_row  public.stores;
  v_slug text := lower(btrim(coalesce(p->>'slug', '')));
begin
  perform private.require_admin();
  if v_pin is null then v_pin := private.random_pin(); end if;
  if v_pin !~ '^[0-9]{4,8}$' then
    raise exception 'invalid_pin' using errcode = '22023';
  end if;
  if v_days not between 1 and 3660 then
    raise exception 'invalid_days' using errcode = '22023';
  end if;
  if exists (select 1 from public.stores where slug = v_slug) then
    raise exception 'slug_taken' using errcode = '23505';
  end if;

  insert into public.stores (slug, name, whatsapp_phone, theme_style, business_mode, business_type, expires_at)
  values (v_slug,
          private.clean_line(p->>'name', 80),
          private.norm_phone(p->>'whatsapp_phone'),
          coalesce(nullif(p->>'theme_style', ''), 'theme-general'),
          coalesce(nullif(p->>'business_mode', ''), 'order'),
          private.clean_line(p->>'business_type', 60),
          now() + make_interval(days => v_days))
  returning * into v_row;

  insert into private.store_secrets (store_id, pin_hash)
  values (v_row.id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));

  return jsonb_build_object('store', to_jsonb(v_row), 'pin', v_pin);
end $$;

create or replace function public.admin_update_store(p_store_id uuid, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.stores;
begin
  perform private.require_admin();
  update public.stores set
    name           = coalesce(private.clean_line(p->>'name', 80), name),
    business_mode  = coalesce(nullif(p->>'business_mode', ''), business_mode),
    business_type  = case when p ? 'business_type' then private.clean_line(p->>'business_type', 60) else business_type end,
    theme_style    = coalesce(nullif(p->>'theme_style', ''), theme_style),
    whatsapp_phone = case when p ? 'whatsapp_phone' then private.norm_phone(p->>'whatsapp_phone') else whatsapp_phone end,
    updated_at     = now()
  where id = p_store_id returning * into v_row;
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_extend_store(p_store_id uuid, p_days int default 30)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.stores;
begin
  perform private.require_admin();
  if p_days not between 1 and 3660 then
    raise exception 'invalid_days' using errcode = '22023';
  end if;
  update public.stores
  set expires_at = greatest(expires_at, now()) + make_interval(days => p_days), updated_at = now()
  where id = p_store_id returning * into v_row;
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_set_active(p_store_id uuid, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.stores;
begin
  perform private.require_admin();
  update public.stores set is_active = p_active, updated_at = now()
  where id = p_store_id returning * into v_row;
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_reset_pin(p_store_id uuid, p_pin text default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_pin text := coalesce(nullif(btrim(coalesce(p_pin, '')), ''), private.random_pin());
begin
  perform private.require_admin();
  if v_pin !~ '^[0-9]{4,8}$' then
    raise exception 'invalid_pin' using errcode = '22023';
  end if;
  insert into private.store_secrets (store_id, pin_hash)
  values (p_store_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)))
  on conflict (store_id) do update set pin_hash = excluded.pin_hash;
  delete from private.merchant_sessions where store_id = p_store_id;
  delete from private.login_failures where store_id = p_store_id;
  return v_pin;
end $$;

-- دخول المدير للوحة التاجر للمساعدة (جلسة قصيرة ساعتين)
create or replace function public.admin_open_merchant(p_store_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if not exists (select 1 from public.stores where id = p_store_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return private.new_session(p_store_id, interval '2 hours', true);
end $$;

-- ---------------------------------------------------------------------
-- 11) الصلاحيات (Grants)
-- ---------------------------------------------------------------------
revoke all on all tables    in schema private from public;
revoke all on all functions in schema private from public;
revoke all on public.stores, public.products, public.analytics_events from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables    in schema private from anon, authenticated';
    execute 'revoke all on all functions in schema private from anon, authenticated';
    execute 'revoke all on public.stores, public.products, public.analytics_events from anon, authenticated';
    execute 'grant select on public.stores, public.products to anon, authenticated';
    execute 'grant select on public.analytics_events to authenticated';  -- مقيدة بسياسة المدير

    execute 'revoke all on function public.get_store_public(text), public.log_event(uuid, text, numeric, jsonb),
      public.merchant_login(text, text), public.merchant_logout(text), public.merchant_get_dashboard(text),
      public.merchant_update_store(text, jsonb), public.merchant_save_product(text, jsonb),
      public.merchant_quick_update(text, uuid, boolean, numeric), public.merchant_delete_product(text, uuid),
      public.merchant_import_products(text, jsonb), public.merchant_change_pin(text, text, text),
      public.service_verify_merchant(text), public.service_consume_vision(uuid, int),
      public.service_refund_vision(uuid), public.service_rate_limit(text, text, int, int),
      public.is_admin(), public.admin_list_stores(), public.admin_create_store(jsonb),
      public.admin_update_store(uuid, jsonb), public.admin_extend_store(uuid, int),
      public.admin_set_active(uuid, boolean), public.admin_reset_pin(uuid, text),
      public.admin_open_merchant(uuid) from public, anon, authenticated';

    -- الزوار والتجار (التاجر يستخدم مفتاح anon + رمز الجلسة)
    execute 'grant execute on function public.get_store_public(text), public.log_event(uuid, text, numeric, jsonb),
      public.merchant_login(text, text), public.merchant_logout(text), public.merchant_get_dashboard(text),
      public.merchant_update_store(text, jsonb), public.merchant_save_product(text, jsonb),
      public.merchant_quick_update(text, uuid, boolean, numeric), public.merchant_delete_product(text, uuid),
      public.merchant_import_products(text, jsonb), public.merchant_change_pin(text, text, text)
      to anon, authenticated';

    -- المدير العام (تتحقق الدوال داخلياً من private.admins)
    execute 'grant execute on function public.is_admin(), public.admin_list_stores(), public.admin_create_store(jsonb),
      public.admin_update_store(uuid, jsonb), public.admin_extend_store(uuid, int),
      public.admin_set_active(uuid, boolean), public.admin_reset_pin(uuid, text),
      public.admin_open_merchant(uuid) to authenticated';

    -- Edge Functions فقط
    execute 'grant execute on function public.service_verify_merchant(text), public.service_consume_vision(uuid, int),
      public.service_refund_vision(uuid), public.service_rate_limit(text, text, int, int) to service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 12) Realtime: أي تعديل من التاجر يحدّث stores.updated_at فيصل الحدث للمنيو العام
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stores') then
    execute 'alter publication supabase_realtime add table public.stores';
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 13) Storage: صور فقط (JPEG / PNG / WebP) بحد أقصى 2MB
--     الرفع يتم حصرياً عبر روابط موقّعة تصدرها Edge Function (sign-upload)
--     بعد التحقق من جلسة التاجر، لذلك لا توجد أي سياسة INSERT للزوار.
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('media', 'media', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update set
      public = true, file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];
  end if;
end $$;

-- =====================================================================
-- بعد التشغيل: أنشئ حساب المدير من Authentication > Users ثم نفّذ:
--   insert into private.admins (user_id)
--   select id from auth.users where email = 'admin@example.com';
-- =====================================================================
