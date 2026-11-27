#!/usr/bin/env bash
# يشغّل اختبارات قاعدة البيانات على Postgres محلي (قاعدة مؤقتة sqltest تُنشأ من جديد)
# الاستخدام: PGHOST=/var/run/postgresql PGPORT=5432 ./tests/sql/run.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
P="psql -U ${PGUSER:-postgres} -q"
$P -d postgres -c "drop database if exists sqltest with (force)" -c "create database sqltest"
$P -d postgres -c "do \$\$ begin create role anon nologin; exception when duplicate_object then null; end \$\$" \
                -c "do \$\$ begin create role authenticated nologin; exception when duplicate_object then null; end \$\$" \
                -c "do \$\$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end \$\$"
sed 's/create role[^;]*;//g; s/create publication[^;]*;//' tests/e2e/supabase-stubs.sql | $P -d sqltest -f - >/dev/null
for m in supabase/migrations/*.sql; do $P -v ON_ERROR_STOP=1 -d sqltest -f "$m" >/dev/null 2>&1 || { echo "migration failed: $m"; exit 1; }; done
for t in tests/sql/0*.sql; do echo "=== $t"; $P -d sqltest -f "$t" 2>&1 | grep -v "^CONTEXT\|^PL/pgSQL\|^SQL statement\|^LINE\|^ *\^\|^DETAIL"; done
