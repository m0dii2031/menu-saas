-- سلامة الطلبات: الخادم يتجاهل الأسعار القادمة من المتصفح ويحسبها بنفسه
\set ON_ERROR_STOP 0
\pset tuples_only on
\pset format unaligned
insert into private.admins values ('22222222-2222-2222-2222-222222222222') on conflict do nothing;
set role authenticated; set test.uid = '22222222-2222-2222-2222-222222222222';
select 'create', (public.admin_create_store('{"name":"برجر الشمال","slug":"north","whatsapp_phone":"0501234568","pin":"1234"}')->'store'->>'slug');
select 'create2', (public.admin_create_store('{"name":"متجر آخر","slug":"other","whatsapp_phone":"0501234569","pin":"1234"}')->'store'->>'slug');
reset role; reset test.uid;
select id as sid from stores where slug='north' \gset
select id as sid2 from stores where slug='other' \gset
select private.new_session(:'sid', interval '1 hour', false) as tok \gset
select private.new_session(:'sid2', interval '1 hour', false) as tok2 \gset
set role anon;
select public.merchant_update_store(:'tok', '{"delivery_fee":"10","min_order":"0"}') is not null;
select (public.merchant_save_product(:'tok', '{"name":"سلافثانسفا","price":"76","options_json":{"sizes":[{"name":"عادي","price":"76"},{"name":"كبير","price":"90"}],"addons":[{"name":"جبنة","price":"5"}]}}')->>'id') as pid \gset
select (public.merchant_save_product(:'tok', '{"name":"مخفي","price":"30","is_available":false}')->>'id') as hid \gset
select (public.merchant_save_product(:'tok2', '{"name":"صنف متجر آخر","price":"1"}')->>'id') as foreign_id \gset

-- 1) العميل يرسل أسعاراً مزيفة: سعر سطر 1 وإجمالي 12 (مثل الصورة) ← الخادم يحسب 76×2 + 10
select 'fake prices', r->>'total', r->>'sub', r->>'fee', r->'items'->0->>'t'
from (select public.log_event(:'sid','order_click', 12,
  json_build_array(json_build_object('id', :'pid', 'n','x','q',2,'t',1))::jsonb,
  '{"mode":"order","name":"ال","phone":"0565","type":"delivery","fee":"0"}') r) x;
reset role;
select 'saved total + mismatch flag', order_total, meta->>'mismatch', meta->>'client_total', length(meta->>'code')
from public.analytics_events where store_id = :'sid' and order_no = 1001;

set role anon;

-- 2) حجم وإضافة: السعر من قاعدة البيانات، والإضافة غير الموجودة تُهمل
select 'size+addon', r->>'total', r->'items'->0->>'u', r->'items'->0->'a'
from (select public.log_event(:'sid','order_click', 1,
  json_build_array(json_build_object('id', :'pid','s','كبير','a',json_build_array('جبنة','ذهب مجاني'),'q',1,'t',0))::jsonb,
  '{"mode":"order","name":"أ","phone":"0565","type":"pickup"}') r) x;

-- 3) حجم غير موجود ← السعر الأساسي
select 'unknown size', r->>'total' from (select public.log_event(:'sid','order_click', 1,
  json_build_array(json_build_object('id', :'pid','s','مجاني','q',1))::jsonb, '{"mode":"order","type":"pickup"}') r) x;

-- 4) صنف مخفي أو من متجر آخر ← يُرفض الطلب
select 'hidden item', public.log_event(:'sid','order_click', 1, json_build_array(json_build_object('id', :'hid','q',1))::jsonb, '{"mode":"order","type":"pickup"}')->>'error';
select 'foreign item', public.log_event(:'sid','order_click', 1, json_build_array(json_build_object('id', :'foreign_id','q',1))::jsonb, '{"mode":"order","type":"pickup"}')->>'error';

-- 5) كمية سالبة/ضخمة تُضبط، وطلب فارغ يُرفض
select 'qty clamp', r->'items'->0->>'q' from (select public.log_event(:'sid','order_click', 1,
  json_build_array(json_build_object('id', :'pid','q',-5))::jsonb, '{"mode":"order","type":"pickup"}') r) x;
select 'empty cart', public.log_event(:'sid','order_click', 0, '[]'::jsonb, '{"mode":"order","type":"pickup"}')->>'error';

-- 6) كوبون مزيف/خصم مزيف ← يُتجاهل
select 'fake discount', r->>'total', r->>'discount', r->>'coupon' from (select public.log_event(:'sid','order_click', 1,
  json_build_array(json_build_object('id', :'pid','q',1))::jsonb, '{"mode":"order","type":"pickup","coupon":"FREE100","discount":"76"}') r) x;

-- 7) الحد الأدنى للتوصيل يُفرض في الخادم
select public.merchant_update_store(:'tok', '{"min_order":"500"}') is not null;
select 'min order', public.log_event(:'sid','order_click', 1, json_build_array(json_build_object('id', :'pid','q',1))::jsonb, '{"mode":"order","type":"delivery"}')->>'error';

-- 8) التاجر يتحقق برقم الطلب، ومتجر آخر لا يرى طلبات غيره
select 'find', (public.merchant_find_order(:'tok', 1001)->>'total'), (public.merchant_find_order(:'tok', 1001)->'meta'->>'code') is not null;
select 'find missing', public.merchant_find_order(:'tok', 9999) is null;
select 'find other store', public.merchant_find_order(:'tok2', 1001) is null;
select 'find bad token'; select public.merchant_find_order('bad', 1001);

-- 9) رموز التحقق عشوائية ومختلفة
reset role;
select 'codes unique', count(distinct meta->>'code') = count(*) from public.analytics_events where store_id = :'sid' and event_type = 'order_click';
