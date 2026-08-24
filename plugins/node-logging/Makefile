PLUGIN_NAME := node-logging
SHELL := /bin/bash

CURRENT_BRANCH := $(shell git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
SHORT_COMMIT_HASH := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)

ifeq ($(CURRENT_BRANCH),main)
DEFAULT_TAG := latest
else
DEFAULT_TAG := git-$(SHORT_COMMIT_HASH)
endif

IMAGE ?= steigr/console-node-logging-plugin
TAG ?= $(DEFAULT_TAG)
DOCKERFILE ?= Dockerfile
BUILD_CONTEXT ?= .
PLATFORMS ?= linux/amd64,linux/arm64
BUILDER ?= multiarch-builder
IMAGE_REF := $(IMAGE):$(TAG)

.DEFAULT_GOAL := push

.PHONY: builder build push print-image

## builder: create the multi-platform buildx builder if it doesn't exist yet
builder:
	@docker buildx inspect $(BUILDER) >/dev/null 2>&1 || \
	  docker buildx create --name $(BUILDER) --driver docker-container --bootstrap

## build: build the image for all PLATFORMS (does not push; loads only for a single platform)
build: builder
	docker buildx build --builder=$(BUILDER) --progress=plain --platform=$(PLATFORMS) --file=$(DOCKERFILE) --build-arg=PLUGIN_NAME=$(PLUGIN_NAME) --tag=$(IMAGE_REF) $(BUILD_CONTEXT)

## push: build the image for all PLATFORMS and push the resulting manifest list
push: builder
	docker buildx build --builder=$(BUILDER) --progress=plain --platform=$(PLATFORMS) --file=$(DOCKERFILE) --build-arg=PLUGIN_NAME=$(PLUGIN_NAME) --tag=$(IMAGE_REF) --push $(BUILD_CONTEXT)

print-image:
	@echo $(IMAGE_REF)
