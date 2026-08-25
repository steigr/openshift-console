ARG GOLANG_VERSION=1.26.4

FROM golang:${GOLANG_VERSION} AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY main.go controller.go ./
ARG GONOSUMDB=""
ARG GOPROXY=""
ENV CGO_ENABLED=0
RUN go build -ldflags "-s -w" -o /out/project-synchronizer .

FROM scratch
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /out/project-synchronizer /bin/project-synchronizer
ENV PATH=/bin
USER 1001
ENTRYPOINT ["project-synchronizer"]
