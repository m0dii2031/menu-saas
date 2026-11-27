// E2E: real UI (Playwright) + real SQL (local Postgres) behind a fake "supabase.co" gateway.
const { chromium, devices } = require("playwright");
const { Client } = require("pg");
const fs = require("fs");
const path = require("path");
const http = require("http");

const PUB = path.resolve(__dirname, "../../public");
const MIGRATIONS = ["20261126000000_init.sql", "20261127000000_features.sql", "20261128000000_order_integrity.sql"].map((f) => path.resolve(__dirname, "../../supabase/migrations", f));
const PG = { host: process.env.PGHOST || "/var/run/postgresql", port: Number(process.env.PGPORT || 5432), user: process.env.PGUSER || "postgres" };
const NM = path.resolve(__dirname, "node_modules");
const OUT = process.env.OUT || path.resolve(__dirname, "shots");
fs.mkdirSync(OUT, { recursive: true });
const ADMIN_UID = "11111111-1111-1111-1111-111111111111";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const ADMIN_JWT = `${b64u({ alg: "HS256", typ: "JWT" })}.${b64u({ sub: ADMIN_UID, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600, email: "admin@test.com", aud: "authenticated" })}.sig`;
const results = [];
const check = (name, cond, extra = "") => { results.push([cond ? "PASS" : "FAIL", name, extra]); console.log(cond ? "  ✅" : "  ❌", name, extra); };

let db;
async function sql(q, params = []) { return (await db.query(q, params)).rows; }
async function waitDb(q, pred, ms = 5000) { const t = Date.now(); let r; while (Date.now() - t < ms) { r = await sql(q); if (pred(r[0])) return r[0]; await new Promise((x) => setTimeout(x, 100)); } return r[0]; }

const argTypes = {};
async function callRpc(fn, args, admin) {
  const keys = Object.keys(args || {});
  if (!argTypes[fn]) {
    // like PostgREST: a JSON array sent to an array-typed parameter (uuid[]) becomes a Postgres array literal
    const rows = await sql("select unnest(proargnames) n, unnest(proargtypes::regtype[]::text[]) t from pg_proc p join pg_namespace s on s.oid = p.pronamespace where s.nspname = 'public' and proname = $1", [fn]);
    argTypes[fn] = Object.fromEntries(rows.map((x) => [x.n, x.t]));
  }
  const call = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`;
  const vals = keys.map((k) => {
    const v = args[k];
    if (v === null || v === undefined) return null;
    if (Array.isArray(v) && (argTypes[fn][k] || "").endsWith("[]")) return "{" + v.map((x) => JSON.stringify(String(x))).join(",") + "}";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
  await db.query("begin");
  try {
    await db.query(`set local role ${admin ? "authenticated" : "anon"}`);
    await db.query("select set_config('test.uid', $1, true), set_config('request.headers', $2, true)", [admin ? ADMIN_UID : "", JSON.stringify({ "x-forwarded-for": "10.0.0.1" })]);
    const r = await db.query(call, vals);
    await db.query("commit");
    return { status: 200, body: r.rows[0].r };
  } catch (e) {
    await db.query("rollback");
    return { status: 400, body: { code: e.code, message: e.message, details: null, hint: null } };
  }
}

const uploads = new Map();
async function gateway(route) {
  const req = route.request();
  const url = new URL(req.url());
  const p = url.pathname;
  const json = (status, body) => route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: body === undefined ? "" : JSON.stringify(body) });
  if (req.method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
  const auth = req.headers()["authorization"] || "";
  const isAdmin = auth === `Bearer ${ADMIN_JWT}`;

  if (p.startsWith("/rest/v1/rpc/")) {
    const r = await callRpc(p.split("/").pop(), JSON.parse(req.postData() || "{}"), isAdmin);
    return json(r.status, r.body);
  }
  if (p === "/auth/v1/token") {
    const b = JSON.parse(req.postData() || "{}");
    if (b.email === "admin@test.com" && b.password === "secret") {
      const user = { id: ADMIN_UID, aud: "authenticated", role: "authenticated", email: b.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
      return json(200, { access_token: ADMIN_JWT, token_type: "bearer", expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "r1", user });
    }
    return json(400, { error: "invalid_grant", error_description: "Invalid login credentials" });
  }
  if (p === "/auth/v1/user") return json(200, { id: ADMIN_UID, aud: "authenticated", role: "authenticated", email: "admin@test.com" });
  if (p === "/auth/v1/logout") return route.fulfill({ status: 204 });

  if (p === "/functions/v1/sign-upload") {
    const b = JSON.parse(req.postData() || "{}");
    const [{ sid }] = await sql("select public.service_verify_merchant($1) sid", [b.token]).catch(() => [{}]);
    if (!sid) return json(401, { error: "unauthorized" });
    const ext = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" }[b.content_type];
    if (!ext) return json(400, { error: "invalid_type" });
    const key = `${sid}/${b.kind}/${Date.now()}.${ext}`;
    return json(200, { path: key, token: "signtok", public_url: `https://test.supabase.co/storage/v1/object/public/media/${key}` });
  }
  if (p.startsWith("/storage/v1/object/upload/sign/media/")) {
    const key = decodeURIComponent(p.replace("/storage/v1/object/upload/sign/media/", ""));
    let buf = req.postDataBuffer();
    let type = req.headers()["content-type"] || "";
    const m = /boundary=(.+)$/.exec(type);
    if (m) { // unwrap multipart body sent by supabase-js: pick the part that carries a Content-Type
      const parts = buf.toString("latin1").split("--" + m[1]);
      const part = parts.find((x) => /Content-Type:/i.test(x)) || "";
      const sep = part.indexOf("\r\n\r\n");
      type = (/Content-Type: ([^\r\n]+)/i.exec(part) || [])[1] || "";
      buf = Buffer.from(part.slice(sep + 4, part.lastIndexOf("\r\n")), "latin1");
    }
    uploads.set(key, { buf, type });
    return json(200, { Key: `media/${key}` });
  }
  if (p.startsWith("/storage/v1/object/public/media/")) {
    const f = uploads.get(decodeURIComponent(p.replace("/storage/v1/object/public/media/", "")));
    return f ? route.fulfill({ status: 200, contentType: "image/webp", body: f.buf }) : route.fulfill({ status: 404 });
  }
  if (p === "/functions/v1/vision-menu") {
    const b = JSON.parse(req.postData() || "{}");
    const [{ sid }] = await sql("select public.service_verify_merchant($1) sid", [b.token]).catch(() => [{}]);
    if (!sid) return json(401, { error: "unauthorized" });
    const [{ rem }] = await sql("select public.service_consume_vision($1, 5) rem", [sid]);
    if (rem === -1) return json(429, { error: "daily_limit", remaining: 0 });
    return json(200, { remaining: rem, items: [
      { category: "مشروبات", name: "شاي كرك", description: "", price: 5, sizes: [] },
      { category: "مشروبات", name: "عصير برتقال", description: "طازج", price: 8, sizes: [{ name: "وسط", price: 8 }, { name: "كبير", price: 12 }] },
    ] });
  }
  if (p === "/functions/v1/manifest") return json(200, { name: "x", start_url: "/", display: "standalone", icons: [] });
  return json(404, { error: "not mocked", path: p });
}

