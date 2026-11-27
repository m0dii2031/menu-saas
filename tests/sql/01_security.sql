\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
insert into private.admins values ('11111111-1111-1111-1111-111111111111');
-- admin creates stores
set role authenticated; set test.uid = '11111111-1111-1111-1111-111111111111';
select 'is_admin', public.is_admin();
select 'create', (public.admin_create_store('{"name":"مطعم الذوق","slug":"althawq","whatsapp_phone":"0501234567","theme_style":"theme-restaurant","business_mode":"order","days":30,"pin":"1234"}')->'store'->>'whatsapp_phone');
select 'create2', (public.admin_create_store('{"name":"شاليه","slug":"chalet-1","whatsapp_phone":"+966 55 000 1111","theme_style":"theme-chalet","business_mode":"booking"}')->>'pin') ~ '^\d{6}$';
select 'dup slug'; select public.admin_create_store('{"name":"x x","slug":"althawq","whatsapp_phone":"0501234567"}');
select 'list count', jsonb_array_length(public.admin_list_stores());
reset role; reset test.uid;
-- non-admin authenticated
set role authenticated; set test.uid = '22222222-2222-2222-2222-222222222222';
select 'nonadmin list'; select public.admin_list_stores();
reset role; reset test.uid;

set role anon;
select 'anon public status', public.get_store_public('althawq')->>'status';
select 'anon notfound', public.get_store_public('nope')->>'status';
select 'anon direct select', count(*) from public.stores;
select 'anon pin column?'; select pin_code from public.stores;
select 'anon secrets'; select * from private.store_secrets;
select 'anon insert product'; insert into public.products(store_id,name) select id,'hack' from public.stores limit 1;
select 'anon update store'; update public.stores set name='hacked';
select 'anon analytics select'; select * from public.analytics_events;
select 'anon admin rpc'; select public.admin_list_stores();
select 'anon service rpc'; select public.service_consume_vision(gen_random_uuid());
-- login
select 'bad pin', public.merchant_login('althawq','0000')->>'error';
select 'good pin ok', (public.merchant_login('althawq','1234')->>'ok');
reset role;
-- capture token
select public.merchant_login('althawq','1234')->>'token' as tok \gset
set role anon;
select 'dash', jsonb_array_length(public.merchant_get_dashboard(:'tok')->'products');
select 'bad token'; select public.merchant_get_dashboard(repeat('a',64));
select 'save', public.merchant_save_product(:'tok', '{"name":"برجر <script>","category":"وجبات","price":"25.5","options_json":{"sizes":[{"name":"صغير","price":20},{"name":"كبير","price":"30"},{"name":"","price":1}],"addons":[{"name":"جبن","price":3}],"evil":1},"gallery_json":["https://x.com/a.jpg","javascript:alert(1)"],"image_url":"javascript:alert(1)"}') - 'id' - 'store_id' - 'created_at' - 'updated_at';
select id as pid from public.products limit 1 \gset
select 'quick', public.merchant_quick_update(:'tok', :'pid', false, 19.99)->>'price';
select 'import', public.merchant_import_products(:'tok', '[{"name":"شاي","price":"3","category":"مشروبات","sizes":[{"name":"كوب","price":3}]},{"name":""},{"name":"قهوة","price":"abc"}]');
select 'update store', (public.merchant_update_store(:'tok', '{"whatsapp_phone":"٠٥٥١٢٣٤٥٦٧","iban_number":"sa03 8000 0000 6080 1016 7519","open_time":"16:00","close_time":"02:00","banner_active":true,"banner_text":"خصم 20%","is_active":false,"expires_at":"2099-01-01"}')->'store') - 'id' - 'created_at' - 'updated_at' - 'expires_at';
select 'bad iban'; select public.merchant_update_store(:'tok', '{"iban_number":"XX"}');
select 'bad theme'; select public.merchant_update_store(:'tok', '{"theme_style":"evil"}');
select 'store id' ; select id as sid from public.stores where slug='althawq' \gset
select 'view', public.log_event(:'sid','view');
select 'orders', string_agg(public.log_event(:'sid','order_click', 50, '[{"n":"x","q":1}]')::text, ' | ') from generate_series(1,6);
select 'bad event'; select public.log_event(:'sid','purchase');
select 'change pin', public.merchant_change_pin(:'tok','1234','5678');
select 'login old pin', public.merchant_login('althawq','1234')->>'error';
reset role;
select 'stats', public.merchant_get_dashboard(:'tok')->'stats';
-- lockout test on chalet
set role anon;
select 'lock', string_agg(public.merchant_login('chalet-1','9999')->>'error', ',') from generate_series(1,6);
reset role;
-- analytics append-only
select 'update analytics'; update public.analytics_events set order_total = 0;
select 'delete analytics'; delete from public.analytics_events;
-- vision quota
select 'vision', string_agg(public.service_consume_vision(:'sid')::text, ',') from generate_series(1,6);
-- expiry
update public.stores set expires_at = now() - interval '1 day' where slug='althawq';
set role anon;
select 'expired status', public.get_store_public('althawq')->>'status';
select 'expired direct rows', count(*) from public.stores where slug='althawq';
select 'expired products', count(*) from public.products;
reset role;
-- extend as admin
set role authenticated; set test.uid = '11111111-1111-1111-1111-111111111111';
select 'extend', (public.admin_extend_store(:'sid', 30)->>'expires_at')::timestamptz > now() + interval '29 days';
select 'impersonate token len', length(public.admin_open_merchant(:'sid'));
reset role; reset test.uid;
-- cascade delete works
delete from public.stores where slug='althawq';
select 'after delete analytics', count(*) from public.analytics_events;
