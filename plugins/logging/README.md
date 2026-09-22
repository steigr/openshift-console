# Console Logging Plugin - OpenShift Console Plugin

This project is an OpenShift Console dynamic plugin that does two things for
container and node logs.

It makes console's **Node Logs** tab (`v1` `Node`) work on vanilla kubelets,
which serve `/logs/` as a plain file server over `/var/log` and have no
`journal` path for console to proxy to. The plugin's frontend reroutes the
journal requests core makes (see [src/fetch-patch.ts](src/fetch-patch.ts)) to
this plugin's own backend, which serves them from a `node-logs-api` DaemonSet
running on every node.

It also provides a **Pod Logs** tab (`v1` `Pod`) that renders structured
container logs as columns rather than as raw lines -- see
[Structured log viewer](#structured-log-viewer).

That backend is a single static Go binary that embeds the built frontend
assets and is reachable through the console's plugin proxy. It also decides,
through [api/config.go](api/config.go), whether console core keeps serving its
own Logs tabs -- see [Tab ownership flags](#tab-ownership-flags).

[Dynamic plugins](https://github.com/openshift/console/tree/master/frontend/packages/console-dynamic-plugin-sdk)
allow you to extend the
[OpenShift UI](https://github.com/openshift/console)
at runtime, adding custom pages and other extensions. They are based on
[webpack module federation](https://webpack.js.org/concepts/module-federation/).
Plugins are registered with console using the `ConsolePlugin` custom resource
and enabled in the console operator config by a cluster administrator.

Using the latest `v1` API version of `ConsolePlugin` CRD requires OpenShift 4.12
and higher.

[Node.js](https://nodejs.org/en/) and [yarn](https://yarnpkg.com) are required
to build and run the plugin. To run OpenShift console in a container, either
[Docker](https://www.docker.com) or [podman 3.2.0+](https://podman.io) and
[oc](https://console.redhat.com/openshift/downloads) are required.

## Getting started

### Prerequisites

- OpenShift 4.12+

## Development

### Option 1: Local

In one terminal window, run:

1. `yarn install`
2. `yarn run start`

In another terminal window, run:

1. `oc login` (requires [oc](https://console.redhat.com/openshift/downloads) and an [OpenShift cluster](https://console.redhat.com/openshift/create))
2. `yarn run start-console` (requires [Docker](https://www.docker.com) or [podman 3.2.0+](https://podman.io))

This will run the OpenShift console in a container connected to the cluster
you've logged into. The plugin HTTP server runs on port 9001 with CORS enabled.

Note: the `/api/hello-world` route in this repo is only served by the Go
binary built by the `Dockerfile` (see [Docker image](#docker-image)). When
running locally via `yarn start`, only static plugin assets are served, so the
"Node Logs" tab will show a fetch error until the plugin is deployed on-cluster
via the Helm chart below.

#### Running start-console with Apple silicon and podman

If you are using podman on a Mac with Apple silicon, `yarn run start-console`
might fail since it runs an amd64 image. You can workaround the problem with
[qemu-user-static](https://github.com/multiarch/qemu-user-static) by running
these commands:

```bash
podman machine ssh
sudo -i
rpm-ostree install qemu-user-static
systemctl reboot
```

## Docker image

Before you can deploy your plugin on a cluster, you must build an image and
push it to an image registry. OpenShift clusters are typically `linux/amd64`
regardless of what your workstation is, so the image is built for multiple
platforms (`linux/amd64` and `linux/arm64` by default) using `docker buildx`.

A [Makefile](Makefile) wraps this:

```sh
make build         # build for all PLATFORMS, cache-only (no --push/--load)
make push           # build for all PLATFORMS and push the manifest list
make print-image    # print the resolved IMAGE:TAG
```

`make` creates a one-off `docker-container` buildx builder (name configurable
via `BUILDER`, default `multiarch-builder`) the first time it's needed, since
the default Docker Desktop builder can't push multi-platform manifest lists.

Override any of `IMAGE`, `TAG`, `PLATFORMS`, `DOCKERFILE`, or `BUILD_CONTEXT`
as needed, e.g.:

```sh
make push IMAGE=quay.io/my-repository/console-logging-plugin TAG=v0.1.0
```

You can also run `docker build`/`docker push` directly for a single-platform
image (e.g. for local testing):

```sh
docker build -t quay.io/my-repository/console-logging-plugin:latest .
docker run -it --rm -d -p 8443:8443 quay.io/my-repository/console-logging-plugin:latest
docker push quay.io/my-repository/console-logging-plugin:latest
```

The binary listens on `$PORT` (default `8443` when a TLS cert/key pair is
present, `8080` otherwise) and serves plain HTTP unless
`/var/cert/tls.crt`/`/var/cert/tls.key` are present, in which case it serves
HTTPS using those files (see [Deployment on cluster](#deployment-on-cluster)).

## Deployment on cluster

A [Helm](https://helm.sh) chart is available under
[charts/console-logging-plugin](charts/console-logging-plugin) to
deploy the plugin to a Kubernetes/OpenShift environment. Consult the chart's
[values.yaml](charts/console-logging-plugin/values.yaml) for the full
set of supported parameters.

The chart ships the `ConsolePlugin` custom resource that registers the plugin
with console (`consolePlugin.create`, on by default), including the
`spec.proxy` entry that puts its REST API on console's plugin proxy route.
Enabling the plugin in the console operator config is still a separate step,
and a console deployed from this repo's own
[charts/openshift-console](../../charts/openshift-console) reads its `plugins[]`
list rather than the CR, so it needs a matching entry (with `proxy.alias: api`)
there instead.

By default the backend authorizes the logged-in user before serving journal
content -- a `SelfSubjectAccessReview` for `get` on `nodes/proxy`, built from
the credentials console forwards on that proxy route, which is the same
permission console core's own Node Logs tab requires. Set
`useServiceAccountToken=true` to skip that check and serve on the plugin's own
`ServiceAccount` alone.

## Backend

Unlike a typical nginx-based console plugin, this plugin's backend is a
single static Go binary ([main.go](main.go)) that:

- `//go:embed`s the built frontend (`dist/`) into the binary at compile time
- serves those assets for any path, rewriting the request path to be
  relative to the embedded `dist` directory (see `rootPath` in
  [main.go](main.go))
- mounts custom API routes on the same `http.ServeMux` ahead of the static
  file handler, via a small self-registration pattern in
  [api/api.go](api/api.go): any file under `api/` can add an `init()` that
  calls `api.Register(...)` to attach routes.

[api/journal.go](api/journal.go) registers the journal API, which console
proxies to this backend after stripping
`/api/proxy/plugin/logging-console-plugin/api/`:

| Method | Path | Query |
| ------ | ---- | ----- |
| GET | `/v1/nodes/{node}/journal` | the journal query core built (`unit`, `tailLines`, ...), passed on verbatim |
| GET | `/v1/nodes/{node}/journal/raw` | the same, with `tailLines=0` forced (the unabridged journal the "open the raw file" link points at) |

Both look up the `node-logs-api` pod on `{node}` with the plugin's own
`ServiceAccount` and fetch the journal from it, after authorizing the caller
(see [api/credentials.go](api/credentials.go)).

[api/hello.go](api/hello.go) registers an example route on the *asset* route
instead, at `/api/plugins/console-logging-plugin/api/hello-world`, which
returns:

```json
{"message":"Hello World"}
```

To add more backend routes, add another file under `api/` following the same
`init()` + `Register` pattern.

The binary auto-detects TLS: if `/var/cert/tls.crt` and `/var/cert/tls.key`
are present (e.g. mounted from a service's serving certificate), it serves
HTTPS; otherwise it falls back to plain HTTP.

## Tab ownership flags

A `console.tab/horizontalNav` extension can only *add* a tab to a details
page, never replace one, so core and a plugin would otherwise both show a
"Logs" tab. This plugin uses the same mechanic the sibling `terminal` plugin
does for its Terminal tabs: the backend serves its own configuration at
`/config.json` (on the plugin *asset* route, the only one available before any
flag is set), the frontend reads it in a `console.flag` handler
([src/flags.ts](src/flags.ts)), and console core -- patched by this repo --
drops its own tab while the matching flag is set.

| Backend env var | Console feature flag | Core tab it hides | Core patch |
| --------------- | -------------------- | ----------------- | ---------- |
| `NODE_LOGS_ENABLED` | `LOGGING_PLUGIN_NODE_LOGS_ENABLED` | Node details -> Logs | `patches/0024-node-logs-flag-gate.patch` |
| `POD_LOGS_ENABLED` | `LOGGING_PLUGIN_POD_LOGS_ENABLED` | Pod details -> Logs | `patches/0025-pod-logs-flag-gate.patch` |

Both default to `false` (chart values `tabs.nodeLogs` / `tabs.podLogs`), so an
upgrade never moves a tab out from under a cluster on its own. They are not
equivalent, though:

- `tabs.podLogs` has a tab behind it -- the [structured log
  viewer](#structured-log-viewer) below. Turn it on to use it.
- `tabs.nodeLogs` does not. This plugin has no Node Logs tab of its own; it
  only repairs core's from the outside. Turning it on leaves the Node details
  page with no Logs tab at all.

A console without this plugin never sees either flag and is unaffected.

## Structured log viewer

The Pod details **Logs** tab ([src/logs/](src/logs)) reads a container's log
from console's Kubernetes proxy under the logged-in user's own credentials --
it needs nothing from this plugin's backend, and works on any cluster whether
or not the `node-logs-api` DaemonSet is deployed.

Its point is that most container logs are JSON, and reading raw JSON lines is
miserable. A toolbar select chooses how to render them:

| Format | What it shows |
| ------ | ------------- |
| **Plain** | The line exactly as written. |
| **JSON** | Timestamp, level, logger and message, resolved through the common key aliases (`ts`/`time`/`@timestamp`, `level`/`severity`, `logger`/`logger_name`/`name`, `msg`/`message`, ...). |
| **ECS** | The same four columns, from [ECS](https://www.elastic.co/guide/en/ecs/current/index.html)'s own fields only: `@timestamp`, `log.level`, `log.logger`, `message`. Flat dotted keys and nested objects are both read, since the Java, Go and Python encoders differ. |

The starting format is guessed from the first few lines and can be changed at
any time; an explicit choice is remembered across pods. **A line that does not
decode is rendered as plain text**, per line -- so a JVM's startup banner, a
partial write, or anything else on stderr stays readable in the middle of an
otherwise-JSON log instead of vanishing.

Java's ECS encoder puts a logged throwable in `error.stack_trace` (as a string,
or as an array of frames with `stackTraceAsArray`). A row that has one is
marked, and **its stack trace stays collapsed** until the row is expanded, so a
three-hundred-line trace does not break up the log. Expanding any other row
shows its full record.

### Why it stays fast on a 100k-line log

Container logs routinely run to six figures of lines. The naive shape --
`text.split('\n').map(JSON.parse)` -- turns a 50 MB text buffer into a ~250 MB
live object graph that every GC pass then has to walk, and mounting a row per
line is worse. So:

- [src/logs/buffer.ts](src/logs/buffer.ts) indexes **line extents only**, in
  typed arrays, over text held in ~1 MiB pages. No per-line string, no per-line
  object. Pages exist because appending builds a rope and any `slice()` flattens
  it, which would otherwise mean flattening the whole buffer on every frame of a
  followed log; a page is sealed only on a line boundary, so no line ever spans
  two. The oldest lines (and the pages they were the last users of) are dropped
  past a line cap.
- [src/logs/LogViewer.tsx](src/logs/LogViewer.tsx) mounts only the rows the
  viewport can show, and **parses in the row renderer** -- about 150 lines per
  frame, well under a millisecond -- caching the result in a `WeakMap` side
  table keyed by buffer. Rows are a fixed height, which is what lets a row be
  positioned without having been parsed; expanded rows are measured and their
  height folded into the offsets.
- [src/logs/useLogStream.ts](src/logs/useLogStream.ts) decodes the response body
  in whatever chunks arrive and coalesces re-renders to one per animation frame,
  so a container logging in a tight loop costs one render per frame rather than
  one per chunk.

## Testing

This project uses [Jest](https://jestjs.io) and
[React Testing Library](https://testing-library.com/react) for unit tests.
Since most of the console's dynamic plugin SDK is only available at runtime
via module federation, `__mocks__/@openshift-console/dynamic-plugin-sdk.tsx`
provides minimal stub implementations for the SDK components/APIs this
plugin actually uses (add to it as you use more of the SDK).

```sh
yarn test        # run once
yarn coverage     # run with coverage
```

## i18n

The plugin uses [react-i18next](https://react.i18next.com/) for translations.
The i18n namespace is `plugin__logging-console-plugin`. You can use the
`useTranslation` hook as follows:

```tsx
const { t } = useTranslation('plugin__logging-console-plugin');
return <h1>{t('Node Logs')}</h1>;
```

Running `yarn i18n` updates the JSON files in the `locales` folder.

## Linting

This project uses eslint (flat config, `eslint.config.mjs`) and prettier.
Linting can be run with `yarn lint`.

## References

- [Console Plugin SDK README](https://github.com/openshift/console/tree/master/frontend/packages/console-dynamic-plugin-sdk)
- [Dynamic Plugin Enhancement Proposal](https://github.com/openshift/enhancements/blob/master/enhancements/console/dynamic-plugins.md)
- [console-plugin-template](https://github.com/openshift/console-plugin-template) — the official OpenShift template this project's tooling (webpack/SWC, ESLint 9 flat config, Jest, i18n scripts) is kept in sync with
