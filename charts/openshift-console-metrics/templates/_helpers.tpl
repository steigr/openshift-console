{{/*
Expand the name of the chart.
*/}}
{{- define "openshift-console-metrics.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openshift-console-metrics.fullname" -}}
{{- $name := include "openshift-console-metrics.name" . }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "openshift-console-metrics.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "openshift-console-metrics.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.Version | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Whether the VMRule (operator.victoriametrics.com/v1beta1) CRD is present in this cluster.
*/}}
{{- define "openshift-console-metrics.vmruleCRDPresent" -}}
{{- .Capabilities.APIVersions.Has "operator.victoriametrics.com/v1beta1/VMRule" -}}
{{- end }}

{{/*
Whether the PrometheusRule (monitoring.coreos.com/v1) CRD is present in this cluster.
*/}}
{{- define "openshift-console-metrics.prometheusRuleCRDPresent" -}}
{{- .Capabilities.APIVersions.Has "monitoring.coreos.com/v1/PrometheusRule" -}}
{{- end }}

{{/*
Whether to render the VMRule. autoDetect prefers VictoriaMetrics over Prometheus
when both CRDs happen to be present.
*/}}
{{- define "openshift-console-metrics.useVictoriaMetrics" -}}
{{- if .Values.autoDetect -}}
{{- eq (include "openshift-console-metrics.vmruleCRDPresent" .) "true" -}}
{{- else -}}
{{- eq (.Values.victoriaMetrics | toString) "true" -}}
{{- end -}}
{{- end }}

{{/*
Whether to render the PrometheusRule.
*/}}
{{- define "openshift-console-metrics.usePrometheus" -}}
{{- if .Values.autoDetect -}}
{{- if eq (include "openshift-console-metrics.vmruleCRDPresent" .) "true" -}}
false
{{- else -}}
{{- eq (include "openshift-console-metrics.prometheusRuleCRDPresent" .) "true" -}}
{{- end -}}
{{- else -}}
{{- eq (.Values.prometheus | toString) "true" -}}
{{- end -}}
{{- end }}

{{/*
Fail loudly when autoDetect is on but neither CRD is installed, instead of
silently rendering nothing.
*/}}
{{- define "openshift-console-metrics.assertDetected" -}}
{{- if .Values.autoDetect -}}
{{- if and (ne (include "openshift-console-metrics.vmruleCRDPresent" .) "true") (ne (include "openshift-console-metrics.prometheusRuleCRDPresent" .) "true") -}}
{{- fail "openshift-console-metrics: autoDetect is enabled but neither the VMRule (operator.victoriametrics.com/v1beta1) nor the PrometheusRule (monitoring.coreos.com/v1) CRD is installed in this cluster. Install victoria-metrics-operator or prometheus-operator, or set .Values.autoDetect=false and explicitly enable .Values.victoriaMetrics or .Values.prometheus." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The recording-rule groups shared by both the VMRule and PrometheusRule templates.
Emits a `groups:` list body at column 0 - callers must nindent it themselves.
*/}}
{{- define "openshift-console-metrics.groups" -}}
{{- if .Values.rules.nodeExporter }}
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
{{- if .Values.rules.clusterMonitoringOperator }}
{{- $dropLabels := concat (list "condition" "container" "endpoint" "instance" "job" "service") (.Values.dropExternalLabels | default (list)) | uniq }}
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

{{/*
The endpoints: body shared by the KubeVirt ServiceMonitor and VMServiceScrape
templates. Both CRDs accept the same endpoint schema. Emits the list body at
column 0 - callers must nindent it themselves.
*/}}
{{- define "openshift-console-metrics.kubevirtEndpoints" -}}
- port: {{ .Values.scrapes.kubevirt.portName }}
  scheme: {{ .Values.scrapes.kubevirt.scheme }}
  honorLabels: true
  tlsConfig:
    insecureSkipVerify: {{ .Values.scrapes.kubevirt.insecureSkipVerify }}
  bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
{{- end }}
