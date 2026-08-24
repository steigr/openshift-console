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
ARG PLUGIN_NAME=node-logging
COPY go.mod go.sum *.go ./
COPY api api
RUN go mod download
COPY --from=frontend-builder /usr/src/app/dist dist/api/plugins/${PLUGIN_NAME}/
RUN find dist
ENV CGO_ENABLED=0
RUN go build -ldflags "-s -w" -o /bin/plugin .

FROM scratch
COPY --from=builder /bin/plugin /bin/node-logging-plugin
ENV PATH=/bin GLOBAL_API_PATH_PREFIX=/ PLUGIN_NAME=node-logging
USER 1001
ENTRYPOINT ["node-logging-plugin"]
