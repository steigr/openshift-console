# Static glibc build + unit tests + a minimal runtime image containing only
# the resulting single binary. glibc is a deliberate choice (see
# IMPLEMENTATION-PLAN.md §5.2) -- NSS is avoided entirely in the tool's own
# code, so static glibc's getpw*/NSS limitation never comes up, and there's
# no need for musl as a workaround.
#
# Built multi-arch via:
#   docker buildx build --platform=linux/amd64,linux/arm64 --tag=<tag> --push .
#
# fedora is used for the builder stage because it ships a `glibc-static`
# package with the static (.a) libc archives needed for `-static` linking;
# Debian/Ubuntu-family images generally don't carry these by default.
FROM fedora:41 AS builder

RUN dnf install -y --setopt=install_weak_deps=False \
      gcc make glibc-static \
    && dnf clean all

WORKDIR /src
COPY include/ include/
COPY src/ src/
COPY tests/ tests/
COPY Makefile ./

# Unit tests only exercise pure logic (identity file parsing/writing, UID
# allocation, mountinfo parsing) -- no namespaces/mounts/privilege, so they
# run fine unprivileged inside the build. A failing test fails the image
# build. Privileged behavior (setns/mount/kill sweeps) is exercised
# separately by the Lima-based integration tests in tests/lima/, which need
# a real Linux VM and can't run inside `docker build`.
RUN make test

RUN make static \
    && install -Dm755 bin/node-terminal-shim /out/node-terminal-shim

FROM scratch AS final
COPY --from=builder /out/node-terminal-shim /node-terminal-shim
ENTRYPOINT ["/node-terminal-shim"]
