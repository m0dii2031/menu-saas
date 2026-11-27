-- =====================================================================
-- v3: سلامة الطلبات — الخادم هو من يحسب السعر
--
-- المشكلة: رسالة واتساب الجاهزة (wa.me?text=) يستطيع العميل تعديلها قبل الإرسال،
-- وكان الخادم يحفظ الإجمالي الذي يرسله المتصفح كما هو.
-- الحل:
--   1) log_event يعيد حساب كل سطر من أسعار المنتجات في قاعدة البيانات (الحجم + الإضافات + الكمية)
--      + رسوم التوصيل من إعدادات المتجر + الكوبون، ويتجاهل أي سعر قادم من المتصفح.
--   2) لكل طلب «رمز تحقق» عشوائي يُطبع في الرسالة ويظهر في سجل التاجر.
--   3) التاجر يطابق رقم الطلب + رمز التحقق + الإجمالي في لوحته (merchant_find_order).
-- آمن لإعادة التشغيل.
-- =====================================================================

-- رمز تحقق من 4 خانات بدون الأحرف المتشابهة (0/O، 1/I/L)
create or replace function private.verify_code()
returns text language sql volatile set search_path = '' as $$
  select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', 1 + (get_byte(b, i) % 31), 1), '' order by i)
  from (select extensions.gen_random_bytes(4) b) x, generate_series(0, 3) i
$$;

-- تسعير الطلب من قاعدة البيانات
-- items: [{id, s: اسم الحجم, a: [أسماء الإضافات], q}] ← تُهمل أي أسعار قادمة من المتصفح
create or replace function private.price_order(s public.stores, p_items jsonb, p_meta jsonb, p_client_total numeric)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_mode text := coalesce(p_meta->>'mode', s.business_mode);
  e jsonb;
  p public.products;
  v_out jsonb := '[]'::jsonb;
  v_unit numeric; v_q int; v_line numeric; v_size text; v_addons jsonb; v_names jsonb;
  v_sub numeric := 0; v_fee numeric := 0; v_disc numeric := 0;
  v_unavailable int := 0;
  c private.coupons;
  v_code text;
  v_zone jsonb;
begin
  if jsonb_typeof(p_items) = 'array' then
    for e in select x from jsonb_array_elements(p_items) x limit 50 loop
      continue when jsonb_typeof(e) <> 'object';
      if coalesce(e->>'id', '') ~ '^[0-9a-f-]{36}$' then
        select * into p from public.products where id = (e->>'id')::uuid and store_id = s.id;
        if not found or not p.is_available then v_unavailable := v_unavailable + 1; continue; end if;
        v_q := greatest(1, least(case when v_mode = 'booking' then 365 else 99 end,
                                 coalesce(case when (e->>'q') ~ '^[0-9]{1,4}$' then (e->>'q')::int end, 1)));
        if p.stock is not null and p.stock < v_q then v_unavailable := v_unavailable + 1; continue; end if;
        -- الحجم: سعره يحل محل السعر الأساسي
        v_size := null; v_unit := p.price;
        if nullif(e->>'s', '') is not null then
          select z->>'name', (z->>'price')::numeric into v_size, v_unit
          from jsonb_array_elements(coalesce(p.options_json->'sizes', '[]'::jsonb)) z
          where z->>'name' = e->>'s' limit 1;
          if v_size is null then v_unit := p.price; end if;
        end if;
        -- الإضافات: فقط الموجودة فعلاً في الصنف، بأسعارها المحفوظة
        v_names := case when jsonb_typeof(e->'a') = 'array' then e->'a' else '[]'::jsonb end;
        select coalesce(jsonb_agg(jsonb_build_object('name', z->>'name', 'price', (z->>'price')::numeric)), '[]'::jsonb),
               v_unit + coalesce(sum((z->>'price')::numeric), 0)
          into v_addons, v_unit
        from jsonb_array_elements(coalesce(p.options_json->'addons', '[]'::jsonb)) z
        where v_names @> jsonb_build_array(z->>'name');
        v_line := round(greatest(v_unit, 0) * v_q, 2);
        v_sub := v_sub + v_line;
        v_out := v_out || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'id', p.id, 'n', left(p.name, 60), 's', v_size, 'q', v_q, 'u', v_unit, 't', v_line,
          'a', case when jsonb_array_length(v_addons) > 0 then v_addons end)));
      elsif v_mode = 'charity' then
        -- التبرع: المبلغ يحدده المتبرع نفسه
        v_line := round(greatest(0, least(coalesce(private.to_num(e->>'t'), 0), 1000000)), 2);
        v_sub := v_sub + v_line;
        v_out := v_out || jsonb_build_array(jsonb_build_object('n', coalesce(private.clean_line(e->>'n', 60), 'تبرع'), 'q', 1, 't', v_line));
      else
        -- بند بدون صنف (مثلاً استفسار عام): بدون سعر
        v_out := v_out || jsonb_build_array(jsonb_build_object('n', coalesce(private.clean_line(e->>'n', 60), '—'), 'q', 1, 't', 0));
      end if;
    end loop;
  end if;

  if v_mode = 'order' then
    -- رسوم التوصيل من إعدادات المتجر
    if p_meta->>'type' = 'delivery' then
      if jsonb_array_length(coalesce(s.delivery_zones, '[]'::jsonb)) > 0 then
        select z into v_zone from jsonb_array_elements(s.delivery_zones) z where z->>'name' = p_meta->>'district' limit 1;
        v_fee := coalesce((v_zone->>'fee')::numeric,
                          (select max((z->>'fee')::numeric) from jsonb_array_elements(s.delivery_zones) z), 0);
      else
        v_fee := coalesce(s.delivery_fee, 0);
      end if;
    end if;
    -- الكوبون: يُعاد التحقق منه بالكامل
    v_code := upper(nullif(btrim(coalesce(p_meta->>'coupon', '')), ''));
    if v_code is not null then
      select * into c from private.coupons where store_id = s.id and code = v_code;
      if found and c.active and (c.expires_at is null or c.expires_at > now())
         and (c.max_uses is null or c.used < c.max_uses) and v_sub >= c.min_order then
        v_disc := case when c.kind = 'percent' then round(v_sub * c.value / 100, 2) else least(c.value, v_sub) end;
      else
        v_code := null;
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'items', v_out, 'sub', round(v_sub, 2), 'fee', round(v_fee, 2), 'discount', round(v_disc, 2), 'coupon', v_code,
    'total', round(greatest(0, v_sub - v_disc) + v_fee, 2), 'unavailable', v_unavailable,
    'mismatch', p_client_total is not null and abs(p_client_total - (greatest(0, v_sub - v_disc) + v_fee)) > 0.01);
