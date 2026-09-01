# terminal console plugin

Provides two independently switchable terminal *tabs*, each fully owned by the plugin (console
core produces no terminal UI of its own once a flag is on — see [Flags](#flags)):

- **Pod terminal**: a `console.tab/horizontalNav` Pod **Terminal** tab. A single merged
  "Connecting to" dropdown lists every VNC endpoint the pod opts into (see
  [opt-in contract](#pod-terminal-opt-in-contract)) first, then one plain entry per container.
  VNC entries render a noVNC session; plain entries get a real shell over the `pods/exec`
  subresource (`sh -i -c "TERM=xterm sh"`, or `cmd` on Windows — the same convention console
  core's own tab uses).
- **Node terminal**: a `console.tab/horizontalNav` Node **Terminal** tab — create a debug pod
  (using the same `node-terminal` ConfigMap/annotation convention as core's patch `0006`), let its
  privileged `node-terminal` shim (bundled here, `node-terminal/`) finish its own host-namespace
  setup, then `exec` a fresh interactive session into it (see
  [Session privacy](#node-terminal-session-privacy) for why `exec`, not `attach`, despite console
  core's own `NodeTerminal.tsx` using the latter).

Both tabs' plain-shell connections (Node's `attach`, Pod's `exec`) share one xterm.js
(`@xterm/xterm` 6) wrapper (`src/shared/Terminal.tsx`) with:
  - **Find**: `Ctrl+F`/`Cmd+F` (while the terminal is focused, or the find box itself) toggles a
    small overlay, top right — type to search, `Enter`/`Shift+Enter` for next/previous match,
    `Escape` or `Ctrl+F`/`Cmd+F` again to close. Backed by `@xterm/addon-search`.
  - **Sixel / iTerm image protocol**: rendered inline via `@xterm/addon-image`. The Node debug
    pod's `HAVE_SIXEL_SUPPORT=true` env var (see `src/node/debugPod.ts`) lets sixel-aware
    shells/tools detect this; a Pod's plain containers get no such hint (the pod spec isn't ours to
    edit), but the addon still renders sixel/iTerm output if a tool emits it unprompted.
  - **Font**: Victor Mono, patched with Nerd Font glyphs (`VictorMono Nerd Font Propo`, 4 weights
    bundled as woff2 under `src/shared/fonts/`, SIL OFL 1.1 — see `fonts/LICENSE.txt`), falling
    back to Red Hat Mono / monospace.

VNC entries (Pod tab only) render `src/pod/VncPodConsole.tsx` — noVNC, not a text terminal, so
none of the above (search/sixel/font) applies to it.

Neither tab can carry impersonation subprotocols the way console core's own terminal can: reading
impersonation state isn't part of the public `@openshift-console/dynamic-plugin-sdk` surface (only
console-internal Redux selectors expose it). An impersonating admin who needs that should flip the
relevant flag off to get core's own terminal back for the duration.

  The node-terminal shim needs its own container command wired to actually run (attach connects to
  whatever the container's own PID 1 is already doing — see `node-terminal/src/main.c`'s
  `run_idle_phase`, which is *all* PID 1 does without that command). The chart's
  `node-terminal-configmap.yaml` template sets it automatically once `nodeTerminal.homeVolume.enabled`
  is `true`, pointed at `homeVolume.mountPath` — that volume is a real prerequisite the shim's own
  `pipeline_run` requires before doing anything (`node-terminal/src/pipeline.c`'s
  `mountns_resolve_source`), but **needs no external CSI driver**: the default `homeVolume.type:
  emptyDir` works out of the box (kubelet backs a plain emptyDir with a real directory on the
  node's own disk, which is what the shim's bind-mount logic needs). Resolving *where* on the node
  that directory actually lives is a two-phase mountinfo lookup precisely so this doesn't assume
  `/var/lib/kubelet` is part of the node's root filesystem — a dedicated disk/ZFS dataset/LVM volume
  for kubelet data is a common setup where it isn't (see `node-terminal/src/mountns.c`'s
  `mountns_resolve_source` doc comment for the mechanics). `medium: Memory` still would not work —
  see the `homeVolume` comment in `values.yaml`. Switch `type` to `csi` once you have a driver
  providing *identity-mapped* (not ephemeral) home directories instead.

  With `homeVolume` left at its default `enabled: false`, the debug pod's PID 1 stays idle
  forever — and because the pod still requests a real `tty`, the **kernel's own PTY echoes typed
  characters back** even though nothing is reading them, which can look deceptively like a working
  shell (nothing you type actually runs). The "No output received yet" hint only catches the case
  where literally zero bytes come back, not this one — if commands you run don't do anything and
  nothing appears in `kubectl logs` beyond `idle phase, waiting for kubectl exec`, this is why.

## Node terminal: ephemeral account identity

Each Node Terminal session gets its own ephemeral host account, created by the shim
(`node-terminal/src/identity.c`) for the duration of the session and removed when it ends.

- **Account name**: the tab looks up the logged-in console user's own identity via a
  `SelfSubjectReview` (built into Kubernetes since 1.28 — `src/node/currentUser.ts`), sanitizes it
  to a POSIX-safe username, and passes it to the debug pod as `NODE_TERMINAL_REQUESTED_USER`. The
  shim independently validates it (`identity_valid_username()` — this is the real security
  boundary, since the value gets written straight into the host's `passwd`/`shadow`/`group` files)
  and falls back to the generic `k8s-sess-<hex>` scheme if it's missing, invalid, or collides with
  an existing host account. Either way the account is always ephemeral and UID-range-isolated
  (`SHIM_UID_RANGE_MIN`/`MAX` in `shim.h`) — this only affects the *name*.
- **Sudo/wheel inheritance**: optionally, every ephemeral account can be added to the same
  supplementary groups (sudo/wheel/admin-ish ones) as a real, cluster-admin-chosen reference
  account, via the chart's `nodeTerminal.sudoReferenceUser` value (rendered into the
  `node-terminal` ConfigMap as the `NODE_TERMINAL_SUDO_REFERENCE_USER` env var, read by
  `identity_inherit_groups()`). Deliberately **not** something the frontend or end user can pick
  themselves — that would be a privilege-escalation hole — and deliberately best-effort: an unset
  value, a reference user that doesn't exist on a given node, or a write failure just means the
  session gets no extra groups (logged, not fatal), so a config mistake can't lock an operator out
  of break-glass node access entirely.

## Node terminal session privacy

`pods/attach` (what console core's own `NodeTerminal.tsx` uses, and what this tab used to use)
connects to whatever the debug pod's container's own PID 1 is doing on its *primary* pty — the
same one CRI-O/`conmon` relays into the container's persistent log file. That means anyone with
`pods/log` RBAC on the ephemeral debug namespace (not just the operator who opened the tab) could
read the entire session transcript via `kubectl logs`, or any log-forwarding pipeline the cluster
runs — everything typed and displayed, silently.

This tab instead sets `NODE_TERMINAL_EXEC_MODE=true` on the debug pod (`debugPod.ts`) and uses
`pods/exec` for the interactive session (`node-terminal/src/pipeline.c`'s
`pipeline_run_exec_session()`, `--phase=exec-session`) — a `pods/exec` call gets its own separate,
transient pty that CRI-O does **not** persist to the container's log file, so the transcript is
only ever visible to whoever's actually holding that specific `exec` WebSocket. Console core's own
(unpatched) Node Terminal tab, and anything else pointed at the same shim image via the
`node-terminal` ConfigMap without setting that env var, is unaffected and keeps working exactly as
before (plain `pods/attach`, no privacy-mode behavior) — this only activates when this plugin's own
tab sets it.

Mechanically, this splits what used to be one process's job across two independent ones, both
`node-terminal-shim` invocations against the *same* container:

1. **PID 1** (the debug pod's own `command`, `--csi-path=...`) does all the privileged setup
   exactly as before (nsenter, identity, home mount, sudo/wheel group inheritance) — but instead of
   immediately running an interactive `login -f` session on its own pty, it publishes the resolved
   username to a marker file (`/run/node-terminal-active-user-<pod UID>` — `NODE_TERMINAL_POD_UID`,
   set via the Kubernetes downward API in `debugPod.ts`, so unrelated concurrent debug pods on the
   same node can't collide) and just waits.
2. **The `pods/exec` call** (a genuinely separate process, not a child of PID 1 — it starts fresh
   in the container's own namespaces, same as PID 1 originally did) does its *own* namespace/pty
   setup for the fresh pty this particular `kubectl exec` was given, polls briefly (up to 10s) for
   PID 1's marker file to appear (setup may still be in flight the instant `kubectl exec` is
   issued), then runs the same claim+`login -f` chain PID 1 used to run directly.

When that interactive session ends, the `exec` process signals PID 1 (`kill(1, SIGTERM)`) — only
PID 1 has the identity/UID/mount state to roll back correctly (it's the one that allocated the UID
and wrote the passwd/shadow/group/home-mount entries), so teardown still happens there, exactly as
before. A second `kubectl exec` against the same pod (if one somehow started before the first
ended) would just find the marker file already gone and log-and-exit rather than doing anything
destructive.

## Flags

The backend reads `POD_TERMINAL_ENABLED` / `NODE_TERMINAL_ENABLED` (both default `true`) and
serves them at `/config.json` (proxied by console at
`/api/plugins/terminal-console-plugin/config.json`). The frontend fetches that once at startup and
sets `TERMINAL_PLUGIN_POD_TERMINAL_ENABLED` / `TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED` accordingly.
For each tab, this plugin's own `console.tab/horizontalNav` extension only registers when its flag
is set, and console core's built-in tab (patch `0019` for Pod, `0020` for Node) hides itself only
when that same flag is set — so exactly one of the two is ever shown, never both and never
neither.

## Pod terminal opt-in contract

| key | kind | meaning |
| --- | --- | --- |
| `vnc.container.kubernetes.io/enabled: "true"` | label | pod participates at all |
| `vnc.container.kubernetes.io/endpoints` | annotation | JSON array, see below |

Without the annotation the pod's **first** container is assumed to serve unauthenticated VNC on
`5900`. With it, the annotation is a JSON array of:

```json
[
  { "container": "desktop", "port": 5900 },
  { "container": "app", "port": 5901, "auth": { "secretRef": { "name": "vnc-creds", "key": "password" } } },
  { "container": "vm", "port": 5900, "label": "Guest", "priority": 1 },
  { "container": "vm", "port": 5902, "label": "QEMU", "priority": 2 }
]
```

- `container` (required) must name a container in the pod; `port` defaults to `5900`.
- `auth` is optional. Prefer `secretRef` (`key` defaults to `"password"`) — the browser reads the
  Secret via console's own k8s API proxy, so ordinary Secret RBAC applies to the logged-in user,
  and the password never appears in the pod spec. An inline `{ "auth": { "password": "..." } }` is
  also accepted but **not recommended**: annotations are plain text, visible to anyone who can
  `get` the pod. If a server asks for a password no `auth` resolves (or resolution fails), the tab
  shows an inline password prompt instead of hanging.
- `label` is optional, shown verbatim in the merged dropdown (see below); without one, entries fall
  back to `VNC (<container>)`.
- `priority` is optional. It only orders VNC entries *among themselves* (lower sorts earlier) — VNC
  entries always sort before every container's plain Terminal entry regardless. Entries without a
  `priority` sort after every entry that has one, keeping their own relative position in this array
  (i.e. omitting `priority` everywhere is exactly annotation-array order, the previous default).
- The same `container` name may appear more than once — e.g. a VM container exposing both its
  hypervisor-level QEMU VNC and the guest OS's own in-VM VNC agent, on different ports. Only the
  *port* has to be pod-unique (containers share one network namespace): an entry naming an
  already-claimed port, an unknown container, or an invalid port is dropped; a value that isn't
  valid JSON, or isn't a JSON array, yields no endpoints at all.

There is a single **Connecting to** dropdown (`src/pod/PodTerminalTab.tsx`) — no separate container
picker or "via" dropdown. It lists every VNC endpoint across every container first (ordered per
`priority` above), then a plain entry per container in pod-manifest order — e.g. `Guest`, `QEMU`,
`desktop`, `app` for the example above (`desktop` has no VNC entry of its own here, so only its
plain entry appears). Picking any entry both selects its container and, for a VNC entry, tears down
and reconnects to that endpoint; picking a plain entry opens a real shell over `pods/exec`. Once
connected to a VNC entry, a keyboard-icon menu appears left of the **Expand** button, offering
`Ctrl+Alt+Del` and `F11` to send to the remote session; a plain entry instead gets the shared
xterm.js wrapper's own `Ctrl+F`/`Cmd+F` search.

## How it connects

The browser opens `…/api/kubernetes/api/v1/namespaces/<ns>/pods/<pod>/portforward?ports=<port>`
with subprotocol `v4.channel.k8s.io` through console's k8s proxy, so the session runs as the
logged-in user. Frames are `[channelByte, ...payload]` (data `0`, error `1`, each opening with the
port as uint16 LE); a small shim strips that framing and presents a duck-typed channel to noVNC.

Requires `get` on `pods/portforward` in the pod's namespace — granted by the standard `edit` and
`admin` roles, which is the same audience that can already use the Terminal tab. A `secretRef`
additionally requires `get` on the referenced `Secret`, which those roles also grant.

If the VNC server asks for a password (RFB "VNC Authentication", security type 2) and the endpoint
configured `auth`, the resolved password is sent automatically via noVNC's
`credentialsrequired`/`sendCredentials` handshake. If nothing was configured, or resolution itself
fails (bad secret, RBAC denied, …), the tab shows an inline password prompt instead of hanging —
type one and it's sent the same way. Either way, a rejected password surfaces the server's own
reason (e.g. "Authentication failed") rather than a generic disconnect message, and a Reconnect
link is offered. A scheme this plugin can't fulfil (anything beyond a bare password, e.g. ARD/XVP's
username+password+target) is reported as an explicit unsupported-auth error instead of hanging.

A session that has connected at least once auto-reconnects on any later disconnect, with
exponential backoff (0.5s, 1s, 2s, … capped at 64s, repeating at 64s) that resets to 0.5s as soon
as a reconnect actually succeeds. A session that never connected in the first place (bad port,
rejected auth, …) does *not* auto-retry — only the manual Reconnect link applies there, same as
before. Clicking Reconnect always cancels any pending auto-retry and starts the backoff over.
Picking a different container or VNC target is a new session and also starts the backoff over.

## Notes from live verification

- noVNC is pinned to **1.5.0**, not 1.6.0: 1.6.0's `lib/util/browser.js` contains a top-level
  `await`, which makes webpack treat it as an async module. `lib/input/keyboard.js` requires it
  synchronously, so `browser.isMac` is undefined by the time a key is pressed and every keystroke
  throws `TypeError: browser.isMac is not a function`. Mouse input still works, which makes it easy
  to miss. 1.5.0 has the same `Websock.attach()` contract and no top-level await.
- The i18n namespace must be `plugin__<ConsolePlugin name>` - console trims the `plugin__` prefix
  and looks up a plugin of exactly that name to fetch `locales/<lng>/<ns>.json`. A shorter alias
  404s and every string silently falls back to its key.
- The console container needs a real `height`; `min-height` alone leaves noVNC's `height: 100%`
  wrapper at zero and it scales the framebuffer to 0x0.

## Requires

The console patches `patches/0019-pod-terminal-flag-gate.patch` (Pod tab flag-gate) and
`patches/0020-node-terminal-flag-gate.patch` (Node tab flag-gate) from this repo. Against an
unpatched console both plugin tabs still register and work — they just appear *alongside* (not
instead of) core's own built-in tabs, since core has no flag check to hide behind.

## Development

```bash
npm install
npm run build      # production bundle into dist/
npm test           # jest
npm run lint       # tsc --noEmit
npm start          # dev server on :9001 for a local bridge
```

`make build-terminal` / `make push-terminal` build and push the console-plugin image
(`steigr/console-terminal-plugin`). `make build-terminal-shim` / `make push-terminal-shim` build
the bundled privileged node-terminal break-glass image (`node-terminal/`, see its own README).
