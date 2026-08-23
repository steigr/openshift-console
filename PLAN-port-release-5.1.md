# Port Consolidated Patches to `release-5.1`

## 1. Goal

Re-base the eight consolidated topic patches in `patches/` (built
against the **release-4.14** snapshot at commit
`d1491e5b5f79d5a0108a8241b45f4899c58e48f6`) onto the
`origin/release-5.1` branch of `openshift/console`
(currently HEAD `213ad5003ecf590a3e553c2aafa27de12b7afa41`,
"Merge pull request #16412 …"). This spans several OpenShift releases,
so substantial restructuring is expected.

After porting, the existing workflow must still hold:

```bash
bash scripts/clone.sh   # checks out release-5.1
bash scripts/patch.sh   # applies 0001…0008 cleanly
cd console && bash build-backend.sh && bash build-frontend.sh
```

## 2. Divergence assessment (release-5.1 vs old base)

Key files touched by our patches changed substantially:

| File | Δ (ins/del) | Notes |
|---|---|---|
| `cmd/bridge/main.go` | +333 / −390 | flag plumbing reshuffled |
| `pkg/server/server.go` | +306 / −413 | proxy / auth handlers reshuffled |
| `go.mod` | +173 / −163 | Go 1.25.7 toolchain; **still on go-oidc v2** |
| `frontend/package.json` | +175 / −208 | versions bumped |
| `Dockerfile` | +4 / −35 | base image switched |

Renamed / restructured paths our patches reference:

| Old path | New path on release-5.1 |
|---|---|
| `frontend/public/components/masthead-toolbar.jsx` | `frontend/public/components/masthead/masthead-toolbar.tsx` |
| `frontend/public/components/terminal.jsx` | `frontend/public/components/terminal.tsx` |
| `pkg/auth/auth.go`, `auth_oidc.go`, `loginstate.go` | split into `pkg/auth/oauth2/`, `pkg/auth/sessions/`, `pkg/auth/user.go`, `pkg/auth/types.go`, `pkg/auth/tokenreviewer.go` |
| `pkg/auth/metrics.go` | still present, but signature changed |

Dry-run `git apply --check` of every patch on release-5.1 fails (full
report captured during planning); **none** of the eight patches applies
unmodified.

## 3. Strategy — re-derive, don't reshuffle

Re-running `git apply` with `-3` would help only for the easy hunks.
Because the auth package was restructured and two `.jsx` files were
converted to `.tsx`, we redo the same "net-state" loop we used the
first time, but anchored on release-5.1.

### Phases

1. **Bootstrap**
   - `release-5.1` ← rename / update `scripts/clone.sh` to fetch
     `release-5.1` instead of the pinned commit. Keep
     `--depth=1 --no-tags`. Tag the checkout as `upstream`.

2. **Per-topic forward-port** — process patches in their existing
   numeric order. For each topic:
   1. `git checkout -b port/<topic> upstream`
   2. `git apply -3 patches/000N-<topic>.patch` and resolve the
      conflict markers.
   3. For paths that moved or were rewritten, port the change by hand
      into the new file (see §4 below).
   4. Run the topic-appropriate build:
      - Go-touching topics → `gofmt -w` then `GOFLAGS=-mod=vendor go build ./...`
      - Frontend-touching topics → at least `node -e "JSON.parse(require('fs').readFileSync('frontend/package.json'))"` plus `yarn install --silent` only on a final sanity branch (slow).
   5. Commit with the same subject the original patch had.

3. **Vendor refresh**
   - Topic 4 (User-Impersonation) again upgrades go-oidc v2 → v3 and
     pulls go-jose/v4. After the source-level edit:
     `GOFLAGS="" go mod tidy && GOFLAGS="" go mod vendor`.
   - Commit the vendor delta as part of patch 0004 so the patch stays
     self-contained.

4. **Export**
   - `git format-patch --no-renames -k upstream..HEAD -o patches.new/`
   - Rename outputs to the existing
     `0001-build-system.patch` … `0008-navigation-extensions.patch`
     filenames so `scripts/patch.sh` keeps working.
   - Move the current `patches/` to `patches.5.0/` for reference;
     replace with `patches.new/`.