end $$;

create or replace function public.log_event(
  p_store_id uuid, p_event_type text, p_order_total numeric default null, p_items jsonb default null, p_meta jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.stores;
  v_ip text := private.client_ip();
  v_seq int;
  v_meta jsonb := coalesce(private.clean_meta(p_meta), '{}'::jsonb);
  v_price jsonb;
  v_code text := private.verify_code();
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

  if jsonb_typeof(p_items) is distinct from 'array' or pg_column_size(p_items) > 16000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_items');
  end if;
  v_price := private.price_order(s, p_items, v_meta, p_order_total);

  -- أصناف نفدت أو أُخفيت بعد إضافتها للسلة
  if (v_price->>'unavailable')::int > 0 then
    return jsonb_build_object('ok', false, 'error', 'items_changed');
  end if;
  if coalesce(v_meta->>'mode', s.business_mode) = 'order' then
    if jsonb_array_length(v_price->'items') = 0 then
      return jsonb_build_object('ok', false, 'error', 'invalid_items');
    end if;
    if v_meta->>'type' = 'delivery' and coalesce(s.min_order, 0) > 0 and (v_price->>'sub')::numeric < s.min_order then
      return jsonb_build_object('ok', false, 'error', 'min_order', 'min_order', s.min_order);
    end if;
  end if;

  if not private.rate_limit_ok('order', v_ip || ':' || s.id, 5, interval '10 minutes')
     or not private.rate_limit_ok('order_ip', v_ip, 20, interval '1 hour') then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  insert into private.order_counters as c (store_id, seq) values (s.id, 1001)
  on conflict (store_id) do update set seq = c.seq + 1
  returning seq into v_seq;

  -- القيم المحفوظة كلها من حساب الخادم؛ ما أرسله المتصفح يُحفظ للمقارنة فقط
  v_meta := (v_meta - 'fee' - 'discount' - 'coupon') || jsonb_strip_nulls(jsonb_build_object(
    'sub', (v_price->>'sub')::numeric, 'fee', (v_price->>'fee')::numeric,
    'discount', nullif((v_price->>'discount')::numeric, 0), 'coupon', v_price->>'coupon',
    'code', v_code, 'client_total', p_order_total,
    'mismatch', case when (v_price->>'mismatch')::boolean then true end));

  insert into public.analytics_events (store_id, event_type, order_total, items_json, order_no, meta)
  values (s.id, 'order_click', (v_price->>'total')::numeric, v_price->'items', v_seq, v_meta)
  returning id into v_id;

  insert into private.order_status (event_id, store_id) values (v_id, s.id);

  -- خصم المخزون للأصناف المحدودة
  update public.products p set stock = greatest(0, p.stock - x.q), updated_at = now()
  from (select (e->>'id')::uuid id, sum((e->>'q')::int) q
        from jsonb_array_elements(v_price->'items') e where e ? 'id' group by 1) x
  where p.id = x.id and p.store_id = s.id and p.stock is not null;
  if found then perform private.touch_store(s.id); end if;

  if v_price->>'coupon' is not null then
    update private.coupons set used = used + 1 where store_id = s.id and code = v_price->>'coupon';
  end if;

  return jsonb_build_object('ok', true, 'order_no', v_seq, 'code', v_code,
    'items', v_price->'items', 'sub', (v_price->>'sub')::numeric, 'fee', (v_price->>'fee')::numeric,
    'discount', (v_price->>'discount')::numeric, 'coupon', v_price->>'coupon', 'total', (v_price->>'total')::numeric);
end $$;

-- التاجر يتحقق من طلب برقمه (يطابقه مع الرسالة التي وصلته)
create or replace function public.merchant_find_order(p_token text, p_order_no int)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_store uuid := private.merchant_auth(p_token);
begin
  return (
    select jsonb_build_object('id', e.id, 'order_no', e.order_no, 'created_at', e.created_at,
                              'total', e.order_total, 'items', e.items_json, 'meta', e.meta,
                              'status', coalesce(st.status, 'new'))
    from public.analytics_events e
    left join private.order_status st on st.event_id = e.id
    where e.store_id = v_store and e.event_type = 'order_click' and e.order_no = p_order_no
    order by e.id desc limit 1);
end $$;

revoke all on function private.verify_code(), private.price_order(public.stores, jsonb, jsonb, numeric) from public;
revoke all on function public.merchant_find_order(text, int) from public;
grant execute on function public.merchant_find_order(text, int) to anon, authenticated;
grant execute on function public.log_event(uuid, text, numeric, jsonb, jsonb) to anon, authenticated;
