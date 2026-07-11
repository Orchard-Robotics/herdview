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
