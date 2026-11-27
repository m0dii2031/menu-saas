-- =====================================================================
--  الإصدار 2: سجل الطلبات وحالاتها، الكوبونات، مناطق التوصيل والحد الأدنى،
--  أوقات عمل لكل يوم (فترتين)، المخزون، ترتيب الأصناف، أيام الحجز المحجوزة،
--  سجل عمليات الإدارة، حذف المتجر، التحقق بخطوتين للمدير، إحصائيات تفصيلية.
--  يُشغَّل بعد 20261126000000_init.sql — آمن لإعادة التشغيل.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) أعمدة جديدة
-- ---------------------------------------------------------------------
alter table public.stores add column if not exists min_order numeric(10,2) not null default 0;
alter table public.stores add column if not exists delivery_zones jsonb not null default '[]'::jsonb;
alter table public.stores add column if not exists hours_json jsonb;

do $$ begin
  alter table public.stores add constraint stores_min_order_chk check (min_order between 0 and 100000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.stores add constraint stores_zones_chk
    check (jsonb_typeof(delivery_zones) = 'array' and jsonb_array_length(delivery_zones) <= 60 and pg_column_size(delivery_zones) <= 8000);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table public.stores add constraint stores_hours_chk
    check (hours_json is null or (jsonb_typeof(hours_json) = 'object' and pg_column_size(hours_json) <= 4000));
exception when duplicate_object then null; end $$;

alter table public.products add column if not exists stock integer;
do $$ begin
  alter table public.products add constraint products_stock_chk check (stock is null or stock between 0 and 1000000);
exception when duplicate_object then null; end $$;

-- رقم الطلب + بيانات الطلب (للتاجر فقط عبر RPC)
alter table public.analytics_events add column if not exists order_no integer;
alter table public.analytics_events add column if not exists meta jsonb;
do $$ begin
  alter table public.analytics_events add constraint analytics_meta_chk
    check (meta is null or (event_type = 'order_click' and jsonb_typeof(meta) = 'object' and pg_column_size(meta) <= 4000));
exception when duplicate_object then null; end $$;
create index if not exists analytics_orders_idx on public.analytics_events (store_id, id desc) where event_type = 'order_click';

-- ---------------------------------------------------------------------
-- 2) جداول خاصة جديدة
-- ---------------------------------------------------------------------
create table if not exists private.order_status (
  event_id    bigint primary key references public.analytics_events(id) on delete cascade,
  store_id    uuid not null references public.stores(id) on delete cascade,
  status      text not null default 'new' check (status in ('new','confirmed','done','cancelled')),
  restocked   boolean not null default false,
  updated_at  timestamptz not null default now()
);

create table if not exists private.coupons (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  code        text not null check (code ~ '^[A-Z0-9_-]{3,20}$'),
  kind        text not null check (kind in ('percent','fixed')),
  value       numeric(10,2) not null check (value > 0 and value <= 100000),
  min_order   numeric(10,2) not null default 0 check (min_order between 0 and 100000),
  max_uses    integer check (max_uses is null or max_uses between 1 and 1000000),
  used        integer not null default 0,
  expires_at  timestamptz,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (store_id, code),
  constraint coupon_percent_chk check (kind <> 'percent' or value <= 90)
);

create table if not exists private.audit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor     uuid,
  action    text not null,
  store_id  uuid,
  details   jsonb
);
create index if not exists audit_log_at_idx on private.audit_log (at desc);

