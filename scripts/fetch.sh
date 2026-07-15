#!/bin/sh
# Build step for `herdr plugin install`: download the prebuilt herdview binary
# for this OS/arch from the repo's latest GitHub Release, verify its SHA-256, and
# place it at ./herdview.
#
# herdr runs this in the plugin checkout root with normal PATH + network but a
# SCRUBBED herdr environment (no HERDR_* vars), so this relies only on relative
# paths and the public release URL. The repo is public, so the release download
# needs no auth. Override the source repo with HERDVIEW_REPO=owner/repo (forks).
set -eu

REPO="${HERDVIEW_REPO:-Orchard-Robotics/herdview}"
# Where release assets live. Defaults to this repo's latest GitHub Release;
# override with HERDVIEW_RELEASE_BASE to install from a fork, a mirror, or a
# local server (also how the install path is tested).
BASE="${HERDVIEW_RELEASE_BASE:-https://github.com/${REPO}/releases/latest/download}"

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

asset="herdview_${os}_${arch}"

# Download <url> to <dest> with curl or wget, whichever is present.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    echo "herdview: need curl or wget to download the binary" >&2; exit 1
  fi
}

tmpbin="herdview.tmp.$$"
tmpsum="SHA256SUMS.$$"
trap 'rm -f "$tmpbin" "$tmpsum"' EXIT

echo "herdview: downloading $asset from ${REPO} latest release ..."
fetch "${BASE}/${asset}" "$tmpbin"
fetch "${BASE}/SHA256SUMS" "$tmpsum"

# Verify the checksum before trusting the binary.
expected="$(awk -v f="$asset" '$2 == f {print $1}' "$tmpsum")"
if [ -z "$expected" ]; then
  echo "herdview: $asset not listed in SHA256SUMS — release looks incomplete" >&2; exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmpbin" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "$tmpbin" | awk '{print $1}')"
else
  echo "herdview: need sha256sum or shasum to verify the download" >&2; exit 1
fi
if [ "$expected" != "$actual" ]; then
  echo "herdview: checksum mismatch for $asset" >&2
  echo "  expected $expected" >&2
  echo "  got      $actual" >&2
  exit 1
fi

chmod +x "$tmpbin"
[ "$os" = macos ] && xattr -d com.apple.quarantine "$tmpbin" 2>/dev/null || true
# Rename into place so reinstalling while the server runs can't hit "text file
# busy" (rename swaps the inode; the running process keeps its old one).
mv -f "$tmpbin" herdview
echo "herdview: installed ./herdview ($asset, checksum verified)"

# Start the mirror now, so `herdr plugin install` alone brings herdview up with no
# manual step. --detach is idempotent and returns immediately (so it can't block
# or fail the install), and the pane.focused event hook re-ensures it later. The
# build env is scrubbed of HERDR_* vars, and $PATH may be unusable (cameras carry
# a literal, unexpanded "~/.local/bin"), so resolve herdr robustly and hand the
# server its path. (The binary has the same fallbacks, so this is belt-and-braces.)
herdr_bin="$(command -v herdr 2>/dev/null || true)"
for c in "$HOME/.local/bin/herdr" /usr/local/bin/herdr /usr/bin/herdr; do
  [ -n "$herdr_bin" ] && break
  [ -x "$c" ] && herdr_bin="$c"
done
HERDR_BIN_PATH="$herdr_bin" ./herdview --detach || true

# --- Moshi host agent (optional) ---
# The Moshi phone app detects hosted apps via a moshi-hook daemon on this host.
# A plugin install must not silently install third-party software, so: if
# moshi-hook is already present we just make sure its daemon is up; otherwise we
# only point you at it. All best-effort — never fail the install over Moshi.
MH="$(command -v moshi-hook 2>/dev/null || true)"
[ -n "$MH" ] || { [ -x "$HOME/.local/bin/moshi-hook" ] && MH="$HOME/.local/bin/moshi-hook"; }
if [ -n "$MH" ] && [ -x "$MH" ]; then
  "$MH" service install >/dev/null 2>&1 || ("$MH" serve >/dev/null 2>&1 &) || true
  echo "herdview: moshi-hook daemon ensured (pair once: $MH pair --token <token> --store file)"
else
  echo "herdview: (optional) to view on the Moshi phone app, install moshi-hook — https://getmoshi.app"
fi
