ARG GOLANG_VERSION=1.26.4

FROM golang:${GOLANG_VERSION} AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
ARG GONOSUMDB=""
ARG GOPROXY=""
ENV CGO_ENABLED=0
RUN go build -ldflags "-s -w" -o /out/openshift-synchronizer .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/openshift-synchronizer /bin/openshift-synchronizer
ENV PATH=/bin
USER 1001
ENTRYPOINT ["openshift-synchronizer"]