5. **End-to-end verification**
   - Fresh `bash scripts/clone.sh && bash scripts/patch.sh`.
   - `cd console && bash build-backend.sh` (must produce `bin/bridge`).
   - `cd console && bash build-frontend.sh` (full yarn build; allow
     it to take the usual 15–25 min).

## 4. Per-topic forward-port notes

### 0001 build-system
- `Dockerfile` was rewritten on 5.1; re-apply our changes to the new
  layout (likely just FROM/RUN tweaks). Other build scripts may already
  match.

### 0002 internal-endpoints
- `cmd/bridge/main.go` changed heavily; relocate the
  `--internal-listen` flag and listener wiring next to the existing
  listener setup.

### 0003 user-attribute-fixes
- `frontend/public/components/masthead-toolbar.jsx` → port the
  `preferredUserIdentifier` lookup into
  `frontend/public/components/masthead/masthead-toolbar.tsx` (TS types
  required).
- Keep the `pkg/server/server.go` `init()` block; relocate to the new
  `init()`/handler the file now uses.
- Update the `frontend/yarn.lock` chunk by re-running yarn after the
  `package.json` resolution change instead of forcing the old hunk.

### 0004 user-impersonation
- Largest port. The old `pkg/auth/auth.go` / `auth_oidc.go` /
  `loginstate.go` are gone. The OIDC code now lives under
  `pkg/auth/oauth2/`. Re-derive the impersonation hooks against the
  new types in `pkg/auth/user.go` + `pkg/auth/oauth2/oidc.go`.
- Re-do the go-oidc v2 → v3 upgrade in `go.mod`/`go.sum` and refresh
  vendor (see §3 phase 3).
- Re-add the `Impersonate-User` header injection in
  `pkg/server/server.go` next to where the bearer token is now set.

### 0005 user-roles-and-memberships
- Update `pkg/auth/metrics.go` against its new signature.
- Re-add the `Impersonate-Group` header before
  `k8sProxy.ServeHTTP(w, r)`.

### 0006 node-terminal-podspec-via-configmap
- `frontend/public/components/terminal.jsx` →
  `frontend/public/components/terminal.tsx` (port the ConfigMap fetch
  and add minimal types).
- `frontend/packages/console-app/src/components/nodes/NodeTerminal.tsx`
  and `…/webterminal-plugin/.../Terminal.tsx` likely shifted only by
  imports/whitespace; re-anchor.
- `pkg/proxy/proxy.go` change is small; reapply at the new location.

### 0007 namespace-filtering
- `frontend/packages/console-shared/src/components/namespace/filters.ts`
  and `…/constants/common.ts` got new entries upstream; merge our list
  with theirs.

### 0008 navigation-extensions
- `frontend/packages/console-app/console-extensions.json` extension
  IDs may now collide with new upstream entries; re-check `id`
  uniqueness and ordering.

## 5. Tooling changes

- `scripts/clone.sh` — pin to `release-5.1`:
  ```bash
  branch=release-5.1
  git fetch --force --depth=1 --no-tags --prune --progress \
    --no-recurse-submodules https://github.com/openshift/console "$branch"
  git checkout FETCH_HEAD
  ```
- `scripts/patch.sh` — unchanged; already uses `git apply
  --whitespace=nowarn`.

## 6. Deliverables

1. Updated `scripts/clone.sh` (release-5.1).
2. Eight forward-ported patches under `patches/` (same filenames).
3. Old patch set preserved under `patches.5.0/`.
4. This plan kept as `PLAN-port-release-5.1.md` for traceability.
5. Verified `bin/bridge` build and `frontend/public/dist` build from a
   clean clone+patch.

## 7. Risk / open questions

- **OIDC v3 on Go 1.25** — release-5.1 is on Go 1.25.7 which already
  satisfies go-oidc v3's Go ≥ 1.23 requirement; no extra toolchain
  bump needed.
- **Auth restructure** — patch 0004/0005 may need genuine code
  rewrites (not just rebasing). I will keep the behaviour identical
  but the diff against upstream will look different from the 5.0 era.
- **Frontend build time** — full `yarn install && yarn run build` is
  slow; I will only run it on the final consolidated branch unless an
  earlier topic obviously breaks JS/TS.
- **Tests** — none of the original 54 patches added tests; I will not
  add new ones during the port.

---

Once you approve this plan I will execute phases 1–5 and report back
with the final patch set and build status.

