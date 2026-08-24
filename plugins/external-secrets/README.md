# external-secrets console plugin

Dynamic OpenShift console plugin for [external-secrets](https://external-secrets.io) (`external-secrets.io`
CRDs). Unlike the other plugins in this repo, this one is not built by patching an upstream
project — the frontend source lives directly in `src/`, scaffolded after
[openshift/console-plugin-template](https://github.com/openshift/console-plugin-template).

Adds an "External Secrets" navigation group with three sections:

- ExternalSecret, PushSecret (namespaced)
- ClusterExternalSecret, ClusterPushSecret (cluster-scoped)
- SecretStore, ClusterSecretStore (namespaced/cluster-scoped store types)

SecretStore/ClusterSecretStore list pages show the `Ready` condition, `status.capabilities`, and
the single configured `spec.provider` key (`!` if more than one is set, which the CRD's own
validation should prevent but is rendered defensively). ExternalSecret/ClusterExternalSecret list
pages show time since `status.refreshTime` and expose a "Force refresh" action (patches the
`force-sync` annotation, matching upstream's documented force-sync mechanism) alongside the usual
edit-labels/edit-annotations/delete actions.

## Local frontend build

```bash
npm ci
npm run build
```

## Image build

```bash
make build-external-secrets   # from the repo root
```
