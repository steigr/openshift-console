ARG GOLANG_VERSION=1.26
ARG NODE_VERSION=22-slim

FROM golang:${GOLANG_VERSION} AS golang
FROM node:${NODE_VERSION} AS node

FROM node AS frontend-builder
WORKDIR /usr/src/app
COPY . .
RUN corepack enable \
 && yarn install --immutable \
 && yarn build

FROM golang AS builder
WORKDIR /usr/src/app
ARG PLUGIN_NAME=logging
COPY go.mod go.sum *.go ./
COPY api api
RUN go mod download
COPY --from=frontend-builder /usr/src/app/dist dist/api/plugins/${PLUGIN_NAME}/
RUN find dist
ENV CGO_ENABLED=0
RUN go build -ldflags "-s -w" -o /bin/plugin .
# The node-logs-api DaemonSet runs the host's journalctl out of a bind-mounted
# /usr. Its ELF interpreter (/lib64/ld-linux-x86-64.so.2, or
# /lib/ld-linux-aarch64.so.1) is a root-level path that usr-merged hosts
# provide as a symlink into /usr, and a scratch image has no such symlink.
RUN mkdir -p /rootfs && ln -s usr/lib /rootfs/lib && ln -s usr/lib64 /rootfs/lib64

FROM scratch
COPY --from=builder /rootfs/ /
COPY --from=builder /bin/plugin /bin/logging-plugin
ENV PATH=/bin GLOBAL_API_PATH_PREFIX=/ PLUGIN_NAME=logging
USER 1001
ENTRYPOINT ["logging-plugin"]
