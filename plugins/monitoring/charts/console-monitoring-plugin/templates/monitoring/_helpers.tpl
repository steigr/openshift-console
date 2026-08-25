{{/*
Whether the VMRule (operator.victoriametrics.com/v1beta1) CRD is present in this cluster.
*/}}
{{- define "console-monitoring-plugin.monitoring.vmruleCRDPresent" -}}
{{- .Capabilities.APIVersions.Has "operator.victoriametrics.com/v1beta1/VMRule" -}}
{{- end }}

{{/*
Whether the PrometheusRule (monitoring.coreos.com/v1) CRD is present in this cluster.
*/}}
{{- define "console-monitoring-plugin.monitoring.prometheusRuleCRDPresent" -}}
{{- .Capabilities.APIVersions.Has "monitoring.coreos.com/v1/PrometheusRule" -}}
{{- end }}

{{/*
Whether to render the VictoriaMetrics flavor (VMRule). autoDetect prefers
VictoriaMetrics over Prometheus when both CRDs happen to be present.
*/}}
{{- define "console-monitoring-plugin.monitoring.useVictoriaMetrics" -}}
{{- if .Values.monitoring.autoDetect -}}
{{- eq (include "console-monitoring-plugin.monitoring.vmruleCRDPresent" .) "true" -}}
{{- else -}}
{{- eq (.Values.monitoring.victoriaMetrics | toString) "true" -}}
{{- end -}}
{{- end }}

{{/*
Whether to render the prometheus-operator flavor (PrometheusRule).
*/}}
{{- define "console-monitoring-plugin.monitoring.usePrometheus" -}}
{{- if .Values.monitoring.autoDetect -}}
{{- if eq (include "console-monitoring-plugin.monitoring.vmruleCRDPresent" .) "true" -}}
false
{{- else -}}
{{- eq (include "console-monitoring-plugin.monitoring.prometheusRuleCRDPresent" .) "true" -}}
{{- end -}}
{{- else -}}
{{- eq (.Values.monitoring.prometheus | toString) "true" -}}
{{- end -}}
{{- end }}

{{/*
Fail loudly when autoDetect is on but neither CRD is installed, instead of
silently rendering nothing.
*/}}
{{- define "console-monitoring-plugin.monitoring.assertDetected" -}}
{{- if .Values.monitoring.autoDetect -}}
{{- if and (ne (include "console-monitoring-plugin.monitoring.vmruleCRDPresent" .) "true") (ne (include "console-monitoring-plugin.monitoring.prometheusRuleCRDPresent" .) "true") -}}
{{- fail "console-monitoring-plugin: monitoring.autoDetect is enabled but neither the VMRule (operator.victoriametrics.com/v1beta1) nor the PrometheusRule (monitoring.coreos.com/v1) CRD is installed in this cluster. Install victoria-metrics-operator or prometheus-operator, or set .Values.monitoring.autoDetect=false and explicitly enable .Values.monitoring.victoriaMetrics or .Values.monitoring.prometheus." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The recording-rule groups shared by both the VMRule and PrometheusRule templates.
Emits a `groups:` list body at column 0 - callers must nindent it themselves.
*/}}
{{- define "console-monitoring-plugin.monitoring.groups" -}}
{{- if .Values.monitoring.rules.nodeExporter }}
- name: node-exporter.rules
  rules:
    - record: instance:node_network_receive_bytes_excluding_lo:rate1m
      expr: |
        sum without (device) (
          rate(node_network_receive_bytes_total{job="node-exporter", device!="lo"}[1m])
        )
    - record: instance:node_network_transmit_bytes_excluding_lo:rate1m
      expr: |
        sum without (device) (
          rate(node_network_transmit_bytes_total{job="node-exporter", device!="lo"}[1m])
        )
{{- end }}
{{- if .Values.monitoring.rules.clusterMonitoringOperator }}
{{- $dropLabels := concat (list "condition" "container" "endpoint" "instance" "job" "service") (.Values.monitoring.dropExternalLabels | default (list)) | uniq }}
- name: cluster-monitoring-operator.rules
  rules:
    - record: kube_running_pod_ready
      expr: |
        (
          max without ({{ join "," $dropLabels }}) (
            (
              (kube_pod_status_ready{condition="false"} == 1) * 0
              or
              (kube_pod_status_ready{condition="true"} == 1)
            )
            * on(pod,namespace) group_left() group by (pod,namespace) (
              kube_pod_status_phase{phase=~"Running|Unknown|Pending"} == 1
            )
          )
        )
{{- end }}
{{- end }}
