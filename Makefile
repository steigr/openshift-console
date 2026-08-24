include config.mk

SHELL := /bin/bash

CURRENT_BRANCH     := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
SHORT_COMMIT_HASH  := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
ifeq ($(CURRENT_BRANCH),main)
DEFAULT_TAG := latest
else
DEFAULT_TAG := git-$(SHORT_COMMIT_HASH)
endif
TAG ?= $(DEFAULT_TAG)

CONSOLE_SOURCE_DIR             := $(CURDIR)/console
CONSOLE_PATCH_DIR               := $(CURDIR)/patches
CONSOLE_CUSTOM_DOCKERFILE       := $(CURDIR)/containers/openshift-console/Dockerfile
CONSOLE_TAG                    ?= $(CONSOLE_IMAGE):$(TAG)

MONITORING_PLUGIN_DIR           := $(CURDIR)/plugins/monitoring
MONITORING_PLUGIN_UPSTREAM_DIR  := $(MONITORING_PLUGIN_DIR)/upstream/monitoring-plugin
MONITORING_PLUGIN_TAG           ?= $(MONITORING_PLUGIN_IMAGE):$(TAG)

NETWORKING_PLUGIN_DIR           := $(CURDIR)/plugins/networking
NETWORKING_PLUGIN_UPSTREAM_DIR  := $(NETWORKING_PLUGIN_DIR)/upstream/networking-console-plugin
NETWORKING_PLUGIN_TAG           ?= $(NETWORKING_PLUGIN_IMAGE):$(TAG)

KUBEVIRT_PLUGIN_DIR             := $(CURDIR)/plugins/kubevirt
KUBEVIRT_PLUGIN_UPSTREAM_DIR    := $(KUBEVIRT_PLUGIN_DIR)/upstream/kubevirt-plugin
KUBEVIRT_PLUGIN_TAG             ?= $(KUBEVIRT_PLUGIN_IMAGE):$(TAG)

EXTERNAL_SECRETS_PLUGIN_DIR     := $(CURDIR)/plugins/external-secrets
EXTERNAL_SECRETS_PLUGIN_TAG     ?= $(EXTERNAL_SECRETS_PLUGIN_IMAGE):$(TAG)

NODE_LOGGING_PLUGIN_DIR         := $(CURDIR)/plugins/node-logging
NODE_LOGGING_PLUGIN_TAG         ?= $(NODE_LOGGING_PLUGIN_IMAGE):$(TAG)

CERT_MANAGER_PLUGIN_DIR          := $(CURDIR)/plugins/cert-manager
CERT_MANAGER_PLUGIN_TAG          ?= $(CERT_MANAGER_PLUGIN_IMAGE):$(TAG)

.PHONY: all build push clean \
	clone-console patch-console build-console container-console push-console clean-console \
	frontend-source-monitoring frontend-source-clean-monitoring build-monitoring push-monitoring clean-monitoring \
	frontend-source-networking frontend-source-clean-networking build-networking push-networking clean-networking \
	frontend-source-kubevirt frontend-source-clean-kubevirt build-kubevirt push-kubevirt clean-kubevirt \
	build-external-secrets push-external-secrets clean-external-secrets \
	build-node-logging push-node-logging clean-node-logging \
	build-cert-manager push-cert-manager clean-cert-manager \
	print-images

all: build

## build: build console + all plugin images
build: build-console build-monitoring build-networking build-kubevirt build-external-secrets build-node-logging build-cert-manager

## push: push console + all plugin images
push: push-console push-monitoring push-networking push-kubevirt push-external-secrets push-node-logging push-cert-manager

## clean: remove all cloned/patched sources for console + plugins
clean: clean-console clean-monitoring clean-networking clean-kubevirt clean-external-secrets clean-node-logging clean-cert-manager

print-images:
	@echo "$(CONSOLE_TAG)"
	@echo "$(MONITORING_PLUGIN_TAG)"
	@echo "$(NETWORKING_PLUGIN_TAG)"
	@echo "$(KUBEVIRT_PLUGIN_TAG)"
	@echo "$(EXTERNAL_SECRETS_PLUGIN_TAG)"
	@echo "$(NODE_LOGGING_PLUGIN_TAG)"
	@echo "$(CERT_MANAGER_PLUGIN_TAG)"

