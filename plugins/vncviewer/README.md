# vncviewer console plugin

Replaces the body of the pod **Terminal** tab with a noVNC session for pods that opt in, instead
of the usual `exec` shell.

## Opt-in contract

| key | kind | meaning |
| --- | --- | --- |
| `vnc.container.kubernetes.io/enabled: "true"` | label | pod participates at all |
| `vnc.container.kubernetes.io/endpoints` | annotation | JSON array, see below |

Without the annotation the pod's **first** container is assumed to serve unauthenticated VNC on
`5900`. With it, the annotation is a JSON array of:

```json
[
  { "container": "desktop", "port": 5900 },
  { "container": "app", "port": 5901, "auth": { "secretRef": { "name": "vnc-creds", "key": "password" } } }
]
```

- `container` (required) must name a container in the pod; `port` defaults to `5900`.
- `auth` is optional. Prefer `secretRef` (`key` defaults to `"password"`) — the browser reads the
  Secret via console's own k8s API proxy, so ordinary Secret RBAC applies to the logged-in user,
  and the password never appears in the pod spec. An inline `{ "auth": { "password": "..." } }` is
  also accepted but **not recommended**: annotations are plain text, visible to anyone who can
  `get` the pod.
- Containers of a pod share one network namespace, so a port can only be claimed once: an entry
  naming an already-claimed port, an already-listed container, an unknown container, or an invalid
  port is dropped; a value that isn't valid JSON, or isn't a JSON array, yields no endpoints at all.

Containers with a VNC port get a **via** dropdown next to the container dropdown, defaulting to
`VNC` and offering `Terminal`. Containers without one keep the plain terminal, with no dropdown.
Once connected, a keyboard-icon menu appears left of the **Expand** button, offering `Ctrl+Alt+Del`
and `F11` to send to the remote session.

## How it connects

The browser opens `…/api/kubernetes/api/v1/namespaces/<ns>/pods/<pod>/portforward?ports=<port>`
with subprotocol `v4.channel.k8s.io` through console's k8s proxy, so the session runs as the
logged-in user. Frames are `[channelByte, ...payload]` (data `0`, error `1`, each opening with the
port as uint16 LE); a small shim strips that framing and presents a duck-typed channel to noVNC.

Requires `get` on `pods/portforward` in the pod's namespace — granted by the standard `edit` and
`admin` roles, which is the same audience that can already use the Terminal tab. A `secretRef`
additionally requires `get` on the referenced `Secret`, which those roles also grant.

If the VNC server asks for a password (RFB "VNC Authentication", security type 2), the resolved
password is sent automatically via noVNC's `credentialsrequired`/`sendCredentials` handshake — no
manual prompt. A wrong or unresolvable password surfaces as a connection error with a Reconnect
link, the same as any other VNC connection failure.

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

The console patch `patches/0019-pod-connect-transport-extension.patch` from this repo, which adds
the `stei.gr/pod-connect-transport` extension point this plugin contributes to. Against an
unpatched console the plugin loads and does nothing.

## Development

```bash
npm install
npm run build      # production bundle into dist/
npm test           # jest
npm run lint       # tsc --noEmit
npm start          # dev server on :9001 for a local bridge
```

`make build-vncviewer` / `make push-vncviewer` build and push the image
(`steigr/console-vncviewer-plugin`).
