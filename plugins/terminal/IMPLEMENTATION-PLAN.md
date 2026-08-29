# terminal console plugin — Implementation Plan

> Historical design doc for the plugin's original Pod-VNC-only scope (then named
> `vncviewer`). The plugin has since been renamed to `terminal` and gained a Node
> terminal tab and server-side on/off flags for both — see [README.md](README.md)
> for the current, complete picture. The Pod/VNC design below is still accurate.

## 1. Purpose

Let the Pod **Terminal** tab connect to a container's VNC server instead of a shell,
for pods that opt in via label + annotation, using noVNC in the browser and the
Kubernetes **port-forward** subresource (proxied by console) as the transport.

Opt-in contract on the Pod:

| key | kind | meaning |
| --- | --- | --- |
| `vnc.container.kubernetes.io/enabled: "true"` | label | pod participates at all |
| `vnc.container.kubernetes.io/endpoints` | annotation | `CONTAINER[=PORT][,CONTAINER2[=PORT2]]*`, `PORT` defaults to `5900` |

If the label is absent/not `"true"` → nothing changes, Terminal tab behaves exactly as today.
If the label is present and the annotation is missing → the pod is assumed to expose
`5900` on its **first** container.

## 2. Architecture decision

The Terminal tab is console core (`frontend/public/components/pod-connect.tsx`), not a
plugin surface — there is no upstream extension point that replaces it. Two pieces:

1. **A console patch** (`patches/0019-pod-connect-transport-extension.patch`) that turns the
   Terminal tab's fixed "Connecting to `<container>`" toolbar into a **pluggable transport**
   toolbar: it resolves dynamic-plugin extensions of a *custom* type and, when one claims the
   currently selected container, renders a second ("via") dropdown and delegates the body to
   the extension's component. The patch stays VNC-agnostic — no noVNC, no annotation parsing.
2. **A new dynamic plugin** `plugins/vncviewer` that contributes exactly one such extension:
   label parsing, port list computation, noVNC rendering, port-forward framing.