-- ---------------------------------------------------------------------
-- 3) تنظيف المدخلات الجديدة
-- ---------------------------------------------------------------------
create or replace function private.clean_zones(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce((
    select jsonb_agg(jsonb_build_object('name', n, 'fee', f))
    from (
      select private.clean_line(e->>'name', 40) n, coalesce(private.to_num(e->>'fee', 10000), 0) f
      from jsonb_array_elements(case when jsonb_typeof(p) = 'array' then p else '[]'::jsonb end) e
      where jsonb_typeof(e) = 'object'
      limit 60
    ) z where n is not null
  ), '[]'::jsonb)
$$;

-- {"0":[{"o":"16:00","c":"02:00"}], ...} حيث 0 = الأحد. مفتاح غير موجود = مغلق ذلك اليوم
create or replace function private.clean_hours(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  d int;
  shifts jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return null; end if;
  for d in 0..6 loop
    if jsonb_typeof(p->(d::text)) = 'array' then
      select coalesce(jsonb_agg(jsonb_build_object('o', e->>'o', 'c', e->>'c')), '[]'::jsonb) into shifts
      from (select e from jsonb_array_elements(p->(d::text)) e
            where e->>'o' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' and e->>'c' ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            limit 2) s;
      if jsonb_array_length(shifts) > 0 then v := v || jsonb_build_object(d::text, shifts); end if;
    end if;
  end loop;
  return v;
end $$;

-- خيارات الصنف: يضاف السعر قبل الخصم (old_price) والأيام المحجوزة (blocked_dates)
create or replace function private.clean_options(p jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := '{}'::jsonb;
  v_unit text;
  v_old numeric;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return v; end if;

  if jsonb_typeof(p->'sizes') = 'array' then
    v := v || jsonb_build_object('sizes', coalesce((
      select jsonb_agg(jsonb_build_object('name', private.clean_line(e->>'name', 40), 'price', coalesce(private.to_num(e->>'price'), 0)))
      from (select e from jsonb_array_elements(p->'sizes') e
            where jsonb_typeof(e) = 'object' and private.clean_line(e->>'name', 40) is not null limit 20) s), '[]'::jsonb));
  end if;
  if jsonb_typeof(p->'addons') = 'array' then
    v := v || jsonb_build_object('addons', coalesce((
      select jsonb_agg(jsonb_build_object('name', private.clean_line(e->>'name', 40), 'price', coalesce(private.to_num(e->>'price'), 0)))
      from (select e from jsonb_array_elements(p->'addons') e
            where jsonb_typeof(e) = 'object' and private.clean_line(e->>'name', 40) is not null limit 30) s), '[]'::jsonb));
  end if;
  if jsonb_typeof(p->'specs') = 'array' then
    v := v || jsonb_build_object('specs', coalesce((
      select jsonb_agg(jsonb_build_object('label', private.clean_line(e->>'label', 40), 'value', coalesce(private.clean_line(e->>'value', 120), '')))
      from (select e from jsonb_array_elements(p->'specs') e
            where jsonb_typeof(e) = 'object' and private.clean_line(e->>'label', 40) is not null limit 20) s), '[]'::jsonb));
  end if;
  v_unit := private.clean_line(p->>'unit', 20);
  if v_unit in ('ليلة','يوم','ساعة','شهر','جلسة','سهم') then
    v := v || jsonb_build_object('unit', v_unit);
  end if;
  v_old := private.to_num(p->>'old_price');
  if v_old is not null and v_old > 0 then
    v := v || jsonb_build_object('old_price', v_old);
  end if;
  if jsonb_typeof(p->'blocked_dates') = 'array' then
    v := v || jsonb_build_object('blocked_dates', coalesce((
      select jsonb_agg(d order by d) from (
        select distinct e #>> '{}' d from jsonb_array_elements(p->'blocked_dates') e
        where jsonb_typeof(e) = 'string' and (e #>> '{}') ~ '^20[0-9]{2}-[01][0-9]-[0-3][0-9]$'
        limit 400) x), '[]'::jsonb));
  end if;
  return v;
end $$;

create or replace function private.clean_meta(p jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case when p is null or jsonb_typeof(p) <> 'object' then null else jsonb_strip_nulls(jsonb_build_object(
    'mode',     private.clean_line(p->>'mode', 20),
    'name',     private.clean_line(p->>'name', 60),
    'phone',    private.clean_line(p->>'phone', 20),
    'type',     private.clean_line(p->>'type', 20),
    'district', private.clean_line(p->>'district', 60),
    'address',  private.clean_line(p->>'address', 160),
    'gps',      private.clean_url(p->>'gps'),
    'pay',      private.clean_line(p->>'pay', 40),
    'note',     private.clean_text(p->>'note', 600),
    'coupon',   private.clean_line(p->>'coupon', 20),
    'discount', private.to_num(p->>'discount'),
    'fee',      private.to_num(p->>'fee'),
    'date',     private.clean_line(p->>'date', 40),
    'kind',     private.clean_line(p->>'kind', 40)
  )) end
$$;

-- ---------------------------------------------------------------------
-- 4) المدير: التحقق بخطوتين + سجل العمليات
-- ---------------------------------------------------------------------
-- إذا فعّل المدير التحقق بخطوتين (TOTP) في Supabase Auth نشترط جلسة aal2
create or replace function private.admin_mfa_state()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := exists (select 1 from private.admins where user_id = auth.uid());
  v_has_factor boolean := false;
  v_aal text := coalesce(auth.jwt()->>'aal', 'aal1');
begin
  if v_admin and to_regclass('auth.mfa_factors') is not null then
    execute 'select exists (select 1 from auth.mfa_factors where user_id = $1 and status = ''verified'')'
      into v_has_factor using auth.uid();
  end if;
  return jsonb_build_object('admin', v_admin, 'mfa_enrolled', v_has_factor, 'aal', v_aal,
                            'ok', v_admin and (not v_has_factor or v_aal = 'aal2'));
end $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((private.admin_mfa_state()->>'ok')::boolean, false)
$$;

create or replace function public.admin_status()
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.admin_mfa_state()
$$;

create or replace function private.audit(p_action text, p_store_id uuid, p_details jsonb default null)
returns void language sql volatile security definer set search_path = '' as $$
  insert into private.audit_log (actor, action, store_id, details) values (auth.uid(), p_action, p_store_id, p_details)
$$;

-- ---------------------------------------------------------------------
-- 5) RPC عامة
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
      'hours_json', s.hours_json, 'timezone', s.timezone, 'iban_number', s.iban_number,
      'min_order', s.min_order, 'delivery_zones', s.delivery_zones,
      'has_coupons', exists (select 1 from private.coupons c where c.store_id = s.id and c.active
                             and (c.expires_at is null or c.expires_at > now())
                             and (c.max_uses is null or c.used < c.max_uses)),
      'banner_active', s.banner_active and (s.banner_expires_at is null or s.banner_expires_at > now()),
      'banner_image_url', s.banner_image_url, 'banner_text', s.banner_text,
      'banner_expires_at', s.banner_expires_at, 'updated_at', s.updated_at),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'category', p.category, 'name', p.name, 'description', p.description,
               'price', p.price, 'image_url', p.image_url, 'gallery_json', p.gallery_json,
               'options_json', p.options_json, 'stock', p.stock,
               'is_available', p.is_available and (p.stock is null or p.stock > 0))
             order by p.sort_order, p.created_at)
      from public.products p where p.store_id = s.id), '[]'::jsonb));
