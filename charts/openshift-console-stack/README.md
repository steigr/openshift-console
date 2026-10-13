# openshift-console-stack

Umbrella chart for the console (`charts/openshift-console`), this repo's console
plugins and the openshift-synchronizer ("project synchronizer"), as one release.

| key                   | chart                             | default |
|-----------------------|-----------------------------------|---------|
| `console`             | `openshift-console`               | on      |
| `networking`          | `console-networking-plugin`       | on      |
| `monitoring`          | `console-monitoring-plugin`       | off     |
| `externalSecrets`     | `console-external-secrets-plugin` | off     |
| `logging`             | `console-logging-plugin`          | on      |
| `externalDns`         | `console-external-dns-plugin`     | off     |
| `certManager`         | `console-cert-manager-plugin`     | off     |
| `flux`                | `console-flux-plugin`             | off     |
| `terminal`            | `console-terminal-plugin`         | on      |
| `filesystem`          | `console-filesystem-plugin`       | off     |
| `kubevirt`            | `console-kubevirt-plugin`         | off     |
| `projectSynchronizer` | `openshift-synchronizer`          | on      |

Plugins whose backing software may not be on a cluster (cert-manager, Flux, a
Prometheus/VictoriaMetrics operator, ...) and the privileged filesystem agent
are off by default. Everything under a key is that chart's own values.

## Selecting plugins

`<key>.enabled` is the only switch. An enabled plugin's `consoleRegistration`
(name, asset url, API `proxy`, load `order`) is imported into
`console.pluginRegistry.<key>`, which the console chart turns into
`BRIDGE_PLUGINS`, `BRIDGE_PLUGIN_PROXY` and `BRIDGE_I18N_NAMESPACES`
(`plugin__<name>`); a disabled plugin is neither deployed nor registered.
`order` reproduces the order the plugins were listed in so far, which decides how
their nav items line up.

`import-values` reads chart defaults only, so a changed registration goes in
`console.pluginRegistry.<key>` (merged over the imported one), not in
`<key>.consoleRegistration`. Leave `console.plugins` and `console.i18nNamespaces`
for plugins deployed outside this chart -- listing a stack plugin there as well
registers it twice.

## Names and labels

Each component defaults to the names of the release it used to be on its own:
`fullnameOverride` (object names, e.g. `cert-manager-plugin`), `nameOverride`
(the chart name, which a subchart alias would otherwise replace in
`app.kubernetes.io/name` and the container name) and `instanceOverride`
(`app.kubernetes.io/instance`, otherwise this release's name). Selectors include
both labels and are immutable, which is why an existing Deployment or DaemonSet
can only be taken over with the old values. Changing a `fullnameOverride` means
changing the plugin's registration url (and proxy url) with it, since they point
at its Service.

Rendered against the values of the separate releases on home.alaunstras.se, this
chart produces the same objects with the same names, labels, selectors and
environment; only `helm.sh/chart` and `app.kubernetes.io/version` differ.

## CRDs

`charts/openshift-console-crds` is not a dependency. Helm maps every object of a
release to an API before applying any of it, so a release cannot create the
ConsolePlugin CRD and the ConsolePlugin objects its plugins render. Install the
CRDs as their own release first.

## Moving separate releases under this chart

The objects stay where they are; only their Helm ownership moves. With Flux,
keeping the console's release (`openshift-console`) and folding the others into
it:

1. Set `spec.suspend: true` on every HelmRelease being folded in (all but the
   console's and the CRDs') and let Flux apply it. A suspended HelmRelease is
   deleted without a `helm uninstall`.
2. Hand each of their objects to the console's release, then drop the old
   release records so nothing can uninstall them later:
   ```bash
   for r in networking-plugin monitoring-plugin external-secrets-plugin logging-plugin external-dns-plugin cert-manager-plugin flux-plugin terminal-plugin filesystem-plugin openshift-synchronizer; do
     helm -n openshift-console get manifest "$r" | kubectl -n openshift-console annotate -f - --overwrite meta.helm.sh/release-name=openshift-console
     kubectl -n openshift-console delete secret -l "owner=helm,name=$r"
   done
   ```
3. In one commit, delete those HelmReleases and point the console's at
   `openshift-console-stack`: its values move under `console:`, each plugin's
   under its key with `enabled: true`, `console.plugins`/`i18nNamespaces` go
   (the registry replaces them), postRenderers and `dependsOn` entries of the
   folded releases move over (minus the ones naming each other).
4. Reconcile the Kustomization, then the HelmRelease. Flux does not upgrade a
   release whose chart *name* changed: it uninstalls it and installs the new
   chart. The re-annotated plugin objects are not part of the uninstalled
   release and are adopted as they are, but the console's own objects
   (Deployment, Service, HTTPRoute, RBAC, extraManifests -- an ExternalSecret's
   target Secret goes with it) are deleted and recreated, so expect a short
   console outage. Pods whose template carries `app.kubernetes.io/version` roll
   once.

Done this way on home.alaunstras.se on 2026-10-13: the plugin and synchronizer
objects kept their creation dates; the console was back within about 20s.
