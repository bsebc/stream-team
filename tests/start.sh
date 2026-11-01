#!/bin/sh
# start.sh <port> <db> [site] [function]  — (re)start one local stack
cd "$(dirname "$0")"
PORT=$1; DB=$2; SITE=${3:-..}; FN=${4:-../supabase/functions/notify/index.ts}
[ -f /tmp/st-$PORT.pid ] && kill $(cat /tmp/st-$PORT.pid) 2>/dev/null
sleep 0.5
PORT=$PORT PGDB=$DB SITE=$(cd "$SITE" && pwd) FUNC=$(cd "$(dirname "$FN")" && pwd)/$(basename "$FN") nohup node server.mjs > /tmp/st-$PORT.log 2>&1 &
echo $! > /tmp/st-$PORT.pid
sleep 2.5
head -2 /tmp/st-$PORT.log
