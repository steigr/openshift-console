ARG GOLANG_VERSION=1.26.3
ARG NODE_VERSION=22.9.0-slim

FROM golang:${GOLANG_VERSION} AS golang
FROM node:${NODE_VERSION} AS node

FROM node AS networking-console-plugin-builder
WORKDIR /opt/networking-console-plugin
ARG NETWORKING_CONSOLE_PLUGIN_REPO=https://github.com/openshift/networking-console-plugin
ARG NETWORKING_CONSOLE_PLUGIN_REF=main
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch ${NETWORKING_CONSOLE_PLUGIN_REF} ${NETWORKING_CONSOLE_PLUGIN_REPO} .

COPY patches/frontend/ /tmp/networking-console-plugin-patches/frontend/
RUN find /tmp/networking-console-plugin-patches/frontend -type f -name '*.patch' | sort | while read -r patch; do echo "$(basename "$patch")" >&2; git apply "$patch"; done

RUN npm ci \
 && npm run build

FROM golang AS builder

ARG DEBIAN_REMOTE=http://deb.debian.org/debian
ARG DEBIAN_SECURITY_REMOTE=http://deb.debian.org/debian-security

ARG UPX_VERSION=4.2.4-1.1
RUN export DEBIAN_FRONTEND=noninteractive \
 && cp /etc/apt/sources.list.d/debian.sources /tmp/sources.list.backup.debian.sources \
 && sed -e "s#http://deb.debian.org/debian-security#$DEBIAN_SECURITY_REMOTE#g" \
        -e "s#http://deb.debian.org/debian#$DEBIAN_REMOTE#g" \
        -i /etc/apt/sources.list.d/debian.sources \
 && cat /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && trap 'apt-cache policy "^upx-ucl$"' EXIT \
 && apt-get install -y --no-install-recommends \
      upx-ucl${UPX_VERSION:+=$UPX_VERSION} \
 && trap - EXIT \
 && cat /tmp/sources.list.backup.debian.sources > /etc/apt/sources.list.d/debian.sources \
 && rm /tmp/sources.list.backup.debian.sources

ARG PLUGIN_NAME=networking
COPY go.mod go.mod
COPY api api
COPY main.go main.go
COPY patches/backend/ /tmp/networking-console-plugin-patches/backend/
COPY --from=networking-console-plugin-builder /opt/networking-console-plugin/dist dist/api/plugins/${PLUGIN_NAME}/
ARG GONOSUMDB=""
ARG GOPROXY=""
ENV CGO_ENABLED=0
RUN find /tmp/networking-console-plugin-patches/backend -type f -name '*.patch' | sort | while read -r patch; do echo "$(basename "$patch")" >&2; git apply --no-index "$patch"; done \
 && go build -ldflags "-s -w" -o bin/${PLUGIN_NAME} ./main.go \
 && chmod 0755 bin/${PLUGIN_NAME} \
 && upx -9 -o/bin/plugin bin/${PLUGIN_NAME}

FROM scratch
COPY --from=builder /bin/plugin /bin/networking-plugin
ENV PATH=/bin
USER 1001
ENTRYPOINT ["networking-plugin"]