end $$;

-- التحقق من كوبون (مع حد لمحاولات التخمين)
create or replace function public.apply_coupon(p_store_id uuid, p_code text, p_subtotal numeric)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  c private.coupons;
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_sub numeric := greatest(0, coalesce(p_subtotal, 0));
  v_disc numeric;
begin
  if not private.rate_limit_ok('coupon', private.client_ip() || ':' || p_store_id, 15, interval '10 minutes') then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select * into c from private.coupons where store_id = p_store_id and code = v_code;
  if not found or not c.active then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if c.expires_at is not null and c.expires_at <= now() or (c.max_uses is not null and c.used >= c.max_uses) then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;
  if v_sub < c.min_order then
    return jsonb_build_object('ok', false, 'error', 'min_order', 'min_order', c.min_order);
  end if;
  v_disc := case when c.kind = 'percent' then round(v_sub * c.value / 100, 2) else least(c.value, v_sub) end;
  return jsonb_build_object('ok', true, 'code', c.code, 'kind', c.kind, 'value', c.value, 'min_order', c.min_order, 'discount', v_disc);
end $$;

-- تسجيل الحدث: يضاف رقم الطلب وبياناته، وخصم المخزون، واحتساب استخدام الكوبون
drop function if exists public.log_event(uuid, text, numeric, jsonb);
create or replace function public.log_event(
  p_store_id uuid, p_event_type text, p_order_total numeric default null, p_items jsonb default null, p_meta jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.stores;
  v_ip text := private.client_ip();
  v_seq int;
  v_meta jsonb := private.clean_meta(p_meta);
  v_items jsonb := case when jsonb_typeof(p_items) = 'array' and pg_column_size(p_items) <= 8000 then p_items else null end;
  v_id bigint;
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

  if not private.rate_limit_ok('order', v_ip || ':' || s.id, 5, interval '10 minutes')
     or not private.rate_limit_ok('order_ip', v_ip, 20, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into private.order_counters as c (store_id, seq) values (s.id, 1001)
  on conflict (store_id) do update set seq = c.seq + 1
  returning seq into v_seq;

  insert into public.analytics_events (store_id, event_type, order_total, items_json, order_no, meta)
  values (s.id, 'order_click',
          case when p_order_total is null then null else round(greatest(0, least(p_order_total, 10000000)), 2) end,
          v_items, v_seq, v_meta)
  returning id into v_id;

  insert into private.order_status (event_id, store_id) values (v_id, s.id);

  -- خصم المخزون للأصناف المحدودة
  if v_items is not null then
    update public.products p set stock = greatest(0, p.stock - x.q), updated_at = now()
    from (select (e->>'id')::uuid id, sum(greatest(1, least(99, coalesce((e->>'q')::int, 1)))) q
          from jsonb_array_elements(v_items) e
          where e->>'id' ~ '^[0-9a-f-]{36}$' group by 1) x
    where p.id = x.id and p.store_id = s.id and p.stock is not null;
    if found then perform private.touch_store(s.id); end if;
  end if;

  -- احتساب استخدام الكوبون
  if v_meta ? 'coupon' then
    update private.coupons set used = used + 1 where store_id = s.id and code = upper(v_meta->>'coupon');
  end if;

  return jsonb_build_object('ok', true, 'order_no', v_seq);
end $$;

-- ---------------------------------------------------------------------
-- 6) RPC التاجر
-- ---------------------------------------------------------------------
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
    min_order            = case when p ? 'min_order' then coalesce(private.to_num(p->>'min_order', 100000), 0) else min_order end,
    delivery_zones       = case when p ? 'delivery_zones' then private.clean_zones(p->'delivery_zones') else delivery_zones end,
    hours_json           = case when p ? 'hours_json' then private.clean_hours(p->'hours_json') else hours_json end,
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
  v_stock int := case when nullif(p->>'stock', '') is null then null
                      when (p->>'stock') ~ '^[0-9]{1,7}$' then least((p->>'stock')::int, 1000000) else null end;
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
      stock        = v_stock,
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
                                 gallery_json, options_json, is_available, stock, sort_order)
    values (v_store, coalesce(private.clean_line(p->>'category', 60), ''), v_name,
            private.clean_text(p->>'description', 1000), v_price, private.clean_url(p->>'image_url'),
            private.clean_gallery(p->'gallery_json'), private.clean_options(p->'options_json'),
            coalesce((p->>'is_available')::boolean, true), v_stock,
            coalesce((p->>'sort_order')::int,
                     (select coalesce(max(sort_order), 0) + 1 from public.products where store_id = v_store)))
    returning * into v_row;
  end if;

  perform private.touch_store(v_store);
  return to_jsonb(v_row);
