// Package web holds herdview's embedded frontend assets. Keeping the embed
// directive beside the files lets go:embed reach them (it cannot climb to a
// parent directory from cmd/herdview).
package web

import "embed"

// FS is rooted at this directory, so index.html is served at "/" and the
// vendored ES modules (Preact/hooks/htm — no build step, no CDN) at "/vendor/".
//
//go:embed index.html vendor
var FS embed.FS