Custom extension types are officially supported by the SDK — the generated
`console-extensions.json` schema has a `CustomExtension` variant ("arbitrary `type` and
`properties` … allows dynamic plugins to consume extensions which are specific to other
plugins"), and console core can resolve them with `useResolvedExtensions(pred)`.

Keeping the VNC logic out of the console patch matters for this repo: console patches must be
re-applied on every `CONSOLE_BRANCH` bump, so the patch should be small, generic and hunk-stable.

## 3. Extension contract

Type: `stei.gr/pod-connect-transport` (a `CustomExtension`) — vendor-prefixed rather than
`console.*`, since this is a downstream extension point, not an upstream one. Declared in
`pod-connect.tsx` alongside `PodConnectTransportProps`; the plugin re-declares the shape locally
and does not import from console core.

```ts
properties: {
  id: string;                      // 'vnc'
  // label shown in the "via" dropdown; the built-in shell is always 'Terminal'
  label: string;                   // '%plugin__vncviewer-console-plugin~VNC%'
  // (pod, containerName) => boolean — is this transport available for that container?
  isAvailable: { $codeRef: 'transport.isVncAvailable' };
  // React component rendered in place of the xterm terminal
  component: { $codeRef: 'transport.VncPodConsole' };
  // when true, this transport is preselected for containers where isAvailable() is true
  preferred: boolean;              // true
}
```

Component props supplied by console core:

```ts
type PodConnectTransportProps = {
  obj: PodKind;
  containerName: string;
  subprotocols: string[];  // impersonation subprotocols, computed by console core
  isFullscreen: boolean;
  onError: (msg: string | null) => void;
};
```

`subprotocols` is passed down because `getImpersonate` is console-internal and not part of the
public dynamic-plugin API — the plugin must not reach into console internals for it.

## 4. Console patch (`patches/0019-…`) — exact shape

Single file touched: `frontend/public/components/pod-connect.tsx` (+ one new i18n key in
`frontend/public/locales/en/public.json`).

1. Import `useResolvedExtensions` from `@console/dynamic-plugin-sdk` and resolve
   `e.type === 'stei.gr/pod-connect-transport'`.
2. Compute `availableTransports = extensions.filter(e => e.properties.isAvailable(obj, activeContainer))`
   (memoized on `obj.metadata`, `activeContainer`, `extensions`).
3. New state `activeTransport: string` (`'terminal'` or an extension `id`), recomputed when
   `activeContainer` changes: pick the first available `preferred` transport, else `'terminal'`.
4. Toolbar: after the existing container `<FlexItem>`, conditionally render
   `<FlexItem>{t('via')}</FlexItem>` + a `<Select>`/`SimpleSelect` of
   `[...availableTransports.map(label), 'Terminal']` — **only when `availableTransports.length > 0`**.
   Zero available transports ⇒ toolbar is byte-identical to today.
5. Body: when `activeTransport !== 'terminal'`, render the extension component with the props
   above **instead of** `contents`, and skip `connect()` entirely (guard the two `useEffect`s
   that call `connect()` and the unmount `exit\r` on `activeTransport === 'terminal'`, so no
   exec websocket is opened while VNC is active).
6. Keep the existing fullscreen/Expand toolbar group working for both transports.

Existing behaviour preserved when no plugin is installed: extensions list is empty ⇒ dead code path.

## 5. Endpoint parsing (plugin side)

`src/vnc/endpoints.ts`:

```
isVncPod(pod)  := pod.metadata?.labels?.['vnc.container.kubernetes.io/enabled'] === 'true'
vncPorts(pod)  := Map<containerName, port>
```

Algorithm (only run when `isVncPod`):

1. `spec := pod.metadata?.annotations?.['vnc.container.kubernetes.io/endpoints']`.
2. If `spec` is missing/blank → `{ [pod.spec.containers[0].name]: 5900 }` (empty container list ⇒ `{}`).
3. Else split on `,`, trim; for each entry `NAME[=PORT]`:
   - drop entries whose `NAME` doesn't match a container in `pod.spec.containers` (log at debug);
   - `PORT` defaults to `5900`; reject non-integer or out of `1..65535`;
   - **skip the entry if that port is already claimed** by an earlier entry, and skip a container
     that already has an entry. Containers in a pod share one network namespace, so a port is
     pod-unique — this is what "only add a container if the port is not yet in the port list" means.
4. Result `{}` ⇒ plugin contributes nothing, `isVncAvailable()` is false for every container ⇒
   the "via" dropdown never appears (per spec: containers without a VNC port go straight to Terminal).

Unit-tested in `src/vnc/__tests__/endpoints.spec.ts` (no annotation, blank, unknown container,
duplicate port, duplicate container, bad port, port clamped, multi-entry ordering).

## 6. VNC transport

### 6.1 Wire path

```
browser ── wss://<console>/api/kubernetes/api/v1/namespaces/<ns>/pods/<pod>/portforward?ports=<port>
        │      subprotocol: [...impersonation, 'v4.channel.k8s.io']
        ▼ console k8s proxy (pkg/proxy) — forwards non-impersonation subprotocol verbatim,
        │   swaps in the user token, copies binary frames unchanged
        ▼ kube-apiserver pods/portforward ─▶ kubelet
```

Verified against the sources in-tree/upstream:
- console's proxy forwards any non-`Impersonate-*` subprotocol to the API server and relays
  **binary** frames untouched (`copyMsgs`), so noVNC's byte stream survives.
- kubelet's websocket port-forward handler (`pkg/cri/streaming/portforward/websocket.go`)
  accepts `v4.channel.k8s.io` (binary) and `v4.base64.channel.k8s.io`, allocates **two channels
  per requested port** (`data = 2i`, `error = 2i+1`) and writes the port as a **uint16 LE as the
  first 2 bytes of each channel**.

Frame format: every websocket binary frame is `[channelByte, ...payload]`.

### 6.2 `PortForwardChannel` shim (`src/vnc/portforward.ts`)

noVNC ≥1.4 accepts a raw channel object as `new RFB(target, channel, opts)`; `Websock.attach()`
only requires these props to exist: `send`, `close`, `binaryType`, `onerror`, `onmessage`,
`onopen`, `protocol`, `readyState` (own keys or prototype own-property names), and it tolerates
a channel still in `CONNECTING` (it hooks `onopen`). So we implement a small duck-typed class:

- owns the real `WebSocket` (binaryType `arraybuffer`);
- **first inbound frame per channel**: strip channel byte, swallow the 2 port bytes, then fire
  `onopen` once the data channel's port header has been consumed (this is the "connected" edge);
- **subsequent data-channel frames**: strip channel byte, deliver `{ data: ArrayBuffer }` to `onmessage`;
- **error-channel frames**: decode UTF-8 → surface via `onerror` + `onError` prop (this is where
  "connection refused"/RBAC failures show up);
- `send(data)`: prepend `0x00` (data channel 0) to the Uint8Array and `WebSocket.send` it;
- `readyState`/`protocol` proxy the underlying socket; `close()` closes it.

Unit-tested against a fake WebSocket (`src/vnc/__tests__/portforward.spec.ts`): header stripping,
partial frames, error channel, send framing, close propagation.

### 6.3 `VncPodConsole` component

- `@novnc/novnc@1.6.0` — `import RFB from '@novnc/novnc/lib/rfb'` (same import style as the
  kubevirt plugin, which pins 1.5.0 and drives it via a URL; we drive it via the channel shim).
- Mount: build URL from `window.location` (`wss:` when page is https), open the socket, wrap in
  `PortForwardChannel`, `new RFB(ref.current, channel, {})`, set `scaleViewport = true`,
  `clipViewport`, `viewOnly = false`.
- Reconnect button + status (connecting/connected/disconnected/error), `Reconnect` on
  `disconnect` event, teardown on unmount and on container/port change.
- Keyboard helpers kept minimal for v1: Ctrl-Alt-Del button + paste (matching kubevirt's actions
  file is out of scope for the first cut).
- Styles: one small `vnc-console.scss`, sized to fill the tab; honours the fullscreen prop.

## 7. Plugin scaffolding (mirrors `plugins/flux`)

```
plugins/vncviewer/
  package.json           # + "@novnc/novnc": "1.6.0"; react 17, SDK 4.20.0 (same pins as flux)
  package-lock.json
  tsconfig.json  webpack.config.ts
  plugin-manifest.ts     # exposedModules: { transport: './vnc/transport.tsx' } + the custom extension
  locales/en/plugin__vncviewer-console-plugin.json
  src/vnc/{endpoints.ts,portforward.ts,VncPodConsole.tsx,transport.tsx,vnc-console.scss}
  src/vnc/__tests__/…
  main.go  go.mod  api/            # static asset server, same shape as flux/cert-manager
  Dockerfile             # node builder → go builder (upx) → scratch
  charts/console-vncviewer-plugin/{Chart.yaml,values.yaml,templates/…}
  README.md
```

Repo-level touchpoints:
- `config.mk`: `VNCVIEWER_PLUGIN_IMAGE ?= steigr/console-vncviewer-plugin`.
- `Makefile`: `VNCVIEWER_PLUGIN_DIR`, tag var, `build-vncviewer` / `push-vncviewer` /
  `clean-vncviewer`, and add to the aggregate `build`/`push`/`clean` + `.PHONY` + `print-images`.
- `.github/workflows/build-images.yml`: path filter `plugins/vncviewer/**` (excluding `charts/**`)
  + matrix entry (`target: push-vncviewer`, `image_name: console-vncviewer-plugin`).
- `.github/workflows/publish-charts.yml`: filter + chart list entry.
- `CLAUDE.md`: mention the new plugin and the console patch it depends on.

The chart's ClusterRole needs **no** extra cluster RBAC (the browser talks to the API server as
the logged-in user through console's proxy); it's the standard console-plugin
deployment/service/ConsolePlugin trio.

## 8. Risks (items 1-2 verified against upstream sources + the live cluster)

1. **RBAC verb — resolved, no action needed.** The websocket port-forward is an HTTP `GET`, so
   the API server's `RequestInfo` maps it to verb **`get`** on `pods/portforward`
   (`POST` → `create`; that is the verb kubectl's SPDY path consumes). Upstream bootstrap policy
   grants `system:aggregate-to-edit` both `Read` (`get,list,watch`) *and* `Write` on
   `pods/portforward`, and this cluster confirms it:

   ```
   edit  -> [get list watch]                        [pods/attach pods/exec pods/portforward ...]
   edit  -> [create delete deletecollection patch update]  [pods pods/attach pods/exec pods/portforward ...]
   admin -> (same two rules)
   ```

   So anyone who can use the Terminal tab today (`edit`/`admin`) can also port-forward.
   `view` has neither, and gets neither terminal nor VNC — consistent. The only failure case is a
   **custom** Role modelled on kubectl usage that grants `create` on `pods/portforward` but not
   `get`; that user sees a 403 on the upgrade. Handle it as a documented error message
   ("requires get on pods/portforward"), not as code.

2. **Query parameter — resolved: `?ports=<n>`.** The two layers genuinely use different names,
   and the client-facing one is `ports`:
   - client → API server: `PodPortForwardOptions{ Ports []int32 \`json:"ports"\` }`, decoded from
     the query string, so **`?ports=5900`** (repeat the param for multiple ports; do not comma-join,
     the int32 conversion would reject it).
   - API server → kubelet: `streamParams()` re-emits it as `api.PortHeader` = **`port`**, comma-joined
     (`/portForward/<ns>/<pod>?port=5900`).

   The `port` spelling seen in kubelet's `NewV4Options` is therefore the *internal* hop and must not
   be sent from the browser. Only one port is ever requested per session here, so channels are
   fixed at data `0` / error `1`.

3. **Origin check.** `patches/0014` makes the k8s proxy enforce `--base-address` on websocket
   upgrades — the VNC socket is same-origin so it passes, but a misconfigured `--base-address`
   will break VNC exactly like it breaks the terminal.
4. **noVNC bundle size / SDK shared modules.** noVNC is plain ESM; it must be bundled into the
   plugin chunk (no shared-module treatment). Watch the webpack `dist` size.
5. **Subprotocol echo.** console's proxy echoes back the *last* processed subprotocol; the
   impersonation ones must be sent **before** `v4.channel.k8s.io` (same ordering console's
   `WSFactory` uses for exec).
6. **Multiple VNC ports per container** are not representable in the annotation grammar (one port
   per container) — accepted limitation.

## 9. Work breakdown

1. ~~`patches/0019-pod-connect-transport-extension.patch` — generic transport extension point.~~
   **Done.** `tsc --noEmit` and `eslint` clean; the 18-patch stack applies cleanly to a fresh
   `release-4.22` clone; related jest suites pass (the one `pod.spec.tsx` failure is a
   pre-existing timezone-dependent date assertion, reproduced on an unpatched tree).
2. ~~Plugin scaffold (package.json/webpack/tsconfig/manifest/go backend/Dockerfile).~~ **Done.**
   Pinned to console 4.22's own runtime (react 18.3, PF ~6.4, SDK 4.22.0-prerelease.3) rather than
   flux's react-17/SDK-4.20 pins; uses the SDK-standard `console-extensions.json` +
   `consolePlugin` package.json layout with swc/jest (node-logging style) and flux's npm+upx
   Dockerfile. `npm run build`/`lint`/`test` green, image builds and serves its manifest;
   Makefile + config.mk wired (`make build-vncviewer`). `transport.tsx` is still a placeholder.
3. ~~`endpoints.ts` + unit tests.~~ **Done** (24 tests), wired into `isVncAvailable`.
4. ~~`portforward.ts` channel shim + unit tests against a fake socket.~~ **Done** (21 tests),
   including two that drive the shim through the *real* `@novnc/novnc` `Websock` rather than a
   restatement of its contract.
5. ~~`VncPodConsole.tsx` + `transport.tsx` + styles + locales.~~ **Done** (12 component tests).
   noVNC lands in its own ~296 KiB lazy chunk, fetched only when a VNC console is opened;
   webpack's asset-size hint is raised to 512 KiB rather than silenced.
6. ~~Chart, Makefile/config.mk, CI workflow entries, README, CLAUDE.md note.~~ **Done.**
   The chart carries no ClusterRole (unlike flux's) and sets `automountServiceAccountToken: false`:
   the backend only serves static assets, and the browser reaches `pods/portforward` through
   console's proxy as the logged-in user.
7. ~~Manual verification.~~ **Done** against `home.alaunstras.se` with a local bridge (patched
   console frontend + plugin dev server) and a `jlesage/firefox` test pod in namespace `vnc-test`.
   Verified: VNC connects and renders; the container dropdown gains `via` only for containers with
   a port; switching to the `plain` container drops the dropdown and opens the exec shell;
   switching `via` to Terminal opens exec on the VNC container; switching back reconnects VNC;
   mouse and keyboard both reach the remote desktop (confirmed visually and on the wire as RFB
   PointerEvent/KeyEvent frames on channel 0).

   Four defects found and fixed, none of which the unit tests could have caught:
   - the exec session was opened before extensions resolved, then torn down mid-handshake -
     `WSFactory.send()` threw `Still in CONNECTING state` and crashed the tab (patch 0019);
   - noVNC 1.6.0 breaks all keyboard input under webpack (top-level await in `util/browser.js`);
   - the i18n namespace has to be `plugin__<ConsolePlugin name>`;
   - `min-height` does not give noVNC a definite height, so it scaled the canvas to 0x0.

## 10. Assumptions

- One VNC port per container; ports are pod-unique (shared netns) hence the dedupe-by-port rule.
- "VNC" is preselected whenever the selected container has a VNC port; switching to "Terminal"
  closes the VNC session and opens the exec session, and vice versa.
- Containers without a VNC port show no "via" dropdown at all (not a disabled one).

## 11. Post-verification changes (user-requested)

Two follow-ups landed after step 7's live verification, both driven by explicit user requests
rather than anything the plan originally called for:

1. **Toolbar "send key" menu.** The Terminal tab's toolbar gained a second extension-contributed
   surface: `PodConnectTransportProps.onActionsChange(actions)` lets a transport register a list of
   `{ id, label, onSelect }` entries, rendered as a keyboard-icon dropdown immediately left of the
   existing Expand/Collapse button (patch 0019). `VncPodConsole` reports `Ctrl+Alt+Del` (existing
   `RFB.sendCtrlAltDel()`) and `F11` (`RFB.sendKey(KeyTable.XK_F11, 'F11')`, the same pattern
   kubevirt-plugin uses for its F1-F12 helpers) once connected, and withdraws them on disconnect or
   unmount. The menu itself lives in console core precisely because "left of Expand" means the
   *console-core* toolbar, not the transport's own sub-toolbar — so, like the "via" dropdown, this
   is a second small, transport-agnostic addition to patch 0019, not plugin-only code.

2. **Annotation format: comma-separated → JSON array, to carry VNC authentication.** The original
   `CONTAINER[=PORT][,CONTAINER2[=PORT2]]*` grammar had no room for credentials. `endpoints.ts` was
   rewritten around a JSON array of `{ container, port?, auth? }`, where `auth` is either
   `{ password }` (inline, discouraged - annotations are plain text) or `{ secretRef: { name, key? } }`
   (preferred - resolved via `consoleFetchJSON` against console's own k8s proxy, so ordinary Secret
   RBAC applies to the logged-in user, same trust boundary as everything else this plugin does). The
   dedupe-by-port/dedupe-by-container rules from step 3 carry over unchanged; a value that isn't
   valid JSON or isn't an array now yields no endpoints rather than being parsed loosely. This is a
   breaking format change with no back-compat shim, per the request.

   `VncPodConsole` resolves auth via noVNC's `credentialsrequired` event and `RFB.sendCredentials()`
   rather than pre-fetching before connecting: this works uniformly whether resolution is
   synchronous (inline password) or a network round trip (secretRef), doesn't block opening the
   port-forward socket on it, and matches noVNC's own async-credentials design instead of working
   around it. A `cancelled` flag guards against calling `sendCredentials` on a session that was
   already torn down (container/transport switch, unmount) by the time a secret fetch resolves.

   Verified live against `home.alaunstras.se`: a second test pod (`vnc-auth`, `jlesage/firefox`)
   configured for RFB security type 2 only (confirmed via a raw protocol probe - "VNC auth
   (password)", not "None"), authenticating via a `secretRef` to a real cluster `Secret`. Console
   fetched `/api/kubernetes/api/v1/namespaces/vnc-test/secrets/vnc-creds` (confirmed on the network
   tab) and connected with no manual prompt. Swapping in a Secret with the wrong password produced
   a clean "Lost the VNC connection" error with a Reconnect link, not a hang - the negative path
   also verified live, not just asserted in a mock.

3. **Incidental finding, not fixed here:** the same i18n-namespace bug found in step 7
   (`plugin__<short-alias>` instead of `plugin__<ConsolePlugin name>`) exists in `plugins/flux`
   (`plugin__flux` vs. plugin name `flux-console-plugin`) and `plugins/cert-manager`
   (`plugin__cert-manager` vs. `cert-manager-console-plugin`) — fixed in the same commit as these
   two changes, since it's a one-line rename per plugin and was already diagnosed here.

## 12. Post-verification changes, round 2 (user-requested)

Two more follow-ups, both design gaps the user spotted directly:

1. **Auth failure UX.** `VncPodConsole` previously had two problems the wrong-password live test
   in section 11 didn't actually catch: noVNC dispatches *both* `securityfailure` (with a specific
   reason, e.g. "Authentication failed") and an unclean `disconnect` for the same failure, in that
   order - and the disconnect handler's generic "Lost the VNC connection..." message unconditionally
   overwrote the specific one. A `reportedSpecificError` flag (reset per connection attempt) now
   makes the disconnect handler defer to whichever specific handler already reported. Separately,
   when no `auth` was configured at all, `credentialsrequired` used to no-op, leaving the tab stuck
   on "Connecting..." forever with no way out. It now shows an inline password prompt
   (`needsManualPassword` state + a small form) - offered both when nothing is configured and as a
   fallback when auto-resolution itself fails (bad secret, RBAC denied). A `credentialsrequired`
   whose `types` isn't exactly `['password']` (e.g. ARD/XVP's username+password+target) is reported
   as an explicit unsupported-auth error rather than silently doing nothing, matching the same
   "never hang silently" fix.

   All three paths verified live against `home.alaunstras.se`: a pod with no `auth` configured
   showed the prompt, typing the real password connected; a pod with a *wrong* inline password
   surfaced "Authentication failed" (confirmed via DOM text, not just component state) instead of
   the old generic message.

2. **Multiple endpoints per container.** `vnc.container.kubernetes.io/endpoints` entries no longer
   dedupe by container name - `VncEndpoints` changed from `{ [container]: VncEndpoint }` to
   `{ [container]: VncEndpoint[] }`, so a VM container can list both its hypervisor-level QEMU VNC
   and the guest OS's own in-VM VNC agent on different ports (still pod-unique by *port*, which is
   the real physical constraint - shared netns). Each entry gained an optional `label` for the new
   **Target** dropdown, shown only when a container has more than one endpoint; switching it tears
   down and reconnects to the newly selected port, resetting to the first endpoint whenever the
   container itself changes.

   Verified live with a pod annotated for the same container twice (`Guest`/5900, `QEMU`/5901,
   only the first actually listening): the dropdown rendered both labels, and switching to the
   second option opened a *new* websocket to `ports=5901` (confirmed via a patched `WebSocket`
   constructor logging every URL), i.e. the reconnect-on-target-change mechanism works against the
   real port-forward proxy, not just in the unit tests.
