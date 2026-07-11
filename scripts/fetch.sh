#!/bin/sh
# Build step for `herdr plugin install`: select the prebuilt binary committed to
# this repo for the current OS/arch and place it at ./herdview.
#
# No download and no auth — works cleanly from a private repo (herdr has already
# cloned the checkout, binaries included).
set -eu

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
case "$os" in
  linux) os=linux ;;
  darwin) os=macos ;;
  *) echo "herdview: unsupported OS '$os'" >&2; exit 1 ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "herdview: unsupported arch '$arch'" >&2; exit 1 ;;
esac

src="bin/herdview_${os}_${arch}"
if [ ! -f "$src" ]; then
  echo "herdview: no prebuilt binary at $src (rebuild with scripts/build.sh)" >&2
  exit 1
fi
# write to a temp file then rename, so a reinstall while the server is running
# doesn't fail with "text file busy" (rename replaces the in-use inode cleanly).
tmp="herdview.tmp.$$"
cp "$src" "$tmp"
chmod +x "$tmp"
mv -f "$tmp" herdview
echo "herdview: installed ./herdview (from $src)"

# --- Moshi host agent (optional, for viewing on the phone via the Moshi app) ---
# Moshi's in-app "hosted app" detection is powered by moshi-hook running on this
# host. Install it if missing and make sure its daemon is up. All best-effort —
# never fail the herdview install over it (e.g. no network, or you don't use Moshi).
if ! command -v moshi-hook >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/moshi-hook" ]; then
  echo "herdview: installing moshi-hook (Moshi host agent, for phone access) ..."
  curl -fsSL https://getmoshi.app/install.sh | sh || echo "herdview: moshi-hook install skipped (non-fatal)"
fi
MH="$(command -v moshi-hook 2>/dev/null || true)"; [ -n "$MH" ] || MH="$HOME/.local/bin/moshi-hook"
if [ -x "$MH" ]; then
  # start the daemon: prefer a persistent systemd user service, else background serve
  if ! "$MH" service install >/dev/null 2>&1; then
    ("$MH" serve >/dev/null 2>&1 &) || true
  fi
  echo "herdview: moshi-hook daemon ensured — to link your phone, pair once:"
  echo "         $MH pair --token <token from the Moshi app> --store file"
fi
