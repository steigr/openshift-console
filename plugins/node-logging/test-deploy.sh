#!/usr/bin/env bash

set -euo pipefail
IMAGE=steigr/node-logging-plugin
TAG=ts-$(date +%s)
make push TAG=$TAG IMAGE=$IMAGE
helm upgrade --install console-node-logging-plugin charts/console-node-logging-plugin --debug --set=image.repository=$IMAGE --set=image.tag=$TAG --values=charts/console-node-logging-plugin/values-testing.yaml --wait
sleep 10
PLUGIN_INSTANCE_NAME=node-logging-console-plugin
BRIDGE_APP_SELECTOR=app.kubernetes.io/name=rescue-console
BRIDGE_IP=$(kubectl get pods -l $BRIDGE_APP_SELECTOR -o json | jq -r '.items[0].metadata.annotations."k8s.v1.cni.cncf.io/network-status"' | jq -r '.[-1].ips[0]')
BRIDGE_ENDPOINT=http://$BRIDGE_IP:9000
curl -s "$BRIDGE_ENDPOINT/api/plugins/$PLUGIN_INSTANCE_NAME/plugin-manifest.json" | jq