end $$;

-- ترتيب الأصناف: المصفوفة بالترتيب المطلوب
create or replace function public.merchant_reorder_products(p_token text, p_ids uuid[])
returns integer language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  v_count int;
begin
  if p_ids is null or array_length(p_ids, 1) > 500 then
    raise exception 'invalid_items' using errcode = '22023';
  end if;
  update public.products p set sort_order = x.ord, updated_at = now()
  from unnest(p_ids) with ordinality as x(id, ord)
  where p.id = x.id and p.store_id = v_store;
  get diagnostics v_count = row_count;
  perform private.touch_store(v_store);
  return v_count;
end $$;

-- سجل الطلبات
create or replace function public.merchant_list_orders(
  p_token text, p_status text default null, p_limit int default 50, p_before bigint default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid := private.merchant_auth(p_token);
begin
  return jsonb_build_object(
    'orders', coalesce((
      select jsonb_agg(o order by (o->>'id')::bigint desc) from (
        select jsonb_build_object('id', e.id, 'order_no', e.order_no, 'created_at', e.created_at,
                                  'total', e.order_total, 'items', e.items_json, 'meta', e.meta,
                                  'status', coalesce(st.status, 'new')) o
        from public.analytics_events e
        left join private.order_status st on st.event_id = e.id
        where e.store_id = v_store and e.event_type = 'order_click'
          and (p_before is null or e.id < p_before)
          and (p_status is null or coalesce(st.status, 'new') = p_status)
        order by e.id desc
        limit least(greatest(coalesce(p_limit, 50), 1), 100)
      ) x), '[]'::jsonb),
    'counts', (
      select jsonb_build_object(
        'new',       count(*) filter (where coalesce(st.status, 'new') = 'new'),
        'confirmed', count(*) filter (where st.status = 'confirmed'),
        'done',      count(*) filter (where st.status = 'done'),
        'cancelled', count(*) filter (where st.status = 'cancelled'))
      from public.analytics_events e left join private.order_status st on st.event_id = e.id
      where e.store_id = v_store and e.event_type = 'order_click' and e.created_at > now() - interval '90 days'));
end $$;

create or replace function public.merchant_set_order_status(p_token text, p_event_id bigint, p_status text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  e public.analytics_events;
  st private.order_status;
begin
  if p_status not in ('new','confirmed','done','cancelled') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  select * into e from public.analytics_events where id = p_event_id and store_id = v_store and event_type = 'order_click';
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;

  insert into private.order_status (event_id, store_id) values (e.id, v_store) on conflict (event_id) do nothing;
  select * into st from private.order_status where event_id = e.id for update;

  -- إرجاع المخزون عند الإلغاء (مرة واحدة)
  if p_status = 'cancelled' and not st.restocked and e.items_json is not null then
    update public.products p set stock = least(1000000, p.stock + x.q), updated_at = now()
    from (select (i->>'id')::uuid id, sum(greatest(1, least(99, coalesce((i->>'q')::int, 1)))) q
          from jsonb_array_elements(e.items_json) i where i->>'id' ~ '^[0-9a-f-]{36}$' group by 1) x
    where p.id = x.id and p.store_id = v_store and p.stock is not null;
    update private.order_status set restocked = true where event_id = e.id;
    perform private.touch_store(v_store);
  end if;

  update private.order_status set status = p_status, updated_at = now() where event_id = e.id;
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;

-- إحصائيات تفصيلية: يومية + أكثر الأصناف + توزيع الساعات
create or replace function public.merchant_stats_detail(p_token text, p_days int default 14)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  v_tz text := (select timezone from public.stores where id = v_store);
  v_days int := least(greatest(coalesce(p_days, 14), 7), 90);
  v_since timestamptz := date_trunc('day', now() at time zone v_tz) at time zone v_tz - make_interval(days => v_days - 1);
begin
  return jsonb_build_object(
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object('d', to_char(d, 'YYYY-MM-DD'),
               'views', coalesce(x.views, 0), 'orders', coalesce(x.orders, 0), 'revenue', coalesce(x.revenue, 0)) order by d), '[]'::jsonb)
      from generate_series((v_since at time zone v_tz)::date, (now() at time zone v_tz)::date, interval '1 day') d
      left join (
        select (created_at at time zone v_tz)::date dd,
               count(*) filter (where event_type = 'view') views,
               count(*) filter (where event_type = 'order_click') orders,
               coalesce(sum(order_total) filter (where event_type = 'order_click'), 0) revenue
        from public.analytics_events e
        left join private.order_status st on st.event_id = e.id
        where e.store_id = v_store and e.created_at >= v_since and coalesce(st.status, 'new') <> 'cancelled'
        group by 1) x on x.dd = d::date),
    'top_items', (
      select coalesce(jsonb_agg(t order by (t->>'qty')::int desc), '[]'::jsonb) from (
        select jsonb_build_object('name', i->>'n', 'qty', sum(coalesce((i->>'q')::int, 1)), 'revenue', sum(coalesce((i->>'t')::numeric, 0))) t
        from public.analytics_events e
        left join private.order_status st on st.event_id = e.id
        cross join lateral jsonb_array_elements(coalesce(e.items_json, '[]'::jsonb)) i
        where e.store_id = v_store and e.event_type = 'order_click' and e.created_at >= v_since
          and coalesce(st.status, 'new') <> 'cancelled' and i->>'n' is not null
        group by i->>'n' order by sum(coalesce((i->>'q')::int, 1)) desc limit 8) y),
    'hours', (
      select jsonb_agg(coalesce(c, 0) order by h) from generate_series(0, 23) h
      left join (select extract(hour from created_at at time zone v_tz)::int hh, count(*) c
                 from public.analytics_events where store_id = v_store and event_type = 'order_click' and created_at >= v_since
                 group by 1) z on z.hh = h));
