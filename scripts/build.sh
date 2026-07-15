#!/bin/sh
# Build the cross-platform binaries into bin/ (gitignored). These are NOT
# committed — distribution is via GitHub Releases: CI runs the same build on a
# `v*` tag and uploads the artifacts, and scripts/fetch.sh downloads the right
# one at install time. Run this for local testing or to reproduce a release
# build by hand.
set -eu
cd "$(dirname "$0")/.."
mkdir -p bin
for pair in linux/arm64 linux/amd64 darwin/arm64 darwin/amd64; do
  os=${pair%/*}; arch=${pair#*/}
  label=$( [ "$os" = darwin ] && echo macos || echo "$os" )
  GOOS="$os" GOARCH="$arch" CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" \
    -o "bin/herdview_${label}_${arch}" ./cmd/herdview
  echo "built bin/herdview_${label}_${arch}"
done
