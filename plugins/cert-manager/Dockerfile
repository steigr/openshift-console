ARG GOLANG_VERSION=1.26.3
ARG NODE_VERSION=22.9.0-slim

FROM golang:${GOLANG_VERSION} AS golang
FROM node:${NODE_VERSION} AS node

FROM node AS cert-manager-console-plugin-builder
WORKDIR /opt/cert-manager-console-plugin
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json webpack.config.ts plugin-manifest.ts ./
COPY locales locales
COPY src src
RUN npm run build

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

ARG PLUGIN_NAME=cert-manager
COPY go.mod go.mod
COPY api api
COPY main.go main.go
COPY --from=cert-manager-console-plugin-builder /opt/cert-manager-console-plugin/dist dist/
ARG GONOSUMDB=""
ARG GOPROXY=""
ENV CGO_ENABLED=0
RUN go build -ldflags "-s -w" -o bin/${PLUGIN_NAME} ./main.go \
 && chmod 0755 bin/${PLUGIN_NAME} \
 && upx -9 -o/bin/plugin bin/${PLUGIN_NAME}

FROM scratch
COPY --from=golang /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /bin/plugin /bin/cert-manager-plugin
ENV PATH=/bin
USER 1001
ENTRYPOINT ["cert-manager-plugin"]