# --- console ---------------------------------------------------------------

clone-console: clean-console
	git init $(CONSOLE_SOURCE_DIR)
	cd $(CONSOLE_SOURCE_DIR) && \
	  git fetch --force --depth=1 --no-tags --prune --progress --no-recurse-submodules $(CONSOLE_REPO_URL) $(CONSOLE_BRANCH) && \
	  git checkout FETCH_HEAD

patch-console: clone-console
	cd "$(CONSOLE_SOURCE_DIR)"; \
	for p in "$(CONSOLE_PATCH_DIR)"/0*.patch; do \
	  echo "Applying $$(basename "$$p")"; \
	  git apply --whitespace=nowarn "$$p"; \
	done

build-console: patch-console
	cd "$(CONSOLE_SOURCE_DIR)"; \
	mise use node@24; \
	mise use golang@1.25; \
	GOOS=linux \
	GOARCH=amd64 \
	CGO_ENABLED=0 \
	GO_LDFLAGS="-s -w" \
	mise exec -- bash build.sh

container-console: build-console
	cp "$(CONSOLE_CUSTOM_DOCKERFILE)" "$(CONSOLE_SOURCE_DIR)"
	cd "$(CONSOLE_SOURCE_DIR)"; \
	docker build --progress=plain --platform=$(PLATFORM) --tag=$(CONSOLE_TAG) .

push-console: container-console
	docker push $(CONSOLE_TAG)

clean-console:
	rm -rf $(CONSOLE_SOURCE_DIR)

# --- plugins/monitoring ------------------------------------------------------

## frontend-source-monitoring: clone upstream monitoring-plugin and apply frontend patches, for local inspection/dev
frontend-source-monitoring: frontend-source-clean-monitoring
	git clone --depth 1 --branch $(MONITORING_PLUGIN_REF) $(MONITORING_PLUGIN_REPO_URL) $(MONITORING_PLUGIN_UPSTREAM_DIR)
	@find $(MONITORING_PLUGIN_DIR)/patches/frontend -type f -name '*.patch' | sort | while read -r p; do \
	  echo "  $$p"; \
	  git -C $(MONITORING_PLUGIN_UPSTREAM_DIR) apply "$$p"; \
	done

frontend-source-clean-monitoring:
	rm -rf $(MONITORING_PLUGIN_UPSTREAM_DIR)

build-monitoring:
	docker build --progress=plain --platform=$(PLATFORM) \
	  --file=$(MONITORING_PLUGIN_DIR)/Dockerfile \
	  --build-arg=NETWORKING_CONSOLE_PLUGIN_REPO=$(MONITORING_PLUGIN_REPO_URL) \
	  --build-arg=NETWORKING_CONSOLE_PLUGIN_REF=$(MONITORING_PLUGIN_REF) \
	  --tag=$(MONITORING_PLUGIN_TAG) $(MONITORING_PLUGIN_DIR)

push-monitoring: build-monitoring
	docker push $(MONITORING_PLUGIN_TAG)

clean-monitoring: frontend-source-clean-monitoring

# --- plugins/networking ------------------------------------------------------

## frontend-source-networking: clone upstream networking-console-plugin and apply frontend patches, for local inspection/dev
frontend-source-networking: frontend-source-clean-networking
	git clone --depth 1 --branch $(NETWORKING_PLUGIN_REF) $(NETWORKING_PLUGIN_REPO_URL) $(NETWORKING_PLUGIN_UPSTREAM_DIR)
	@find $(NETWORKING_PLUGIN_DIR)/patches/frontend -type f -name '*.patch' | sort | while read -r p; do \
	  echo "  $$p"; \
	  git -C $(NETWORKING_PLUGIN_UPSTREAM_DIR) apply "$$p"; \
	done

frontend-source-clean-networking:
	rm -rf $(NETWORKING_PLUGIN_UPSTREAM_DIR)

