// Package web holds herdview's embedded frontend assets. Keeping the embed
// directive beside the files lets go:embed reach them (it cannot climb to a
// parent directory from cmd/herdview).
package web

import "embed"

// FS is rooted at this directory, so index.html is served at "/".
//
//go:embed index.html
var FS embed.FS
