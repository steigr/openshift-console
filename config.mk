# config.mk - repo URLs, branches/refs and image names for all components.
# Override any of these on the command line or in a local config.local.mk, e.g.:
#   make build-console CONSOLE_BRANCH=release-4.21

# --- console -----------------------------------------------------------
CONSOLE_REPO_URL   ?= https://github.com/openshift/console
CONSOLE_BRANCH     ?= release-4.22
CONSOLE_IMAGE      ?= steigr/openshift-console

# --- plugins/monitoring --------------------------------------------------
MONITORING_PLUGIN_REPO_URL ?= https://github.com/openshift/monitoring-plugin
MONITORING_PLUGIN_REF      ?= release-4.22
MONITORING_PLUGIN_IMAGE    ?= steigr/console-monitoring-plugin

# --- plugins/networking --------------------------------------------------
NETWORKING_PLUGIN_REPO_URL ?= https://github.com/openshift/networking-console-plugin
NETWORKING_PLUGIN_REF      ?= main
NETWORKING_PLUGIN_IMAGE    ?= steigr/console-networking-plugin

# --- plugins/kubevirt --------------------------------------------------
KUBEVIRT_PLUGIN_REPO_URL ?= https://github.com/kubevirt-ui/kubevirt-plugin
KUBEVIRT_PLUGIN_REF      ?= v4.22.1
KUBEVIRT_PLUGIN_IMAGE    ?= steigr/console-kubevirt-plugin

# --- plugins/external-secrets ---------------------------------------------
EXTERNAL_SECRETS_PLUGIN_IMAGE ?= steigr/console-external-secrets-plugin

# --- plugins/node-logging ---------------------------------------------------
NODE_LOGGING_PLUGIN_IMAGE ?= steigr/console-node-logging-plugin

# --- plugins/external-dns ---------------------------------------------------
EXTERNAL_DNS_PLUGIN_IMAGE ?= steigr/console-external-dns-plugin

# --- plugins/cert-manager ----------------------------------------------------
CERT_MANAGER_PLUGIN_IMAGE ?= steigr/console-cert-manager-plugin

# --- plugins/flux -------------------------------------------------------------
FLUX_PLUGIN_IMAGE ?= steigr/console-flux-plugin

# --- plugins/terminal ----------------------------------------------------------
# Provides the Pod Terminal tab over VNC (noVNC + pods/portforward) for pods
# labelled vnc.container.kubernetes.io/enabled=true, and an alternate Node
# Terminal tab -- each independently switchable back to console core's
# built-in terminal via a flag served from this plugin's own backend
# (POD_TERMINAL_ENABLED/NODE_TERMINAL_ENABLED below). Requires the console
# patches patches/0019-pod-connect-transport-extension.patch (Pod) and
# patches/0020-node-terminal-flag-gate.patch (Node).
TERMINAL_PLUGIN_IMAGE ?= steigr/console-terminal-plugin

# --- plugins/terminal/node-terminal ---------------------------------------------
# Standalone privileged break-glass tool, not a console plugin -- folded into
# the terminal plugin's directory (it's the debug-pod image the Node Terminal
# tab, plugin or core, points at) but still built and shipped as its own
# image -- see plugins/terminal/node-terminal/IMPLEMENTATION-PLAN.md. Built
# multi-arch via `docker buildx` (linux/amd64 + linux/arm64), unlike the
# single-PLATFORM `docker build` used for the components above.
TERMINAL_SHIM_IMAGE     ?= steigr/node-terminal-shim
TERMINAL_SHIM_PLATFORMS ?= linux/amd64,linux/arm64

# --- plugins/openshift-synchronizer -------------------------------------------
# Standalone controller that mirrors Namespaces onto project.openshift.io/v1
# Project custom resources and backfills instance-type/zone Node labels
# (optionally from Prometheus), not a console plugin -- see
# plugins/openshift-synchronizer/README.md.
OPENSHIFT_SYNCHRONIZER_IMAGE ?= steigr/openshift-synchronizer

# --- common ---------------------------------------------------------------
ARCH     ?= amd64
PLATFORM ?= linux/$(ARCH)

-include config.local.mk
