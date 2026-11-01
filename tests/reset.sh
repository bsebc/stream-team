#!/bin/sh
# reset.sh <db> [new]  — load the mirror of the live schema + sample data into a
# local database; with "new", also apply every migration in supabase/migrations.
cd "$(dirname "$0")"
P="psql -h 127.0.0.1 -p ${PGPORT:-54329} -U postgres -q -v ON_ERROR_STOP=1 -d $1"
$P -f sql/00_live_baseline.sql -f sql/01_seed.sql >/dev/null 2>&1 || { echo "reset failed"; exit 1; }
if [ "$2" = "new" ]; then
  for f in ../supabase/migrations/*.sql; do $P -f "$f" >/dev/null 2>&1 || { echo "migration failed: $f"; exit 1; }; done
fi
echo "reset $1 $2"
