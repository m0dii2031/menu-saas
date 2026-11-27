#!/usr/bin/env python3
"""ينسخ public/ إلى مجلد للنشر تحت مسار فرعي (GitHub Pages: https://user.github.io/<repo>/)
ويضبط config.js برابط Supabase ومفتاحه العام.

الاستخدام: python3 scripts/build-pages.py <out_dir> <base_path> [supabase_url] [anon_key]
مثال:      python3 scripts/build-pages.py _site /menu-saas https://xxxx.supabase.co sb_publishable_...
"""
import pathlib, re, shutil, sys

root = pathlib.Path(__file__).resolve().parent.parent
out = pathlib.Path(sys.argv[1]).resolve()
base = "/" + sys.argv[2].strip("/") if len(sys.argv) > 2 and sys.argv[2].strip("/") else ""
url = sys.argv[3] if len(sys.argv) > 3 else ""
key = sys.argv[4] if len(sys.argv) > 4 else ""

if out.exists():
    shutil.rmtree(out)
shutil.copytree(root / "public", out, ignore=shutil.ignore_patterns("_redirects", "_headers"))

def rewrite(s: str) -> str:
    if not base:
        return s
    s = re.sub(r'(["\'(])/assets/', rf'\1{base}/assets/', s)
    s = s.replace('"/sw.js"', f'"{base}/sw.js"')
    s = s.replace("${location.origin}/", "${location.origin}" + base + "/")
    s = s.replace("return location.origin;", f'return location.origin + "{base}";')
    s = s.replace("`/?store=", f"`{base}/?store=").replace("`/manage?store=", f"`{base}/manage?store=")
    return s

for p in out.rglob("*"):
    if p.suffix in (".html", ".js", ".css"):
        s = rewrite(p.read_text())
        if p.name == "sw.js" and base:
            s = s.replace('"/", "/index.html"', f'"{base}/", "{base}/index.html"')
            s = s.replace('c.put("/index.html"', f'c.put("{base}/index.html"')
            s = s.replace('caches.match("/index.html")', f'caches.match("{base}/index.html")')
            s = s.replace('startsWith("/manage")', f'startsWith("{base}/manage")').replace('startsWith("/admin")', f'startsWith("{base}/admin")')
        if p.name == "config.js" and url and key:
            s = re.sub(r'SUPABASE_URL: ".*?"', f'SUPABASE_URL: "{url}"', s)
            s = re.sub(r'SUPABASE_ANON_KEY: ".*?"', f'SUPABASE_ANON_KEY: "{key}"', s)
        p.write_text(s)

# أي مسار مطلق متبقٍ بدون المسار الفرعي = خطأ
if base:
    bad = []
    for p in out.rglob("*"):
        if p.suffix in (".html", ".js", ".css"):
            for m in re.finditer(r'["\'(`]/(assets|sw\.js|manage|admin|index\.html|\?store)', p.read_text()):
                bad.append(f"{p.relative_to(out)}: {m.group(0)}")
    if bad:
        sys.exit("مسارات لم تُحوَّل:\n" + "\n".join(bad))
(out / ".nojekyll").write_text("")
print(f"built {out} base={base or '/'}")
