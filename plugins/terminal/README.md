# terminal console plugin

Provides two independently switchable terminal features, each defaulting to *on* but able to be
handed back to console core via a server-side flag (see [Flags](#flags)):

- **Pod terminal**: replaces the body of the pod **Terminal** tab with a noVNC session for pods
  that opt in, instead of the usual `exec` shell.
- **Node terminal**: contributes its own Node **Terminal** tab, a straight port (for now) of
  console core's built-in one — create a debug pod (using the same `node-terminal` ConfigMap/
  annotation convention as core's patch `0006`) and exec into it. This plugin also bundles the
  privileged `node-terminal` break-glass shim (`node-terminal/`) that debug pod runs. Its xterm.js
  (`@xterm/xterm` 6) instance has:
  - **Find**: `Ctrl+F`/`Cmd+F` (while the terminal is focused, or the find box itself) toggles a
    small overlay, top right — type to search, `Enter`/`Shift+Enter` for next/previous match,
    `Escape` or `Ctrl+F`/`Cmd+F` again to close. Backed by `@xterm/addon-search`.
  - **Sixel / iTerm image protocol**: rendered inline via `@xterm/addon-image`. The debug pod's
    `HAVE_SIXEL_SUPPORT=true` env var (see `src/node/debugPod.ts`) lets sixel-aware shells/tools
    detect this.
  - **Font**: Victor Mono, patched with Nerd Font glyphs (`VictorMono Nerd Font Propo`, 4 weights
    bundled as woff2 under `src/node/fonts/`, SIL OFL 1.1 — see `fonts/LICENSE.txt`), falling back
    to Red Hat Mono / monospace.

## Flags

The backend reads `POD_TERMINAL_ENABLED` / `NODE_TERMINAL_ENABLED` (both default `true`) and
serves them at `/config.json` (proxied by console at
`/api/plugins/terminal-console-plugin/config.json`). The frontend fetches that once at startup and
sets `TERMINAL_PLUGIN_POD_TERMINAL_ENABLED` / `TERMINAL_PLUGIN_NODE_TERMINAL_ENABLED` accordingly:
- Pod: this plugin's `stei.gr/pod-connect-transport` extension only registers when its flag is
  set — with it unset, the Pod Terminal tab is the plain core terminal, unchanged (patch `0019`
  is a no-op without a registered extension).
- Node: this plugin's `console.tab/horizontalNav` Node tab only registers when its flag is set,
  and console core's own built-in Node Terminal tab (patch `0020`) hides itself only when that
  same flag is set — so exactly one of the two is ever shown.

## Pod terminal: opt-in contract

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
  { "container": "vm", "port": 5900, "label": "Guest" },
  { "container": "vm", "port": 5902, "label": "QEMU" }
]
```

- `container` (required) must name a container in the pod; `port` defaults to `5900`.
- `auth` is optional. Prefer `secretRef` (`key` defaults to `"password"`) — the browser reads the
  Secret via console's own k8s API proxy, so ordinary Secret RBAC applies to the logged-in user,
  and the password never appears in the pod spec. An inline `{ "auth": { "password": "..." } }` is
  also accepted but **not recommended**: annotations are plain text, visible to anyone who can
  `get` the pod. If a server asks for a password no `auth` resolves (or resolution fails), the tab
  shows an inline password prompt instead of hanging.
- `label` is optional and only matters when a container has more than one endpoint (see below);
  defaults to `port <port>`.
- The same `container` name may appear more than once — e.g. a VM container exposing both its
  hypervisor-level QEMU VNC and the guest OS's own in-VM VNC agent, on different ports. Only the
  *port* has to be pod-unique (containers share one network namespace): an entry naming an
  already-claimed port, an unknown container, or an invalid port is dropped; a value that isn't
  valid JSON, or isn't a JSON array, yields no endpoints at all.

Containers with at least one VNC endpoint get a **via** dropdown next to the container dropdown,
offering `Terminal` plus one entry per VNC endpoint (via patch `0019`'s `targets` support on the
`stei.gr/pod-connect-transport` extension) — a container with a single endpoint just shows `VNC`;
one with several shows `VNC (<label>)` per endpoint, e.g. `VNC (Guest)` / `VNC (QEMU)` for the
example above. Picking one tears down and reconnects to that endpoint. Once connected, a
keyboard-icon menu appears left of the **Expand** button, offering `Ctrl+Alt+Del` and `F11` to send
to the remote session.

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

The console patches `patches/0019-pod-connect-transport-extension.patch` (Pod transport extension
point) and `patches/0020-node-terminal-flag-gate.patch` (Node tab flag-gate) from this repo.
Against an unpatched console the plugin loads and does nothing for Pods, and its Node tab appears
alongside (not instead of) core's own.

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
