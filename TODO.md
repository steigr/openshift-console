# TODO

## Done

- [x] Categorise the 54 legacy patches into topics (see `PLAN.md`).
- [x] Strip debug-only patches (0016, 0021, 0023, 0025, 0031, 0034, 0038,
      0040, 0044, 0045, 0047).
- [x] Reconstruct net effect of all legacy patches and consolidate into 8
      topic patches against upstream `release-5.1`:
  - `patches/0001-build-system.patch`
  - `patches/0002-internal-endpoints.patch`
  - `patches/0003-user-attribute-fixes.patch`
  - `patches/0004-user-impersonation.patch`
  - `patches/0005-user-roles-and-memberships.patch`
  - `patches/0006-node-terminal-podspec-via-configmap.patch`
  - `patches/0007-namespace-filtering.patch`
  - `patches/0008-navigation-extensions.patch`
- [x] Re-port `0008-navigation-extensions.patch` against the much larger
      release-5.1 `console-extensions.json` (no more `routes`/`ingresses`
      anchors – additions sit alongside existing sections; the new
      `httproutes`/`tcproutes`/`tlsroutes` ordering is preserved without
      depending on a `networkpolicies` entry that no longer exists
      upstream).
- [x] Reorder topics so dependencies (OIDC v3 vendoring, group filter)
      sit after the user-attribute / user-id-field plumbing they rely on.
- [x] Replace `scripts/patch.sh` with a `git apply`-based loop (correctly
      handles file deletions, renames and the OIDC v3 vendor refresh that
      GNU `patch` mis-handles).
- [x] Archive the 54 legacy patches under `patches.legacy/`.
- [x] Validate end-to-end:
  - `bash scripts/clone.sh && bash scripts/patch.sh` applies cleanly to
    `release-5.1`.
  - `cd console && bash build-backend.sh` produces `bin/bridge`.
  - `frontend/packages/console-app/console-extensions.json` parses as
    JSONC (line-comment stripped JSON).

## Open / Follow-up

- [ ] Run `bash build-frontend.sh` (yarn install + webpack) in CI to
      confirm the frontend bundle still builds against the new
      `console-extensions.json`.
- [ ] Once verified in CI, delete `patches.legacy/`.
- [ ] Consider rebasing `0004-user-impersonation.patch` to drop the
      `vendor/gopkg.in/square/go-jose.v2` deletion noise by regenerating
      `go mod vendor` against a `gopkg.in`-free `go.mod`.

