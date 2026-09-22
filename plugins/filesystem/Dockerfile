ARG GOLANG_VERSION=1.26
ARG NODE_VERSION=22-slim

FROM golang:${GOLANG_VERSION} AS golang
FROM node:${NODE_VERSION} AS node

FROM node AS frontend-builder
WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json webpack.config.ts console-extensions.json .swcrc ./
COPY locales locales
COPY src src
RUN npm run build

FROM golang AS builder
WORKDIR /usr/src/app
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
COPY api api
COPY internal internal
COPY gen gen
# Built ahead of the frontend copy so a frontend-only change does not redo the
# module download and the backend's own compile.
COPY --from=frontend-builder /usr/src/app/dist dist/
ENV CGO_ENABLED=0
RUN go build -ldflags "-s -w" -o /bin/plugin .

FROM scratch
COPY --from=golang /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /bin/plugin /bin/filesystem-plugin
ENV PATH=/bin PLUGIN_NAME=filesystem-console-plugin
# The plugin backend needs no privilege at all. The agent DaemonSet runs the
# same image with runAsUser: 0 and hostPID, because reaching into another
# container's mount namespace is exactly what it is for.
USER 1001
ENTRYPOINT ["filesystem-plugin"]
