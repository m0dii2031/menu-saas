\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
insert into private.admins values ('11111111-1111-1111-1111-111111111111');
set role authenticated; set test.uid = '11111111-1111-1111-1111-111111111111';
select 'create', (public.admin_create_store('{"name":"مطعم","slug":"rest1","whatsapp_phone":"0501234567","pin":"1234"}')->'store'->>'slug');
reset role; reset test.uid;
select id as sid from stores where slug='rest1' \gset
select private.new_session(:'sid', interval '1 hour', false) as tok \gset
set role anon;
-- product with stock + old price + blocked dates
select public.merchant_save_product(:'tok', '{"name":"برجر","price":"20","stock":"3","options_json":{"old_price":"25","blocked_dates":["2026-12-01","2026-12-01","bad","2026-12-03"]}}')->>'stock' as stock;
select id as pid from public.products where name='برجر' \gset
select 'options', options_json from public.products where id=:'pid';
-- zones / min order / hours
select 'zones', (public.merchant_update_store(:'tok', '{"min_order":"30","delivery_zones":[{"name":"النرجس","fee":"10"},{"name":"","fee":5},{"name":"الملقا","fee":"abc"}],"hours_json":{"5":[{"o":"13:00","c":"23:00"}],"1":[{"o":"08:00","c":"12:00"},{"o":"16:00","c":"02:00"},{"o":"x","c":"y"}],"9":[{"o":"01:00","c":"02:00"}]}}')->'store') -> 'delivery_zones';
select 'hours', hours_json, 'min', min_order from public.stores where id=:'sid';
-- coupons
select 'coupon', public.merchant_save_coupon(:'tok', '{"code":"save10","kind":"percent","value":"10","min_order":"20"}')->>'code';
select 'bad pct'; select public.merchant_save_coupon(:'tok', '{"code":"BIG","kind":"percent","value":"95"}');
select 'dup'; select public.merchant_save_coupon(:'tok', '{"code":"SAVE10","kind":"fixed","value":"5"}');
select 'apply ok', public.apply_coupon(:'sid', 'save10', 50);
select 'apply min', public.apply_coupon(:'sid', 'SAVE10', 10);
select 'apply bad', public.apply_coupon(:'sid', 'NOPE', 50);
select 'public has_coupons', public.get_store_public('rest1')->'store'->'has_coupons', public.get_store_public('rest1')->'store'->'min_order';
-- order with stock decrement + coupon use
select 'order', public.log_event(:'sid','order_click', 54, json_build_array(json_build_object('id', :'pid', 'n','برجر','q',2,'t',40))::jsonb,
   '{"name":"محمد","phone":"0555","type":"delivery","district":"النرجس","coupon":"SAVE10","discount":"4","evil":"x"}');
select 'stock after', stock from public.products where id=:'pid';
select 'used', (public.merchant_list_coupons(:'tok')->0->>'used');
select 'orders', public.merchant_list_orders(:'tok')->'orders'->0->'meta', public.merchant_list_orders(:'tok')->'counts';
reset role;
select id as eid from public.analytics_events where event_type='order_click' limit 1 \gset
set role anon;
select 'cancel', public.merchant_set_order_status(:'tok', :'eid', 'cancelled');
select 'stock restored', stock from public.products where id=:'pid';
select 'cancel again (no double restock)', public.merchant_set_order_status(:'tok', :'eid', 'cancelled')->>'ok';
select 'stock still', stock from public.products where id=:'pid';
-- sold out hides
select public.log_event(:'sid','order_click', 60, json_build_array(json_build_object('id', :'pid', 'n','برجر','q',3,'t',60))::jsonb, null)->>'order_no';
select 'sold out public avail', public.get_store_public('rest1')->'products'->0->>'is_available', public.get_store_public('rest1')->'products'->0->>'stock';
select 'stats', jsonb_array_length(public.merchant_stats_detail(:'tok')->'daily'), public.merchant_stats_detail(:'tok')->'top_items';
-- reorder
select public.merchant_save_product(:'tok', '{"name":"بطاطس","price":"9"}') is not null;
select id as pid2 from public.products where name='بطاطس' \gset
select 'reorder', public.merchant_reorder_products(:'tok', array[:'pid2', :'pid']::uuid[]);
select 'order now', string_agg(name, ',' order by sort_order) from public.products;
-- other store's token cannot touch coupons/orders
select 'anon admin_delete'; select public.admin_delete_store(:'sid','rest1');
select 'anon private coupons'; select * from private.coupons;
reset role;
-- MFA: admin with verified factor but aal1 is blocked
insert into auth.mfa_factors (user_id, status) values ('11111111-1111-1111-1111-111111111111','verified');
set role authenticated; set test.uid = '11111111-1111-1111-1111-111111111111'; set test.jwt = '{"aal":"aal1"}';
select 'mfa status aal1', public.admin_status();
select 'list at aal1'; select public.admin_list_stores();
set test.jwt = '{"aal":"aal2"}';
select 'list at aal2', jsonb_array_length(public.admin_list_stores());
select 'delete wrong confirm'; select public.admin_delete_store(:'sid','nope');
select 'audit', string_agg(x->>'action', ',') from jsonb_array_elements(public.admin_audit_log()) x;
select 'delete ok', public.admin_delete_store(:'sid','rest1');
select 'audit after', (public.admin_audit_log()->0->>'action'), (public.admin_audit_log()->0->>'store_slug');
reset role;
select 'remaining stores', count(*) from stores; select 'remaining events', count(*) from analytics_events;
set role service_role;
select 'media refs', public.service_media_refs();