end $$;

-- الكوبونات
create or replace function public.merchant_list_coupons(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(c) - 'store_id' order by c.created_at desc), '[]'::jsonb)
  from private.coupons c where c.store_id = private.merchant_auth(p_token)
$$;

create or replace function public.merchant_save_coupon(p_token text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_store uuid := private.merchant_auth(p_token);
  v_code text := upper(regexp_replace(coalesce(p->>'code', ''), '[^A-Za-z0-9_-]', '', 'g'));
  v_kind text := case when p->>'kind' = 'fixed' then 'fixed' else 'percent' end;
  v_value numeric := private.to_num(p->>'value', 100000);
  v_row private.coupons;
begin
  if v_code !~ '^[A-Z0-9_-]{3,20}$' then raise exception 'invalid_code' using errcode = '22023'; end if;
  if v_value is null or v_value <= 0 or (v_kind = 'percent' and v_value > 90) then
    raise exception 'invalid_value' using errcode = '22023';
  end if;
  if nullif(p->>'id', '') is null and (select count(*) from private.coupons where store_id = v_store) >= 50 then
    raise exception 'limit_reached' using errcode = '54000';
  end if;
  insert into private.coupons as c (id, store_id, code, kind, value, min_order, max_uses, expires_at, active)
  values (coalesce(nullif(p->>'id', '')::uuid, gen_random_uuid()), v_store, v_code, v_kind, v_value,
          coalesce(private.to_num(p->>'min_order', 100000), 0),
          case when (p->>'max_uses') ~ '^[0-9]{1,7}$' and (p->>'max_uses')::int > 0 then (p->>'max_uses')::int end,
          nullif(p->>'expires_at', '')::timestamptz, coalesce((p->>'active')::boolean, true))
  on conflict (id) do update set code = excluded.code, kind = excluded.kind, value = excluded.value,
    min_order = excluded.min_order, max_uses = excluded.max_uses, expires_at = excluded.expires_at, active = excluded.active
  where c.store_id = v_store
  returning * into v_row;
  if v_row.id is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.touch_store(v_store);
  return to_jsonb(v_row) - 'store_id';
exception when unique_violation then
  raise exception 'code_taken' using errcode = '23505';
end $$;

create or replace function public.merchant_delete_coupon(p_token text, p_id uuid)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_store uuid := private.merchant_auth(p_token);
begin
  delete from private.coupons where id = p_id and store_id = v_store;
  perform private.touch_store(v_store);
  return found;
end $$;

-- ---------------------------------------------------------------------
-- 7) RPC الإدارة: سجل العمليات + الحذف
-- ---------------------------------------------------------------------
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
  if v_pin !~ '^[0-9]{4,8}$' then raise exception 'invalid_pin' using errcode = '22023'; end if;
  if v_days not between 1 and 3660 then raise exception 'invalid_days' using errcode = '22023'; end if;
  if exists (select 1 from public.stores where slug = v_slug) then raise exception 'slug_taken' using errcode = '23505'; end if;

  insert into public.stores (slug, name, whatsapp_phone, theme_style, business_mode, business_type, expires_at)
  values (v_slug, private.clean_line(p->>'name', 80), private.norm_phone(p->>'whatsapp_phone'),
          coalesce(nullif(p->>'theme_style', ''), 'theme-general'), coalesce(nullif(p->>'business_mode', ''), 'order'),
          private.clean_line(p->>'business_type', 60), now() + make_interval(days => v_days))
  returning * into v_row;
  insert into private.store_secrets (store_id, pin_hash) values (v_row.id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)));
  perform private.audit('create_store', v_row.id, jsonb_build_object('slug', v_row.slug, 'name', v_row.name, 'days', v_days));
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
  perform private.audit('update_store', p_store_id, p);
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_extend_store(p_store_id uuid, p_days int default 30)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.stores;
begin
  perform private.require_admin();
  if p_days not between 1 and 3660 then raise exception 'invalid_days' using errcode = '22023'; end if;
  update public.stores set expires_at = greatest(expires_at, now()) + make_interval(days => p_days), updated_at = now()
  where id = p_store_id returning * into v_row;
  perform private.audit('extend', p_store_id, jsonb_build_object('days', p_days, 'expires_at', v_row.expires_at));
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_set_active(p_store_id uuid, p_active boolean)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_row public.stores;
begin
  perform private.require_admin();
  update public.stores set is_active = p_active, updated_at = now() where id = p_store_id returning * into v_row;
  perform private.audit(case when p_active then 'activate' else 'suspend' end, p_store_id, null);
  return to_jsonb(v_row);
