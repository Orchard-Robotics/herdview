# Friendly path-based URL (`myhost/herdview`)

**Status:** Tabled — documented, not scheduled.

## Goal

Reach herdview at a friendly, portless, HTTPS URL like
`https://myhost.tailnet.ts.net/herdview` instead of
`http://myhost.tailnet.ts.net:8848`. The **path** scheme (rather than a
bare host) is preferred so multiple tools can live under one tailnet host:
`myhost/herdview`, `myhost/<other-tool>`, etc.

## Current state

herdview is reached by tailnet IP/MagicDNS + port `:8848`. The live dev instance
currently binds `0.0.0.0:8848` with `HERDVIEW_ALLOW_HOSTS=*` (see the wildcard
opt-out in `guard`).

## Approach

1. **Tailscale Serve, path mount** (verified available on this node; MagicDNS +
   HTTPS certs are enabled):
   ```
   tailscale serve --set-path /herdview 8848
   ```
   → serves `https://<magicdns>/herdview` → `localhost:8848`. Runs as the
   tailscale operator/root; the serve config persists across reboots. Repeat with
   other `--set-path` values to host more tools under the same host.

2. **Make herdview base-path-aware** (the actual work). Today the frontend uses
   **origin-absolute URLs** — `fetch("/api/pane/…")`, `/vendor/…`, and the
   importmap. Under a `/herdview` subpath the browser resolves those against the
   root (`https://host/api`, `https://host/vendor`), which are outside the mount →
   404. To serve under a subpath:
   - Frontend derives its mount path from where it loaded and prefixes every
     fetch / asset / importmap URL (so it works at `/`, `/herdview`, or anything —
     no hardcoded prefix).
   - Handle the `<base href>` + trailing-slash + importmap-resolution edge cases.
   - Verify whether Tailscale Serve strips the `/herdview` prefix before
     forwarding; add a Go `http.StripPrefix` if it does not.
   - Add a base-path e2e test so it can't silently regress.

   Once loopback-only + fronted by Serve, also rebind herdview from `0.0.0.0`
   back to `127.0.0.1:8848` and tighten `HERDVIEW_ALLOW_HOSTS` (Serve becomes the
   only ingress, HTTPS + tailnet-identity gated — strictly more secure than the
   current wildcard/all-interfaces bind).

## Effort

Bounded but real: ~1 focused hour of frontend base-path plumbing + edge cases +
a test, plus one `tailscale serve` command. Not the 5-minute option.

## Simpler alternative (for contrast)

If we only ever expose herdview (not multiple tools), a **bare-host** Serve mount
gives the same friendliness for ~5 minutes and **no app changes**:
```
tailscale serve 8848            # → https://myhost.tailnet.ts.net  (no port, HTTPS)
```
herdview's absolute URLs work as-is at the root. The path scheme is only worth
the extra work if we want `myhost/<tool>` for several tools.

## Related

- Detached/always-on lifecycle (systemd/plugin) is a separate prerequisite for
  this to be useful unattended — herdview currently runs as a hand-launched
  process.
