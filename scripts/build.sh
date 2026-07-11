#!/bin/sh
# Rebuild the committed cross-platform binaries in bin/ after code changes,
# then commit them. (This repo ships binaries directly so `herdr plugin install`
# needs no download/auth from the private repo.)
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
