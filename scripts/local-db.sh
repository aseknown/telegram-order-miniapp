#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${DB_NAME:-telegram-orders}"
PERSIST_DIR="${PERSIST_DIR:-.wrangler/state}"

mkdir -p "$PERSIST_DIR"

echo "==> Initializing local SQLite-backed D1 emulator"
npx wrangler d1 execute "$DB_NAME" \
  --local \
  --persist-to="$PERSIST_DIR" \
  --file=./migrations/0001_init.sql

echo
echo "Local database state is persisted under:"
echo "  $PERSIST_DIR"
echo
echo "Wrangler's local D1 uses SQLite-compatible local persistence."
