# Console Node Logging Plugin - OpenShift Console Plugin

This project is an OpenShift Console dynamic plugin that adds a **Node Logs**
tab to the Node resource details page (`v1` `Node`).

It also ships a small custom backend API route (`/api/hello-world`), served by
a single static Go binary that embeds the built frontend assets and is
reachable through the console's plugin proxy. The tab calls this route and
displays the response.

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
make push IMAGE=quay.io/my-repository/console-node-logging-plugin TAG=v0.1.0
```

You can also run `docker build`/`docker push` directly for a single-platform
image (e.g. for local testing):

```sh
docker build -t quay.io/my-repository/console-node-logging-plugin:latest .
docker run -it --rm -d -p 8443:8443 quay.io/my-repository/console-node-logging-plugin:latest
docker push quay.io/my-repository/console-node-logging-plugin:latest
```

The binary listens on `$PORT` (default `8443` when a TLS cert/key pair is
present, `8080` otherwise) and serves plain HTTP unless
`/var/cert/tls.crt`/`/var/cert/tls.key` are present, in which case it serves
HTTPS using those files (see [Deployment on cluster](#deployment-on-cluster)).

## Deployment on cluster

A [Helm](https://helm.sh) chart is available under
[charts/console-node-logging-plugin](charts/console-node-logging-plugin) to
deploy the plugin to a Kubernetes/OpenShift environment. Consult the chart's
[values.yaml](charts/console-node-logging-plugin/values.yaml) for the full
set of supported parameters.

Note: registering the plugin with the OpenShift console additionally
requires a `ConsolePlugin` custom resource (see
[console-extensions.json](console-extensions.json) for the extensions it
declares) and enabling it in the console operator config; the chart in this
repo does not currently manage those on its own.

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

[api/hello.go](api/hello.go) registers the example route at
`/api/plugins/console-node-logging-plugin/api/hello-world`, matching the
full path the console forwards to the plugin's backend `Service` (the
`ConsolePlugin`'s `basePath` is `/`, so paths are forwarded unchanged), and
returns:

```json
{"message":"Hello World"}
```

[NodeLogsTab](src/components/NodeLogsTab.tsx) calls this route and renders
the response. To add more backend routes, add another file under `api/`
following the same `init()` + `Register` pattern.

The binary auto-detects TLS: if `/var/cert/tls.crt` and `/var/cert/tls.key`
are present (e.g. mounted from a service's serving certificate), it serves
HTTPS; otherwise it falls back to plain HTTP.

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
The i18n namespace is `plugin__node-logging-console-plugin`. You can use the
`useTranslation` hook as follows:

```tsx
const { t } = useTranslation('plugin__node-logging-console-plugin');
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
