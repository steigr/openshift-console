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

# --- plugins/cert-manager ----------------------------------------------------
CERT_MANAGER_PLUGIN_IMAGE ?= steigr/console-cert-manager-plugin

# --- common ---------------------------------------------------------------
ARCH     ?= amd64
PLATFORM ?= linux/$(ARCH)

-include config.local.mk