function staticServer() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2" };
  return http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/") p = "/index.html";
    if (p === "/manage" || p === "/admin") p += ".html";
    const f = path.join(PUB, path.normalize(p));
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end("nf"); }
    let body = fs.readFileSync(f);
    if (p.endsWith("config.js")) body = Buffer.from(body.toString().replace(/SUPABASE_URL: ".*?"/, 'SUPABASE_URL: "https://test.supabase.co"').replace(/SUPABASE_ANON_KEY: ".*?"/, 'SUPABASE_ANON_KEY: "sb_publishable_test"'));
    res.writeHead(200, { "Content-Type": types[path.extname(f)] || "application/octet-stream" });
    res.end(body);
  }).listen(8787);
}

async function newPage(browser, errors) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"], locale: "ar-SA", timezoneId: "Asia/Riyadh", serviceWorkers: "block" });
  await ctx.route("https://test.supabase.co/**", gateway);
  await ctx.route("https://cdn.jsdelivr.net/npm/@supabase/**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(`${NM}/@supabase/supabase-js/dist/umd/supabase.js`) }));
  await ctx.route("https://cdn.jsdelivr.net/npm/qrcode-generator**", (r) => r.fulfill({ contentType: "text/javascript", body: fs.readFileSync(`${NM}/qrcode-generator/qrcode.js`) }));
  // Google Fonts محجوب في بيئة الاختبار: نخدم نفس ملفات Almarai محلياً (من @fontsource/almarai) إن وُجدت
  const FONT_DIR = `${NM}/@fontsource/almarai/files`;
  const hasFont = fs.existsSync(FONT_DIR);
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css", body: hasFont
    ? [300, 400, 700, 800].map((w) => `@font-face{font-family:"Almarai";font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/almarai/${w}.woff2) format("woff2")}`).join("\n") : "" }));
  await ctx.route("https://fonts.gstatic.com/almarai/**", (r) => {
    const w = r.request().url().match(/(\d+)\.woff2/)[1];
    r.fulfill({ contentType: "font/woff2", body: fs.readFileSync(`${FONT_DIR}/almarai-arabic-${w}-normal.woff2`) });
  });
  await ctx.addInitScript(() => {
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return { opener: null, location: { set href(v) { window.__opened.push(v); } } }; };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/realtime|websocket|WebSocket|ERR_|404/i.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on("dialog", (d) => d.dismiss());
  return page;
}

const overflowBad = [], badText = [];
async function seedImage(page, key, emoji, c1, c2, w = 600, h = 600) {
  const b64 = await page.evaluate(([emoji, c1, c2, w, h]) => {
    const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d");
    const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, c1); g.addColorStop(1, c2); x.fillStyle = g; x.fillRect(0, 0, w, h);
    x.fillStyle = "rgba(255,255,255,.18)"; x.beginPath(); x.arc(w * .5, h * .55, Math.min(w, h) * .36, 0, 7); x.fill();
    x.font = `${Math.min(w, h) * .46}px serif`; x.textAlign = "center"; x.textBaseline = "middle"; x.fillText(emoji, w / 2, h * .55);
    return c.toDataURL("image/png").split(",")[1];
  }, [emoji, c1, c2, w, h]);
  uploads.set(key, { buf: Buffer.from(b64, "base64"), type: "image/png" });
  return `https://test.supabase.co/storage/v1/object/public/media/${key}`;
}
const shot = async (page, name) => { const w = await page.evaluate(() => [document.documentElement.scrollWidth, window.visualViewport ? Math.round(visualViewport.width) : innerWidth]); if (w[0] > 390 + 1) overflowBad.push(`${name}:${w[0]}`); const t = await page.evaluate(() => document.body.innerText); const m = t.match(/\b(null|undefined|NaN)\b/); if (m) badText.push(`${name}:${m[0]}`); return page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false }); };
const lastWa = async (page) => { const u = (await page.evaluate(() => window.__opened)).pop(); return u ? decodeURIComponent(new URL(u).searchParams.get("text")) : null; };

