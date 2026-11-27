#!/usr/bin/env python3
"""يبني نسخة «نسخ ولصق» للنشر من لوحة Supabase بدون CLI:
dashboard/1-database.sql        ← كل الترحيلات في ملف واحد
dashboard/functions/<name>.ts   ← كل دالة في ملف واحد (الأدوات المشتركة مدمجة)
"""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent
out = root / "dashboard"; (out / "functions").mkdir(parents=True, exist_ok=True)

migs = sorted((root / "supabase/migrations").glob("*.sql"))
sql = ["-- ملف قاعدة البيانات الكامل (مولَّد تلقائياً من supabase/migrations — لا تعدّله يدوياً)\n"
       "-- الصقه كاملاً في Supabase ← SQL Editor ← New query ← Run. آمن لإعادة التشغيل.\n"]
for m in migs:
    sql.append(f"\n-- ===================== {m.name} =====================\n")
    sql.append(m.read_text())
(out / "1-database.sql").write_text("".join(sql))

fn = root / "supabase/functions"
common = (fn / "_shared/common.ts").read_text()
for d in sorted(p for p in fn.iterdir() if p.is_dir() and not p.name.startswith("_")):
    src = (d / "index.ts").read_text()
    src = re.sub(r'^import [^\n]*"\.\./_shared/common\.ts";\n', "", src, flags=re.M)
    src = re.sub(r'^import \{ createClient \} from "npm:@supabase/supabase-js@[^"]+";\n', "", src, flags=re.M)
    body = (f"// دالة {d.name} — ملف واحد جاهز للصق في محرر Supabase (مولَّد من supabase/functions)\n"
            f"// ======== الأدوات المشتركة ========\n{common}\n// ======== الدالة ========\n{src}")
    (out / "functions" / f"{d.name}.ts").write_text(body)
print("built", len(migs), "migrations and", len(list((out / "functions").glob("*.ts"))), "functions")
