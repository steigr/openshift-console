# vncviewer console plugin

Replaces the body of the pod **Terminal** tab with a noVNC session for pods that opt in, instead
of the usual `exec` shell.

## Opt-in contract

| key | kind | meaning |
| --- | --- | --- |
| `vnc.container.kubernetes.io/enabled: "true"` | label | pod participates at all |
| `vnc.container.kubernetes.io/endpoints` | annotation | `CONTAINER[=PORT][,CONTAINER2[=PORT2]]*`, `PORT` defaults to `5900` |

Without the annotation the pod's **first** container is assumed to serve VNC on `5900`.
Containers in a pod share a network namespace, so a port may only be claimed once; entries
repeating an already-claimed port (or container) are ignored.

Containers with a VNC port get a **via** dropdown next to the container dropdown, defaulting to
`VNC` and offering `Terminal`. Containers without one keep the plain terminal, with no dropdown.

## How it connects

The browser opens `…/api/kubernetes/api/v1/namespaces/<ns>/pods/<pod>/portforward?ports=<port>`
with subprotocol `v4.channel.k8s.io` through console's k8s proxy, so the session runs as the
logged-in user. Frames are `[channelByte, ...payload]` (data `0`, error `1`, each opening with the
port as uint16 LE); a small shim strips that framing and presents a duck-typed channel to noVNC.

Requires `get` on `pods/portforward` in the pod's namespace — granted by the standard `edit` and
`admin` roles, which is the same audience that can already use the Terminal tab.

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
