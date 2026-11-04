#!/bin/bash
# usage: run.sh script.py  (starts the harness backend, runs the script, stops the backend)
cd "$(dirname "$0")"
node server.mjs > /tmp/srv.log 2>&1 &
SP=$!; sleep 1.5
python3 "$@"; RC=$?
kill $SP 2>/dev/null; exit $RC