end $$;

create or replace function public.admin_reset_pin(p_store_id uuid, p_pin text default null)
returns text language plpgsql volatile security definer set search_path = '' as $$
declare v_pin text := coalesce(nullif(btrim(coalesce(p_pin, '')), ''), private.random_pin());
begin
  perform private.require_admin();
  if v_pin !~ '^[0-9]{4,8}$' then raise exception 'invalid_pin' using errcode = '22023'; end if;
  insert into private.store_secrets (store_id, pin_hash) values (p_store_id, extensions.crypt(v_pin, extensions.gen_salt('bf', 10)))
  on conflict (store_id) do update set pin_hash = excluded.pin_hash;
  delete from private.merchant_sessions where store_id = p_store_id;
  delete from private.login_failures where store_id = p_store_id;
  perform private.audit('reset_pin', p_store_id, null);
  return v_pin;
end $$;

create or replace function public.admin_open_merchant(p_store_id uuid)
returns text language plpgsql volatile security definer set search_path = '' as $$
begin
  perform private.require_admin();
  if not exists (select 1 from public.stores where id = p_store_id) then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.audit('open_merchant', p_store_id, null);
  return private.new_session(p_store_id, interval '2 hours', true);
end $$;

-- حذف نهائي: يشترط كتابة رابط المتجر للتأكيد
create or replace function public.admin_delete_store(p_store_id uuid, p_confirm_slug text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare s public.stores;
begin
  perform private.require_admin();
  select * into s from public.stores where id = p_store_id;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if lower(btrim(coalesce(p_confirm_slug, ''))) <> s.slug then
    raise exception 'confirm_mismatch' using errcode = '22023';
  end if;
  perform private.audit('delete_store', s.id, jsonb_build_object('slug', s.slug, 'name', s.name));
  delete from public.stores where id = s.id;
  return true;
end $$;

create or replace function public.admin_audit_log(p_limit int default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'action', a.action, 'store_id', a.store_id,
             'store_name', coalesce(s.name, a.details->>'name'), 'store_slug', coalesce(s.slug, a.details->>'slug'),
             'details', a.details) order by a.id desc)
    from (select * from private.audit_log order by id desc limit least(greatest(coalesce(p_limit, 100), 1), 500)) a
    left join public.stores s on s.id = a.store_id), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 8) خدمة تنظيف الصور (service_role فقط)
