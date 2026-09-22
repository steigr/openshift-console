{{/*
Expand the name of the chart.
*/}}
{{- define "console-filesystem-plugin.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "console-filesystem-plugin.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
The workload name, which drops the "console-" the chart name carries so the
Deployment reads as "filesystem-plugin" rather than "console-filesystem-plugin"
-- matching the sibling plugin charts in this repo.
*/}}
{{- define "console-filesystem-plugin.workload" -}}
{{- include "console-filesystem-plugin.fullname" . | trimPrefix "console-" }}
{{- end }}

{{- define "console-filesystem-plugin.agentName" -}}
{{- printf "%s-agent" (include "console-filesystem-plugin.workload" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "console-filesystem-plugin.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "console-filesystem-plugin.labels" -}}
helm.sh/chart: {{ include "console-filesystem-plugin.chart" . }}
{{ include "console-filesystem-plugin.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "console-filesystem-plugin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "console-filesystem-plugin.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "console-filesystem-plugin.agentSelectorLabels" -}}
app.kubernetes.io/name: filesystem-agent
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "console-filesystem-plugin.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "console-filesystem-plugin.workload" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "console-filesystem-plugin.image" -}}
{{- with .Values.image -}}
{{ .repository }}{{ if .digest }}@{{ .digest }}{{ else }}:{{ .tag | default $.Chart.AppVersion }}{{ end }}
{{- end }}
{{- end }}

{{/*
The shared secret the backend presents to the agent.

The agent is a root-level read/write door into every container on its node and
it listens on the pod network, so it refuses to serve without this. An explicit
agent.token wins; otherwise one is generated -- and, crucially, the *existing*
Secret is looked up first, so `helm upgrade` does not roll a new token into the
Deployment while the DaemonSet still holds the old one (which would take the
whole feature down until both had restarted).
*/}}
{{- define "console-filesystem-plugin.agentToken" -}}
{{- if .Values.agent.token -}}
{{ .Values.agent.token }}
{{- else -}}
{{- $name := printf "%s-agent-token" (include "console-filesystem-plugin.workload" .) -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $name -}}
{{- if and $existing $existing.data (index $existing.data "token") -}}
{{ index $existing.data "token" | b64dec }}
{{- else -}}
{{ randAlphaNum 48 }}
{{- end -}}
{{- end -}}
{{- end }}