(async () => {
  // Fresh DB
  const sys = new Client({ ...PG, database: "postgres" });
  await sys.connect();
  await sys.query("drop database if exists e2e with (force)");
  await sys.query("create database e2e");
  await sys.end();
  db = new Client({ ...PG, database: "e2e" });
  await db.connect();
  for (const r of ["anon", "authenticated", "service_role"]) await db.query(`do $$ begin create role ${r} nologin; exception when duplicate_object then null; end $$`);
  await db.query(fs.readFileSync(path.resolve(__dirname, "supabase-stubs.sql"), "utf8").replace(/create role[^;]+;/g, "").replace(/create publication[^;]+;/, ""));
  for (const m of MIGRATIONS) await db.query(fs.readFileSync(m, "utf8"));
  await db.query("insert into private.admins values ($1)", [ADMIN_UID]);

  const server = staticServer();
  const browser = await chromium.launch();
  const errors = [];
  const BASE = "http://localhost:8787";

  /* ---------- 1) Admin ---------- */
  console.log("\n[Admin]");
  let page = await newPage(browser, errors);
  await page.goto(`${BASE}/admin`);
  await page.locator(".auth-card").waitFor(); await shot(page, "00-admin-login");
  await page.fill('input[type="email"]', "admin@test.com");
  await page.fill('input[type="password"]', "secret");
  await page.click('button[type="submit"]');
  await page.locator(".fab").waitFor();
  await page.click(".fab");
  const sheet = page.locator(".sheet");
  await sheet.locator("input").nth(0).fill("مطعم التجربة");
  await sheet.locator("input").nth(1).fill("Test Rest");
  check("slug auto-sanitized", (await sheet.locator("input").nth(1).inputValue()) === "test-rest");
  await sheet.locator("input").nth(2).fill("0501234567");
  await shot(page, "01-admin-create");
  await page.click("text=إنشاء المتجر وتوليد الرابط");
  await page.getByText("✅ تم إنشاء المتجر").waitFor();
  const pinText = await page.locator(".alert b.ltr").innerText();
  check("PIN shown once (6 digits)", /^\d{6}$/.test(pinText), pinText);
  check("QR canvas drawn", await page.evaluate(() => { const c = document.querySelector(".qr-wrap canvas"); const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let dark = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 50) dark++; return dark > 1000; }));
  await shot(page, "02-admin-created-qr");
  await page.locator(".sheet .btn-ghost").first().click();
  await page.locator(".store-card").first().waitFor();
  await shot(page, "03-admin-list");
  await page.click("text=+30 يوم تجديد");
  await page.getByText("تم تجديد").waitFor();
  const [{ d }] = await sql("select round(extract(epoch from expires_at - now())/86400) d from stores where slug='test-rest'");
  check("+30 renew → ~60 days", Number(d) >= 59, `days=${d}`);
  await page.click("text=📋 نسخ رسالة التذكير").catch(() => {});
  await page.close();

  /* ---------- 2) Merchant ---------- */
  console.log("\n[Merchant]");
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/manage?store=test-rest`);
  await page.locator(".auth-card .store-chip b").waitFor(); await page.waitForTimeout(300); await shot(page, "04a-merchant-login");
  await page.fill('input[type="password"]', "0000");
  await page.click('button[type="submit"]');
  await page.getByText("رمز غير صحيح").waitFor();
  check("wrong PIN rejected with remaining count", await page.getByText("المتبقي").isVisible());
  await page.fill('input[type="password"]', pinText);
  await page.click('button[type="submit"]');
  await page.locator(".fab").waitFor();
  await shot(page, "04-merchant-menu-empty");

  // add product with sizes & addons + image (generated PNG)
  await page.click(".fab");
  const f = page.locator(".sheet");
  await f.locator("input").nth(0).fill("برجر لحم <img src=x onerror=alert(1)>");
  await f.locator("input").nth(1).fill("وجبات");
  await f.locator("textarea").fill("لحم أنجوس طازج مع صوص خاص");
  const pngPath = path.join(PUB, "assets/icons/icon-512.png");
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), f.getByRole("button", { name: "اختيار صورة" }).click()]);
  await chooser.setFiles(pngPath);
  await f.getByText("✅ تم الرفع").waitFor({ timeout: 10000 });
  const uploaded = [...uploads.values()].pop();
  check("image compressed client-side to webp < 2MB", uploaded && uploaded.type === "image/webp" && uploaded.buf.length < 2 * 1024 * 1024, `${uploaded?.type} ${uploaded?.buf.length}B`);
  await f.getByText("+ إضافة حجم").click();
  await f.getByText("+ إضافة حجم").click();
  const rows = f.locator(".rows-editor .r");
  await rows.nth(0).locator("input").nth(0).fill("عادي"); await rows.nth(0).locator("input").nth(1).fill("22");
  await rows.nth(1).locator("input").nth(0).fill("دبل"); await rows.nth(1).locator("input").nth(1).fill("32");
  await f.getByText("+ إضافة إضافة").click();
  await rows.nth(2).locator("input").nth(0).fill("جبنة شيدر"); await rows.nth(2).locator("input").nth(1).fill("3");
  await shot(page, "05-merchant-product-form");
  await f.getByText("إضافة الصنف").click();
  await page.locator(".item-row").first().waitFor();
  const [prod] = await sql("select name, price, options_json, image_url from products");
  check("product saved with sizes/addons", prod.options_json.sizes.length === 2 && prod.options_json.addons.length === 1 && Number(prod.price) === 22, JSON.stringify(prod.options_json));
  check("product image_url stored", /^https:\/\/test\.supabase\.co\/storage/.test(prod.image_url || ""));

  // second simple product + toggle off
  await page.click(".fab");
  await f.locator("input").nth(0).fill("بطاطس");
  await f.locator("input").nth(1).fill("مقبلات");
  await f.locator('input[type="number"]').first().fill("9");
  await f.getByText("إضافة الصنف").click();
  await page.locator(".item-row").nth(1).waitFor();
  // vision import
  const [ch2] = await Promise.all([page.waitForEvent("filechooser"), page.getByText("أضف منيو من صورة").click()]);
  await ch2.setFiles(pngPath);
  await page.getByText("تم استخراج 2 صنف").waitFor({ timeout: 15000 });
  await shot(page, "06-merchant-vision");
  await page.getByText("اعتماد الأصناف المحددة").click();
  await page.getByText("تمت إضافة 2 صنف").waitFor();
  check("vision import inserted 2 items", (await sql("select count(*)::int c from products"))[0].c === 4);
  // inline price edit on بطاطس
  const fries = page.locator(".item-row", { hasText: "بطاطس" });
  await fries.locator(".price-input").fill("11");
  await fries.locator(".price-input").press("Tab");
  await page.getByText("تم تحديث السعر").waitFor();
  check("inline price update", Number((await sql("select price from products where name='بطاطس'"))[0].price) === 11);
  // hide شاي كرك
  await page.locator(".item-row", { hasText: "شاي كرك" }).locator(".switch").click();
  await page.getByText("تم الإخفاء من المتجر").waitFor();
  check("availability switch", (await sql("select is_available from products where name='شاي كرك'"))[0].is_available === false);
  await shot(page, "07-merchant-menu-list");

  // Settings tab
  await page.click(".bottom-nav >> text=الإعدادات");
  await page.getByText("بيانات المتجر").waitFor();
  const fee = page.locator('label:has-text("رسوم التوصيل") input');
  await fee.fill("10");
  await page.locator('label:has-text("يفتح") input').waitFor({ state: "attached" });
  await page.click("text=💾 حفظ الإعدادات");
  const fr = await waitDb("select delivery_fee from stores where slug='test-rest'", (r) => Number(r.delivery_fee) === 10);
  check("delivery fee saved", Number(fr.delivery_fee) === 10);
  await shot(page, "08-merchant-settings");

  // Design tab
  await page.click(".bottom-nav >> text=التصميم");
  await page.click(".theme-card >> text=مطعم");
  await page.click("text=💾 حفظ التصميم");
  await page.getByText("تم الحفظ").first().waitFor();
  await shot(page, "09-merchant-design");

  // Offers tab
  await page.click(".bottom-nav >> text=العروض");
  await page.locator('input[placeholder*="خصم 20%"]').fill("🔥 خصم 20% على البرجر اليوم فقط");
  await page.locator(".card.row .switch").first().click();
  await page.click(".segmented >> text=24 ساعة");
  await page.click("text=💾 حفظ العرض");
  const bn = await waitDb("select banner_active, banner_text, extract(epoch from banner_expires_at-now())/3600 hrs from stores where slug='test-rest'", (r) => r.banner_active);
  check("banner saved with 24h countdown", bn.banner_active && Number(bn.hrs) > 23.9, `${bn.hrs}h`);
  await shot(page, "10-merchant-offers");
  await page.close();

  /* ---------- 3) Customer (order mode) ---------- */
  console.log("\n[Customer — order]");
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=nope`);
  const [{ sid: rid }] = await sql("select id sid from stores where slug='test-rest'");
  const IMG = {};
  for (const [k, e, a, b] of [["burger", "🍔", "#f59e0b", "#b45309"], ["fries", "🍟", "#fcd34d", "#ea580c"], ["karak", "☕", "#d6a77a", "#7c4a24"], ["juice", "🍊", "#fdba74", "#f97316"],
    ["chicken", "🍗", "#fbbf24", "#c2410c"], ["salad", "🥗", "#86efac", "#15803d"], ["shake", "🥤", "#f9a8d4", "#db2777"], ["wrap", "🌯", "#fde68a", "#a16207"]]) IMG[k] = await seedImage(page, `seed/${k}.png`, e, a, b);
  const cover = await seedImage(page, "seed/cover.png", "🍔🍟🥤", "#7c2d12", "#ea580c", 1200, 520);
  const logo = await seedImage(page, "seed/logo.png", "🔥", "#111827", "#374151", 400, 400);
  await sql("update stores set cover_url=$1, logo_url=$2, business_type='برجر ومشويات' where id=$3", [cover, logo, rid]);
  await sql("update products set image_url=$1 where name like 'برجر لحم%'", [IMG.burger]);
  await sql("update products set image_url=$1, description='بطاطس ذهبية مقرمشة مع رشة ملح البحر' where name='بطاطس'", [IMG.fries]);
  await sql("update products set image_url=$1 where name='شاي كرك'", [IMG.karak]);
  await sql("update products set image_url=$1 where name='عصير برتقال'", [IMG.juice]);
  await sql(`insert into products (store_id,category,name,description,price,image_url,options_json,sort_order) values
    ($1,'وجبات','دجاج مقرمش','قطع دجاج متبلة بخلطة البيت مع صوص الثوم',26,$2,'{"sizes":[{"name":"4 قطع","price":26},{"name":"8 قطع","price":44}]}',3),
    ($1,'وجبات','تورتيلا الدجاج','دجاج مشوي، خضار طازجة، صوص رانش',19,$3,'{}',4),
    ($1,'مقبلات','سلطة سيزر','خس روماني، بارميزان، خبز محمص',17,$4,'{}',6),
    ($1,'مشروبات','ميلك شيك فراولة','',15,$5,'{"sizes":[{"name":"وسط","price":15},{"name":"كبير","price":19}]}',9)`, [rid, IMG.chicken, IMG.wrap, IMG.salad, IMG.shake]);
  await page.goto(`${BASE}/?store=test-rest`);
  await page.locator(".hero-name").waitFor();
  check("XSS text rendered as text, no <img> injected", await page.evaluate(() => !document.querySelector('.product img[src="x"]') && [...document.querySelectorAll(".product-name")].some((e) => e.textContent.includes("<img"))));
  check("hidden item rendered as unavailable", await page.locator(".product.unavailable", { hasText: "شاي كرك" }).count() === 1);
  check("countdown banner visible", await page.locator(".promo .countdown").isVisible());
  const cd1 = await page.locator(".countdown").innerText(); await page.waitForTimeout(1200);
  check("countdown ticking", cd1 !== await page.locator(".countdown").innerText(), cd1.replace(/\n/g, ""));
  check("view event logged once", (await sql("select count(*)::int c from analytics_events where event_type='view'"))[0].c === 1);
  await page.reload(); await page.locator(".hero-name").waitFor();
  check("view not duplicated in same session", (await sql("select count(*)::int c from analytics_events where event_type='view'"))[0].c === 1);
  await shot(page, "11-store-order-home");
  await page.screenshot({ path: `${OUT}/11f-store-full.png`, fullPage: true });
  const riyal = await page.evaluate(async () => {
    await document.fonts.ready;
    const loaded = [...document.fonts].some((f) => f.family.replace(/"/g, "") === "SaudiRiyal" && f.status === "loaded");
    return { loaded, inPrice: document.querySelector(".item-price")?.textContent.includes("\u20C1") };
  });
  check("prices use the official riyal sign with its font loaded", riyal.loaded && riyal.inPrice, JSON.stringify(riyal));
  await page.locator(".sf-cover .lang-btn").click();
  await page.locator(".hero-name").waitFor();
  const en = await page.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, body: document.body.innerText }));
  if (en.body.includes("الأقسام") || !en.body.includes("Categories")) console.log("EN BODY:", en.body.slice(0, 600).replace(/\n/g, " | "));
  check("English switch: LTR + translated UI", en.dir === "ltr" && en.lang === "en" && en.body.includes("Categories") && en.body.includes("Picked for you") && !en.body.includes("الأقسام"), en.dir);
  await shot(page, "11e-store-english");
  await page.locator(".product", { hasText: "دجاج مقرمش" }).click();
  await page.waitForTimeout(400);
  check("English product sheet", (await page.locator(".sheet").innerText()).includes("Choose size / type"));
  await shot(page, "12e-product-english");
  await page.locator(".sheet .sheet-head .btn").click();
  await page.locator(".sf-cover .lang-btn").click();
  await page.locator(".hero-name").waitFor();
  check("switch back to Arabic (RTL)", await page.evaluate(() => document.documentElement.dir === "rtl" && document.body.innerText.includes("الأقسام")));

  await page.locator(".product", { hasText: "برجر لحم" }).click();
  await page.locator(".sheet").waitFor();
  await page.locator(".sheet-foot .btn", { hasText: "اختر الحجم أولاً" }).click();
  check("size is mandatory before add", await page.getByText("الرجاء اختيار الحجم").isVisible() && await page.locator(".sheet").count() === 1);
  await page.waitForTimeout(800);
  await page.locator(".option", { hasText: "دبل" }).click();
  await page.locator(".option", { hasText: "جبنة شيدر" }).click();
  await page.locator('.sheet .qty button[aria-label="زيادة"]').click();
  await page.locator(".sheet .note-input").fill("بدون مخلل");
  await shot(page, "12-store-product-sheet");
  check("add button shows computed total (32+3)*2=70", (await page.locator(".sheet-foot .btn").innerText()).includes("70"));
  await page.locator(".sheet-foot .btn").click();
  await page.locator(".product", { hasText: "بطاطس" }).click();
  await page.waitForTimeout(400);
  await page.locator(".sheet-foot .btn").click();
  await page.locator(".cta-bar .btn").click();
  await page.locator(".sheet").waitFor();
  await page.locator('.sheet label:has-text("الاسم") input').fill("محمد");
  await page.locator('.sheet label:has-text("رقم الجوال") input').fill("0555555555");
  await page.getByText("إرسال الطلب عبر واتساب").click();
  check("delivery blocked without district/GPS", await page.getByText("اكتب اسم الحي أو حدّد موقعك").isVisible() && (await page.evaluate(() => window.__opened.length)) === 0);
  await page.locator('.sheet label:has-text("الحي") input').fill("النرجس");
  await page.locator('.sheet label:has-text("العنوان التفصيلي") input').fill("شارع 12، فيلا 4");
  await page.locator(".sheet .pay-row", { hasText: "تحويل بنكي" }).click();
  await page.locator(".sheet .pay-row", { hasText: "نقداً عند الاستلام" }).click();
  await page.locator(".sheet textarea").fill("بدون بصل");
  await shot(page, "13-store-checkout");
  await page.getByText("إرسال الطلب عبر واتساب").click();
  await page.getByText("تم تجهيز طلبك").waitFor();
  const msg = await lastWa(page);
  const waUrl = (await page.evaluate(() => window.__opened)).slice(-1)[0];
  console.log("\n----- WhatsApp message -----\n" + msg + "\n----------------------------");
  check("wa.me link to merchant number", waUrl.startsWith("https://wa.me/966501234567?text="));
  const order = ["┐────── إشعار تأكيد الطلب 🛍️ ──────┌", "رقم الطلب: *#ORD-1001*", "🔷 *المنتجات:*", "• برجر لحم", "(دبل) ×2 — 70.00 ﷼", "   ➕ الإضافات: جبنة شيدر (+3.00 ﷼)", "   📝 ملاحظة: بدون مخلل", "• بطاطس ×1 — 11.00 ﷼", "👤 الاسم: محمد", "📍 العنوان: النرجس — شارع 12، فيلا 4", "📞 الجوال:", "📝 ملاحظات الطلب: بدون بصل", "💳 *تفاصيل الفاتورة:*", "• المنتجات: 81.00 ﷼", "• التوصيل: 10.00 ﷼", "• الإجمالي: *91.00 ﷼*", "• الدفع: عند الاستلام (نقداً)", "┘─────"];
  let pos = -1, inOrder = true;
  for (const part of order) { const i = msg.indexOf(part, pos + 1); if (i < 0 || i < pos) { inOrder = false; console.log("   missing/out of order:", part); } pos = Math.max(pos, i); }
  check("message contains all sections in required order", inOrder);
  const [ev] = await sql("select order_total, items_json from analytics_events where event_type='order_click'");
  check("order_click logged with total 91", Number(ev.order_total) === 91, JSON.stringify(ev.items_json));
  const [{ code: vcode }] = await sql("select meta->>'code' code from analytics_events where event_type='order_click' order by id desc limit 1");
  check("message carries the server verification code", /^[A-Z2-9]{4}$/.test(vcode || "") && msg.includes(`🔐 رمز التحقق: *${vcode}*`), vcode);
  await shot(page, "14-store-sent");
  await page.locator(".sheet .btn-ghost").first().click();
  await page.reload(); await page.locator(".reorder").waitFor(); await page.locator(".reorder").scrollIntoViewIfNeeded(); await shot(page, "14c-store-reorder");
  check("reorder card shows last order", (await page.locator(".reorder").innerText()).includes("برجر"));
  check("cart cleared after send", await page.locator(".cta-bar .btn").count() === 0);
  // cooldown
  await page.locator(".product", { hasText: "بطاطس" }).click();
  await page.waitForTimeout(400);
  await page.locator(".sheet-foot .btn").click();
  await page.locator(".cta-bar .btn").click();
  check("customer data auto-filled from localStorage", (await page.locator('.sheet label:has-text("الحي") input').inputValue()) === "النرجس");
  check("cooldown blocks rapid resend", /انتظر \d+ ثانية/.test(await page.locator(".sheet-foot .btn").innerText()));
  await page.locator(".sheet .choice >> text=استلام من المحل").click();
  await shot(page, "14b-store-pickup");
  check("pickup hides delivery fee & address", !(await page.locator(".summary").innerText()).includes("رسوم التوصيل") && await page.locator('.sheet label:has-text("الحي") input').isHidden());
  await page.close();

  /* ---------- 4) Other modes ---------- */
  console.log("\n[Other modes]");
  const mk = async (slug, mode, theme, extra = "") => {
    const [{ id }] = await sql(`insert into stores (slug,name,whatsapp_phone,business_mode,theme_style,business_type ${extra ? "," + extra.split("=")[0] : ""}) values ($1,$2,'966500000001',$3,$4,$5 ${extra ? ",'" + extra.split("=")[1] + "'" : ""}) returning id`,
      [slug, { booking: "شاليهات الواحة", inquiry: "مكتب الإتقان العقاري", charity: "جمعية البر الخيرية", legal: "مكتب العدالة للمحاماة" }[mode], mode, theme, { booking: "شاليهات واستراحات", inquiry: "عقار", charity: "جمعية خيرية", legal: "محاماة واستشارات" }[mode]]);
    return id;
  };
  const ch = await mk("oasis", "booking", "theme-chalet");
  await sql(`insert into products (store_id,category,name,description,price,options_json) values
    ($1,'شاليهات','شاليه الياسمين','مسبح خاص، ملعب، جلسات خارجية',650,'{"unit":"ليلة","specs":[{"label":"المساحة","value":"800م"},{"label":"غرف النوم","value":"3"},{"label":"المسبح","value":"مدفأ"}]}'),
    ($1,'استراحات','استراحة الريم','مناسبة للعائلات',400,'{"unit":"ليلة","specs":[{"label":"السعة","value":"40 شخص"}]}')`, [ch]);
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=nope`);
  const chImgs = [await seedImage(page, "seed/ch1.png", "🏊", "#5eead4", "#0f766e", 900, 600), await seedImage(page, "seed/ch2.png", "🌴", "#99f6e4", "#115e59", 900, 600)];
  await sql("update products set image_url=$1, gallery_json=$2 where store_id=$3 and name='شاليه الياسمين'", [chImgs[0], JSON.stringify([chImgs[1]]), ch]);
  await sql("update products set image_url=$1 where store_id=$2 and name='استراحة الريم'", [await seedImage(page, "seed/ch3.png", "🏡", "#a7f3d0", "#047857", 900, 600), ch]);
  await sql("update stores set cover_url=$1 where id=$2", [await seedImage(page, "seed/chc.png", "🌅", "#134e4a", "#14b8a6", 1200, 520), ch]);
  await page.goto(`${BASE}/?store=oasis`); await page.locator(".listing").first().waitFor();
  await shot(page, "15-booking-home");
  await page.locator(".listing").first().click(); await page.getByText("احجز هذه الوحدة").click();
  await page.locator('.sheet .qty button[aria-label="زيادة"]').click(); await page.locator('.sheet .qty button[aria-label="زيادة"]').click();
  await page.locator('.sheet label:has-text("الاسم") input').fill("سارة");
  await page.locator('.sheet label:has-text("رقم الجوال") input').fill("0566666666");
  check("booking total 650×3=1950", (await page.locator(".summary .total").innerText()).includes("1,950"));
  await shot(page, "16-booking-form");
  await page.getByText("إرسال طلب الحجز عبر واتساب").click(); await page.getByText("تم تجهيز طلبك").waitFor();
  const bm = await lastWa(page);
  check("booking message", bm.includes("إشعار طلب حجز 📅") && bm.includes("#BK-") && bm.includes("• المدة: 3 ليلة") && bm.includes("• الإجمالي: *1,950.00 ﷼*") && bm.includes("• تاريخ الخروج:"));
  await page.close();

  const ie = await mk("itqan", "inquiry", "theme-realestate");
  await sql(`insert into products (store_id,category,name,description,price,options_json) values ($1,'فلل للبيع','فيلا حي الملقا','واجهة شمالية، تشطيب فاخر',2400000,'{"specs":[{"label":"المساحة","value":"450م²"},{"label":"الغرف","value":"6"},{"label":"عمر العقار","value":"جديد"}]}')`, [ie]);
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=nope`);
  await sql("update products set image_url=$1 where store_id=$2", [await seedImage(page, "seed/re1.png", "🏠", "#bfdbfe", "#1e3a8a", 900, 600), ie]);
  await page.goto(`${BASE}/?store=itqan`); await page.locator(".listing").first().waitFor();
  await shot(page, "17-inquiry-home");
  await page.locator(".listing").first().click(); await page.getByText("اطلب معاينة / استفسر").click();
  await page.locator(".sheet .choice >> text=حجز مبدئي").click();
  await page.locator('.sheet label:has-text("الاسم") input').fill("خالد");
  await page.locator('.sheet label:has-text("رقم الجوال") input').fill("0577777777");
  await shot(page, "18-inquiry-form");
  await page.getByText("إرسال الطلب عبر واتساب").click(); await page.getByText("تم تجهيز طلبك").waitFor();
  const im = await lastWa(page);
  check("inquiry message", im.includes("إشعار طلب حجز مبدئي 🏢") && im.includes("• فيلا حي الملقا") && im.includes("▫️ المساحة: 450م²"));
  await page.close();

  const cy = await mk("albir", "charity", "theme-charity", "iban_number=SA0380000000608010167519");
  await sql(`insert into products (store_id,category,name,description,price) values ($1,'المبادرات','سقيا الماء','توفير برادات مياه للمساجد',50),($1,'المبادرات','كفالة يتيم','كفالة شهرية',300)`, [cy]);
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=albir`); await page.locator(".iban-box").first().waitFor();
  await shot(page, "19-charity-home");
  await page.locator(".product", { hasText: "كفالة يتيم" }).click();
  await page.locator(".sheet .amounts >> text=مفتوح").click();
  await page.locator('.sheet input[placeholder="اكتب المبلغ"]').fill("750");
  await page.locator('.sheet label:has-text("رقم الجوال") input').fill("0588888888");
  await shot(page, "20-charity-form");
  await page.getByText("إرسال إشعار التبرع عبر واتساب").click(); await page.getByText("تم تجهيز طلبك").waitFor();
  const cm = await lastWa(page);
  check("charity message", cm.includes("إشعار تبرع 💚") && cm.includes("• المبادرة: كفالة يتيم") && cm.includes("• المبلغ: *750.00 ﷼*") && cm.includes("فاعل خير"));
  await page.close();

  const lg = await mk("adala", "legal", "theme-legal");
  await sql(`insert into products (store_id,category,name,description,price) values ($1,'التخصصات','قضايا تجارية','نزاعات الشركات والعقود',500),($1,'التخصصات','أحوال شخصية','',300),($1,'التخصصات','صياغة العقود','',0)`, [lg]);
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=adala`); await page.locator(".product").first().waitFor();
  await shot(page, "21-legal-home");
  await page.locator(".cta-bar .btn").click();
  await page.locator(".sheet .choice >> text=عن بُعد").click();
  await page.locator(".sheet textarea").fill("نزاع مع شريك حول توزيع الأرباح");
  await page.locator('.sheet label:has-text("الاسم") input').fill("فهد");
  await page.locator('.sheet label:has-text("رقم الجوال") input').fill("0599999999");
  await shot(page, "22-legal-form");
  await page.getByText("إرسال طلب الاستشارة عبر واتساب").click(); await page.getByText("تم تجهيز طلبك").waitFor();
  const lm = await lastWa(page);
  check("legal message", lm.includes("إشعار طلب استشارة ⚖️") && lm.includes("#LG-") && lm.includes("• النوع: عن بُعد") && lm.includes("نزاع مع شريك"));
  await page.close();

  /* ---------- 4b) V2: coupons, zones, min order, stock, sale price, orders log, reorder, calendar, hours ---------- */
  console.log("\n[V2 features]");
  const [{ id: v2 }] = await sql(`insert into stores (slug,name,whatsapp_phone,business_mode,theme_style,min_order,delivery_zones)
    values ('v2shop','مطبخ الحي','966500000009','order','theme-restaurant',30,'[{"name":"النرجس","fee":10},{"name":"الملقا","fee":15}]') returning id`);
  await sql(`insert into products (store_id,category,name,price,stock,options_json,sort_order) values
    ($1,'وجبات','شاورما',15,2,'{"old_price":20}',1), ($1,'وجبات','عصير',5,null,'{}',2)`, [v2]);
  const [{ tok: v2tok }] = await sql("select private.new_session($1, interval '1 hour', false) tok", [v2]);

  // التاجر: إنشاء كوبون + ترتيب الأصناف
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/manage?store=v2shop#t=${v2tok}`);
  await page.locator(".pcard").first().waitFor();
  await page.click(".bottom-nav >> text=العروض");
  await page.getByText("+ كوبون").click();
  await page.locator('.sheet label:has-text("الكود") input').fill("welcome");
  await page.locator('.sheet label:has-text("نسبة الخصم") input').fill("10");
  await page.getByText("إنشاء الكوبون").click();
  await page.locator(".coupon-row", { hasText: "WELCOME" }).waitFor();
  check("merchant creates coupon (uppercased)", (await sql("select code, kind, value from private.coupons where store_id=$1", [v2]))[0]?.code === "WELCOME");
  await page.click(".bottom-nav >> text=المنيو");
  await page.getByText("↕️ ترتيب").click();
  await page.locator('button[aria-label="تحريك شاورما للأسفل"]').click();
  const ord = await waitDb(`select string_agg(name, ',' order by sort_order) o from products where store_id='${v2}'`, (r) => r.o === "عصير,شاورما");
  check("merchant reorders items with arrows", ord.o === "عصير,شاورما", ord.o);
  await shot(page, "v2-merchant-reorder");
  await page.close();

  // العميل: سعر قبل الخصم، حد المخزون، المناطق، الحد الأدنى، الكوبون
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=v2shop`);
  await page.locator(".hero-name").waitFor();
  check("sale price shows old price struck through", (await page.locator(".product", { hasText: "شاورما" }).locator(".old-price").innerText()).includes("20"));
  check("low stock badge", await page.locator(".product", { hasText: "شاورما" }).getByText("باقي 2 فقط").isVisible());
  await page.locator(".product", { hasText: "شاورما" }).click();
  await page.waitForTimeout(400);
  for (let i = 0; i < 3; i++) await page.locator('.sheet .qty button[aria-label="زيادة"]').click();
  check("stepper capped by stock", (await page.locator(".sheet .qty output").innerText()) === "2");
  await page.locator(".sheet-foot .btn").click();
  await page.locator(".cta-bar .btn").click();
  await page.locator('.sheet label:has-text("الاسم") input').fill("سلمان");
  await page.locator('.sheet label:has-text("رقم الجوال") input').fill("0511111111");
  check("min order warning below 30 (subtotal 30 ok)", !(await page.locator(".min-warn").count()));
  await page.getByText("إرسال الطلب عبر واتساب").click();
  check("zone must be chosen", await page.getByText("اختر الحي من القائمة").isVisible() && (await page.evaluate(() => window.__opened.length)) === 0);
  await page.locator('.sheet label:has-text("الحي") select').selectOption("1");
  await page.locator('.sheet input[placeholder="كود الخصم"]').fill("welcome");
  await page.locator(".sheet").getByRole("button", { name: "تطبيق" }).click();
  await page.getByText("تم تطبيق الكود WELCOME").waitFor();
  const billTxt = await page.locator(".bill").innerText();
  check("bill: zone fee 15 + coupon -3 = 42", billTxt.includes("15") && billTxt.includes("-3") && billTxt.includes("42"), billTxt.replace(/\n/g, " | "));
  await shot(page, "v2-checkout-coupon-zone");
  await page.waitForTimeout(31000); // مهلة الإرسال من طلب سابق في نفس المتصفح
  await page.getByText("إرسال الطلب عبر واتساب").click();
  await page.getByText("تم تجهيز طلبك").waitFor();
  const v2msg = await lastWa(page);
  check("message has discount, zone fee and total", v2msg.includes("• الخصم (WELCOME): -3.00 ﷼") && v2msg.includes("• التوصيل: 15.00 ﷼") && v2msg.includes("• الإجمالي: *42.00 ﷼*") && v2msg.includes("📍 العنوان: الملقا"));
  const [after] = await sql("select (select stock from products where name='شاورما' and store_id=$1) stock, (select used from private.coupons where store_id=$1) used", [v2]);
  check("order decrements stock and counts coupon use", after.stock === 0 && after.used === 1, JSON.stringify(after));
  await page.goto(`${BASE}/?store=v2shop`); await page.locator(".hero-name").waitFor();
  check("sold-out item shown unavailable", await page.locator(".product.unavailable", { hasText: "شاورما" }).count() === 1);
  await page.close();

  // التاجر: سجل الطلبات + الإلغاء يرجع المخزون + الإحصائيات
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/manage?store=v2shop#t=${v2tok}`);
  await page.locator(".orders-btn .nbadge").waitFor();
  check("new-orders badge on header", (await page.locator(".orders-btn .nbadge").innerText()) === "1");
  await page.locator(".orders-btn").click();
  await page.locator(".ocard").first().waitFor();
  const oc = await page.locator(".ocard").first().innerText();
  check("orders log shows order details", oc.includes("#ORD-1001") && oc.includes("سلمان") && oc.includes("WELCOME") && oc.includes("الملقا"), oc.split("\n").slice(0, 3).join(" | "));
  await shot(page, "v2-orders-log");
  check("order card shows verification code", /رمز التحقق:\s*[A-Z2-9]{4}/.test(oc));
  await page.locator(".verify-box input").fill("1001"); await page.locator(".verify-box > .row button").click();
  await page.locator(".verify-box .ocard").waitFor();
  check("verify box finds order by number", (await page.locator(".verify-box .ocard").innerText()).includes("#ORD-1001"));
  await shot(page, "v2-orders-verify");
  await page.locator(".verify-box input").fill("9999"); await page.locator(".verify-box > .row button").click();
  await page.locator(".verify-box .alert-danger").waitFor();
  check("verify box rejects unknown order number", (await page.locator(".verify-box .alert-danger").innerText()).includes("لا يوجد طلب"));
  await page.locator(".ocard").first().getByRole("button", { name: "إلغاء" }).click();
  await page.locator(".sheet").last().locator(".sheet-foot .btn").first().click();
  const rs = await waitDb(`select stock from products where name='شاورما' and store_id='${v2}'`, (r) => r.stock === 2);
  check("cancel restores stock", rs.stock === 2);
  await page.keyboard.press("Escape");
  await page.locator(".p-stat").first().click();
  await page.locator(".chart-bars .bar").first().waitFor();
  check("insights: 14 daily bars, cancelled order excluded from top items", (await page.locator(".chart-bars").first().locator(".bar").count()) === 14 && (await page.locator(".hbar").count()) === 0 && await page.getByText("لا توجد بيانات بعد").isVisible());
  await shot(page, "v2-insights");
  await page.close();

  // التقويم: الأيام المحجوزة
  const [{ d0, d1, d2 }] = await sql("select to_char((now() at time zone 'Asia/Riyadh')::date,'YYYY-MM-DD') d0, to_char((now() at time zone 'Asia/Riyadh')::date+1,'YYYY-MM-DD') d1, extract(day from (now() at time zone 'Asia/Riyadh')::date+2)::int d2");
  await sql(`update products set options_json = options_json || jsonb_build_object('blocked_dates', jsonb_build_array($1::text, $2::text)) where name='شاليه الياسمين'`, [d0, d1]);
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=oasis`); await page.locator(".listing").first().waitFor();
  await page.locator(".listing").first().click(); await page.getByText("احجز هذه الوحدة").click();
  await page.locator(".cal").waitFor();
  const selDay = await page.locator(".cal-day.sel").first().innerText().catch(() => "");
  check("booking calendar skips booked days", (await page.locator(".cal-day.busy").count()) >= 1 && selDay === String(d2), `sel=${selDay} expected=${d2}`);
  await shot(page, "v2-booking-calendar");
  await page.close();

  // أوقات لكل يوم: مفتوح بكرة فقط
  const [{ wd }] = await sql("select extract(dow from (now() at time zone 'Asia/Riyadh')::date + 1)::int wd");
  await sql(`update stores set hours_json = jsonb_build_object($1::text, jsonb_build_array(jsonb_build_object('o','10:00','c','22:00'))) where slug='itqan'`, [String(wd)]);
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=itqan`); await page.locator(".hero-name").waitFor();
  check("per-day hours: closed today, opens tomorrow", await page.getByText("يفتح بكرة الساعة").isVisible());
  await page.close();

  // الإنجليزية في اللوحات
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/manage?store=v2shop&lang=en#t=${v2tok}`);
  await page.locator(".pcard").first().waitFor();
  const mEn = await page.evaluate(() => ({ dir: document.documentElement.dir, body: document.body.innerText }));
  check("merchant dashboard in English (LTR)", mEn.dir === "ltr" && mEn.body.includes("Menu") && mEn.body.includes("Visits today") && !mEn.body.includes("زيارات اليوم"));
  await shot(page, "v2-merchant-en");
  await page.close();

  // الإدارة: سجل العمليات + الحذف النهائي
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/admin`);
  await page.fill('input[type="email"]', "admin@test.com"); await page.fill('input[type="password"]', "secret"); await page.click('button[type="submit"]');
  await page.locator(".scard").first().waitFor();
  await page.locator('[aria-label="سجل العمليات"]').click();
  await page.locator(".audit-row").first().waitFor();
  check("admin audit log lists actions", (await page.locator(".audit-row").count()) >= 2);
  await page.keyboard.press("Escape");
  await page.locator(".scard", { hasText: "مطبخ الحي" }).getByText("✏️ تعديل / PIN").click();
  await page.getByText("🗑️ حذف المتجر نهائياً").click();
  await page.locator('.sheet input[placeholder="v2shop"]').fill("v2shop");
  await page.getByText("حذف نهائي").click();
  await page.getByText("نهائياً").first().waitFor();
  check("admin deletes store after typing slug", (await waitDb("select count(*)::int c from stores where slug='v2shop'", (r) => r.c === 0)).c === 0);
  await page.close();

  /* ---------- 5) Closed / overnight hours / suspended ---------- */
  console.log("\n[Hours & status]");
  const [{ h: hNow }] = await sql("select extract(hour from now() at time zone 'Asia/Riyadh')::int h");
  const fmt = (x) => `${String((x + 24) % 24).padStart(2, "0")}:00`;
  await sql("update stores set open_time=$1, close_time=$2 where slug='test-rest'", [fmt(hNow + 1), fmt(hNow)]); // overnight wrap: closed between close (this hour) and open (next hour)
  page = await newPage(browser, errors);
  await page.goto(`${BASE}/?store=test-rest`); await page.locator(".hero-name").waitFor();
  check("overnight schedule: closed in the 1h gap", await page.getByText(/مغلق الآن — يفتح (بكرة )?الساعة/).isVisible());
  await shot(page, "23-store-closed");
  await sql("update stores set open_time=$1, close_time=$2 where slug='test-rest'", [fmt(hNow - 1), fmt(hNow - 2)]); // overnight wrap, open now
  await page.reload(); await page.locator(".hero-name").waitFor();
  check("overnight schedule: open across midnight", await page.locator(".sf-info .dot.on").isVisible());
  await sql("update stores set is_open=false where slug='test-rest'");
  await page.reload(); await page.locator(".hero-name").waitFor();
  check("emergency close", await page.getByText("مغلق الآن مؤقتاً").isVisible());
  await sql("update stores set expires_at=now()-interval '1 day' where slug='test-rest'");
  await page.reload();
  await page.getByText("متوقفة مؤقتاً").waitFor();
  check("expired → suspended screen", true);
  await shot(page, "24-store-suspended");
  await page.close();

  console.log("\n[Errors]");
  check("no null/undefined/NaN rendered", badText.length === 0, badText.join(", "));
  check("no horizontal overflow on any page", overflowBad.length === 0, overflowBad.join(", "));
  check("no JS errors in console", errors.length === 0, errors.join(" | "));
  await browser.close(); server.close(); await db.end();
  const failed = results.filter((r) => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