-- ---------------------------------------------------------------------
create or replace function public.service_media_refs()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct u), '[]'::jsonb) from (
    select logo_url u from public.stores union all
    select cover_url from public.stores union all
    select banner_image_url from public.stores union all
    select image_url from public.products union all
    select g #>> '{}' from public.products, jsonb_array_elements(gallery_json) g
  ) x where u is not null
$$;

create or replace function public.service_store_ids()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(id), '[]'::jsonb) from public.stores
$$;

-- ---------------------------------------------------------------------
-- 9) الصلاحيات
-- ---------------------------------------------------------------------
revoke all on all tables in schema private from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema private from anon, authenticated';
    execute 'revoke all on function public.log_event(uuid, text, numeric, jsonb, jsonb), public.apply_coupon(uuid, text, numeric),
      public.merchant_reorder_products(text, uuid[]), public.merchant_list_orders(text, text, int, bigint),
      public.merchant_set_order_status(text, bigint, text), public.merchant_stats_detail(text, int),
      public.merchant_list_coupons(text), public.merchant_save_coupon(text, jsonb), public.merchant_delete_coupon(text, uuid),
      public.admin_status(), public.admin_delete_store(uuid, text), public.admin_audit_log(int),
      public.service_media_refs(), public.service_store_ids() from public, anon, authenticated';
    execute 'grant execute on function public.log_event(uuid, text, numeric, jsonb, jsonb), public.apply_coupon(uuid, text, numeric),
      public.merchant_reorder_products(text, uuid[]), public.merchant_list_orders(text, text, int, bigint),
      public.merchant_set_order_status(text, bigint, text), public.merchant_stats_detail(text, int),
      public.merchant_list_coupons(text), public.merchant_save_coupon(text, jsonb), public.merchant_delete_coupon(text, uuid)
      to anon, authenticated';
    execute 'grant execute on function public.admin_status(), public.admin_delete_store(uuid, text), public.admin_audit_log(int) to authenticated';
    execute 'grant execute on function public.service_media_refs(), public.service_store_ids() to service_role';
  end if;
end $$;
