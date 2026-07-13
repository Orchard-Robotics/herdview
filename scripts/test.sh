#!/usr/bin/env bash
# herdview test suite:
#   1. Go unit tests (pure logic: transcript parsing, pane-id, guard).
#   2. Browser e2e (Playwright + Chromium) driving the real UI against a mock
#      herdr and a controllable fake Claude transcript.
#
# Chromium lives on /mnt/storage because this Jetson's root partition is tiny.
set -euo pipefail
cd "$(dirname "$0")/.."

export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/mnt/storage/ms-playwright}"
GO="${GO:-$HOME/.local/go/bin/go}"

echo "== Go unit tests =="
"$GO" test ./...

echo
echo "== Browser e2e (Playwright) =="
cd test
exec npx playwright test "$@"