build-networking:
	docker build --progress=plain --platform=$(PLATFORM) \
	  --file=$(NETWORKING_PLUGIN_DIR)/Dockerfile \
	  --build-arg=NETWORKING_CONSOLE_PLUGIN_REPO=$(NETWORKING_PLUGIN_REPO_URL) \
	  --build-arg=NETWORKING_CONSOLE_PLUGIN_REF=$(NETWORKING_PLUGIN_REF) \
	  --tag=$(NETWORKING_PLUGIN_TAG) $(NETWORKING_PLUGIN_DIR)

push-networking: build-networking
	docker push $(NETWORKING_PLUGIN_TAG)

clean-networking: frontend-source-clean-networking

# --- plugins/kubevirt ------------------------------------------------------

## frontend-source-kubevirt: clone upstream kubevirt-plugin and apply frontend patches, for local inspection/dev
frontend-source-kubevirt: frontend-source-clean-kubevirt
	git clone --depth 1 --branch $(KUBEVIRT_PLUGIN_REF) $(KUBEVIRT_PLUGIN_REPO_URL) $(KUBEVIRT_PLUGIN_UPSTREAM_DIR)
	@find $(KUBEVIRT_PLUGIN_DIR)/patches/frontend -type f -name '*.patch' | sort | while read -r p; do \
	  echo "  $$p"; \
	  git -C $(KUBEVIRT_PLUGIN_UPSTREAM_DIR) apply "$$p"; \
	done

frontend-source-clean-kubevirt:
	rm -rf $(KUBEVIRT_PLUGIN_UPSTREAM_DIR)

build-kubevirt:
	docker build --progress=plain --platform=$(PLATFORM) \
	  --file=$(KUBEVIRT_PLUGIN_DIR)/Dockerfile \
	  --build-arg=NETWORKING_CONSOLE_PLUGIN_REPO=$(KUBEVIRT_PLUGIN_REPO_URL) \
	  --build-arg=NETWORKING_CONSOLE_PLUGIN_REF=$(KUBEVIRT_PLUGIN_REF) \
	  --tag=$(KUBEVIRT_PLUGIN_TAG) $(KUBEVIRT_PLUGIN_DIR)

push-kubevirt: build-kubevirt
	docker push $(KUBEVIRT_PLUGIN_TAG)

clean-kubevirt: frontend-source-clean-kubevirt

# --- plugins/external-secrets ------------------------------------------------

## build-external-secrets: build the external-secrets plugin image (frontend source lives in this repo, no upstream clone)
build-external-secrets:
	docker build --progress=plain --platform=$(PLATFORM) \
	  --file=$(EXTERNAL_SECRETS_PLUGIN_DIR)/Dockerfile \
	  --tag=$(EXTERNAL_SECRETS_PLUGIN_TAG) $(EXTERNAL_SECRETS_PLUGIN_DIR)

push-external-secrets: build-external-secrets
	docker push $(EXTERNAL_SECRETS_PLUGIN_TAG)

clean-external-secrets:
	rm -rf $(EXTERNAL_SECRETS_PLUGIN_DIR)/dist

# --- plugins/node-logging ----------------------------------------------------

## build-node-logging: build the node-logging plugin image (frontend+backend source lives in this repo, no upstream clone)
build-node-logging:
	docker build --progress=plain --platform=$(PLATFORM) \
	  --file=$(NODE_LOGGING_PLUGIN_DIR)/Dockerfile \
	  --tag=$(NODE_LOGGING_PLUGIN_TAG) $(NODE_LOGGING_PLUGIN_DIR)

push-node-logging: build-node-logging
	docker push $(NODE_LOGGING_PLUGIN_TAG)

clean-node-logging:
	rm -rf $(NODE_LOGGING_PLUGIN_DIR)/dist

# --- plugins/cert-manager ------------------------------------------------------

## build-cert-manager: build the cert-manager plugin image (frontend+backend source lives in this repo, no upstream clone)
build-cert-manager:
	docker build --progress=plain --platform=$(PLATFORM) \
	  --file=$(CERT_MANAGER_PLUGIN_DIR)/Dockerfile \
	  --tag=$(CERT_MANAGER_PLUGIN_TAG) $(CERT_MANAGER_PLUGIN_DIR)

push-cert-manager: build-cert-manager
	docker push $(CERT_MANAGER_PLUGIN_TAG)

clean-cert-manager:
	rm -rf $(CERT_MANAGER_PLUGIN_DIR)/dist
