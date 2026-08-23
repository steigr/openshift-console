ARG ALPINE_VERSION=3.23.4
FROM alpine:${ALPINE_VERSION} AS alpine

FROM alpine AS assets

ARG ALPINE_REMOTE=https://dl-cdn.alpinelinux.org/alpine/
RUN cp /etc/apk/repositories /tmp/repositories \
 && trap 'mv /tmp/repositories /etc/apk/repositories' EXIT \
 && sed -e "s#https://dl-cdn.alpinelinux.org/alpine/#$ALPINE_REMOTE#" -i /etc/apk/repositories \
 && apk upgrade --no-cache

ARG ALPINE_REMOTE=https://dl-cdn.alpinelinux.org/alpine/
RUN cp /etc/apk/repositories /tmp/repositories \
 && trap 'mv /tmp/repositories /etc/apk/repositories' EXIT \
 && sed -e "s#https://dl-cdn.alpinelinux.org/alpine/#$ALPINE_REMOTE#" -i /etc/apk/repositories \
 && apk add --no-cache upx

RUN mkdir -p /data/opt/bridge
RUN tar c /etc/ssl/certs/ca-certificates.crt | tar xvC /data

COPY pkg/graphql/schema.graphql /pkg/graphql/schema.graphql
RUN tar c /pkg                               | tar xvC /data

COPY bin/bridge /opt/bridge/bin/bridge
RUN upx -9 /opt/bridge/bin/bridge \
 && tar cC /opt/bridge bin                   | tar xvC /data

FROM alpine

COPY --from=assets /data /

WORKDIR /
# doesn't require a root user.
USER 1001

ENV \
  BRIDGE_PUBLIC_DIR=/opt/bridge/static \
  PATH=/bin

COPY frontend/public/dist $BRIDGE_PUBLIC_DIR

ENTRYPOINT []
CMD [ "bridge" ]
