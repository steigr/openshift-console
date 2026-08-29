#!/bin/bash
# Orchestrates the privileged integration tests: builds the static binary
# for the Lima VM's own architecture via Docker (the same Dockerfile used
# for the release image, target=builder), boots/reuses a Lima VM, copies
# the binary + vm-integration-test.sh in, runs it as root, and reports
# pass/fail. Requires: docker (or docker buildx), lima (`limactl`).
#
# Usage:
#   tests/lima/run-integration-tests.sh              # run tests, leave VM up
#   tests/lima/run-integration-tests.sh --stop        # ...then stop the VM
#   tests/lima/run-integration-tests.sh --delete      # ...then delete the VM entirely
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTANCE=node-terminal-test

STOP_AFTER=0
DELETE_AFTER=0
for arg in "$@"; do
    case "$arg" in
        --stop) STOP_AFTER=1 ;;
        --delete) STOP_AFTER=1; DELETE_AFTER=1 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

command -v limactl >/dev/null || { echo "limactl not found -- install lima (e.g. 'brew install lima')" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker not found" >&2; exit 1; }

echo "== determining Lima VM architecture =="
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
    arm64|aarch64) DOCKER_PLATFORM=linux/arm64 ;;
    x86_64|amd64)  DOCKER_PLATFORM=linux/amd64 ;;
    *) echo "unsupported host arch: $HOST_ARCH" >&2; exit 1 ;;
esac
echo "host arch $HOST_ARCH -> building for $DOCKER_PLATFORM (Lima VMs run at host arch by default)"

echo "== building static binary via Docker ($DOCKER_PLATFORM) =="
BUILD_TAG="node-terminal-shim-builder:citest"
docker buildx build --load --platform="$DOCKER_PLATFORM" \
    --file="$PLUGIN_DIR/Dockerfile" --target=builder \
    --tag="$BUILD_TAG" "$PLUGIN_DIR"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
CID="$(docker create --platform="$DOCKER_PLATFORM" "$BUILD_TAG")"
docker cp "$CID:/out/node-terminal-shim" "$WORKDIR/node-terminal-shim"
docker rm "$CID" >/dev/null

echo "== starting Lima VM ($INSTANCE) =="
if ! limactl list --format '{{.Name}}' 2>/dev/null | grep -qx "$INSTANCE"; then
    limactl start --name="$INSTANCE" --tty=false "$SCRIPT_DIR/node-terminal-test.yaml"
elif [ "$(limactl list --format '{{.Status}}' "$INSTANCE")" != "Running" ]; then
    limactl start "$INSTANCE"
fi

echo "== copying binary + test script into the VM =="
limactl shell "$INSTANCE" -- sudo mkdir -p /root/citest
limactl copy "$WORKDIR/node-terminal-shim" "$INSTANCE:/tmp/node-terminal-shim"
limactl copy "$SCRIPT_DIR/vm-integration-test.sh" "$INSTANCE:/tmp/vm-integration-test.sh"
limactl copy "$SCRIPT_DIR/pty_run.py" "$INSTANCE:/tmp/pty_run.py"
limactl shell "$INSTANCE" -- sudo mv /tmp/node-terminal-shim /root/citest/node-terminal-shim
limactl shell "$INSTANCE" -- sudo mv /tmp/vm-integration-test.sh /root/citest/vm-integration-test.sh
limactl shell "$INSTANCE" -- sudo mv /tmp/pty_run.py /root/citest/pty_run.py
limactl shell "$INSTANCE" -- sudo chmod 755 /root/citest/node-terminal-shim /root/citest/vm-integration-test.sh /root/citest/pty_run.py

echo "== running privileged integration tests inside the VM =="
set +e
limactl shell "$INSTANCE" -- sudo bash /root/citest/vm-integration-test.sh
RC=$?
set -e

if [ "$STOP_AFTER" -eq 1 ]; then
    echo "== stopping VM =="
    limactl stop "$INSTANCE" || true
fi
if [ "$DELETE_AFTER" -eq 1 ]; then
    echo "== deleting VM =="
    limactl delete "$INSTANCE" || true
fi

exit $RC
