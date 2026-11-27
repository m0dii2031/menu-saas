-- اجعل حسابك مديراً للمنصة
-- 1) أنشئ المستخدم أولاً من Authentication ← Users ← Add user ← Create new user (فعّل Auto Confirm User)
-- 2) غيّر البريد في السطر التالي لبريدك، ثم الصق الملف في SQL Editor واضغط Run
insert into private.admins (user_id)
select id from auth.users where email = lower('YOUR-EMAIL@example.com')
on conflict do nothing;

-- يجب أن تظهر نتيجة فيها بريدك؛ إذا كانت فارغة فالبريد غير مطابق للمستخدم الذي أنشأته
select u.email, 'admin ✅' as role
from private.admins a join auth.users u on u.id = a.user_id;
