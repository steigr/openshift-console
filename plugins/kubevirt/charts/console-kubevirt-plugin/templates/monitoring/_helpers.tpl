{{/*
Whether the VMRule (operator.victoriametrics.com/v1beta1) CRD is present in this cluster.
*/}}
{{- define "console-kubevirt-plugin.monitoring.vmruleCRDPresent" -}}
{{- .Capabilities.APIVersions.Has "operator.victoriametrics.com/v1beta1/VMRule" -}}
{{- end }}

{{/*
Whether the PrometheusRule (monitoring.coreos.com/v1) CRD is present in this cluster.
*/}}
{{- define "console-kubevirt-plugin.monitoring.prometheusRuleCRDPresent" -}}
{{- .Capabilities.APIVersions.Has "monitoring.coreos.com/v1/PrometheusRule" -}}
{{- end }}

{{/*
Whether to render the VictoriaMetrics flavor (VMRule/VMServiceScrape). autoDetect
prefers VictoriaMetrics over Prometheus when both CRDs happen to be present.
*/}}
{{- define "console-kubevirt-plugin.monitoring.useVictoriaMetrics" -}}
{{- if .Values.monitoring.autoDetect -}}
{{- eq (include "console-kubevirt-plugin.monitoring.vmruleCRDPresent" .) "true" -}}
{{- else -}}
{{- eq (.Values.monitoring.victoriaMetrics | toString) "true" -}}
{{- end -}}
{{- end }}

{{/*
Whether to render the prometheus-operator flavor (PrometheusRule/ServiceMonitor).
*/}}
{{- define "console-kubevirt-plugin.monitoring.usePrometheus" -}}
{{- if .Values.monitoring.autoDetect -}}
{{- if eq (include "console-kubevirt-plugin.monitoring.vmruleCRDPresent" .) "true" -}}
false
{{- else -}}
{{- eq (include "console-kubevirt-plugin.monitoring.prometheusRuleCRDPresent" .) "true" -}}
{{- end -}}
{{- else -}}
{{- eq (.Values.monitoring.prometheus | toString) "true" -}}
{{- end -}}
{{- end }}

{{/*
Fail loudly when autoDetect is on but neither CRD is installed, instead of
silently rendering nothing.
*/}}
{{- define "console-kubevirt-plugin.monitoring.assertDetected" -}}
{{- if .Values.monitoring.autoDetect -}}
{{- if and (ne (include "console-kubevirt-plugin.monitoring.vmruleCRDPresent" .) "true") (ne (include "console-kubevirt-plugin.monitoring.prometheusRuleCRDPresent" .) "true") -}}
{{- fail "console-kubevirt-plugin: monitoring.autoDetect is enabled but neither the VMRule (operator.victoriametrics.com/v1beta1) nor the PrometheusRule (monitoring.coreos.com/v1) CRD is installed in this cluster. Install victoria-metrics-operator or prometheus-operator, or set .Values.monitoring.autoDetect=false and explicitly enable .Values.monitoring.victoriaMetrics or .Values.monitoring.prometheus." -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
The endpoints: body shared by the KubeVirt ServiceMonitor and VMServiceScrape
templates. Both CRDs accept the same endpoint schema. Emits the list body at
column 0 - callers must nindent it themselves.
*/}}
{{- define "console-kubevirt-plugin.monitoring.kubevirtEndpoints" -}}
- port: {{ .Values.monitoring.scrape.portName }}
  scheme: {{ .Values.monitoring.scrape.scheme }}
  honorLabels: true
  tlsConfig:
    insecureSkipVerify: {{ .Values.monitoring.scrape.insecureSkipVerify }}
  bearerTokenFile: /var/run/secrets/kubernetes.io/serviceaccount/token
{{- end }}

{{/*
The recording-rule groups shared by both the VMRule and PrometheusRule templates.
Emits a `groups:` list body at column 0 - callers must nindent it themselves.
*/}}
{{- define "console-kubevirt-plugin.monitoring.groups" -}}
{{- if .Values.monitoring.rules.healthStatus }}
- name: console-kubevirt-plugin.rules
  rules:
    - record: kubevirt_hyperconverged_operator_health_status
      expr: |
        (
          1 - (
            min(kubevirt_virt_operator_ready_status)
            * min(kubevirt_virt_api_ready_status)
            * min(kubevirt_virt_controller_ready_status)
            * min(kubevirt_virt_handler_ready_status)
          )
        ) * 2
{{- end }}
{{- end }}
