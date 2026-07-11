#!/bin/sh
# Build step for `herdr plugin install`: download the prebuilt herdview binary for
# this OS/arch from GitHub Releases. End users need no Go toolchain.
#
# Overridable: HERDVIEW_REPO (owner/repo), HERDVIEW_VERSION (tag, default latest).
set -eu

REPO="${HERDVIEW_REPO:-orchard-robotics/herdview}"
VERSION="${HERDVIEW_VERSION:-latest}"

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
if [ "$VERSION" = "latest" ]; then
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
else
  url="https://github.com/${REPO}/releases/download/${VERSION}/${asset}"
fi

echo "herdview: fetching ${asset} (${VERSION}) ..."
curl -fsSL "$url" -o herdview
chmod +x herdview
echo "herdview: installed ./herdview"
