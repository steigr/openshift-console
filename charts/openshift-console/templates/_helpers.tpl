{{/*
Expand the name of the chart.
*/}}
{{- define "console.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "console.fullname" -}}
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
Create chart name and version as used by the chart label.
*/}}
{{- define "console.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "console.labels" -}}
helm.sh/chart: {{ include "console.chart" . }}
{{ include "console.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "console.selectorLabels" -}}
app.kubernetes.io/name: {{ include "console.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "console.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "console.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the serving-cert Secret (service-ca-operator managed).
*/}}
{{- define "console.servingCertSecretName" -}}
{{- default (printf "%s-serving-cert" (include "console.fullname" .)) .Values.service.servingCertSecretName }}
{{- end }}

{{/*
Public base address, derived from route.host when not explicitly set.
*/}}
{{- define "console.baseAddress" -}}
{{- if .Values.config.baseAddress }}
{{- .Values.config.baseAddress }}
{{- else if and .Values.route.create .Values.route.host }}
{{- printf "https://%s" .Values.route.host }}
{{- end }}
{{- end }}

{{/*
Sub-path console is served under (--base-path), normalized to start and end
with "/" as bridge requires. bridge serves every route below it, /health and
/auth/callback included.
*/}}
{{- define "console.basePath" -}}
{{- $path := trimAll "/" (default "/" .Values.config.basePath) }}
{{- if $path }}{{ printf "/%s/" $path }}{{ else }}/{{ end }}
{{- end }}

{{/*
A probe from values with its httpGet.path (relative to console's root, e.g.
/health) moved under console.basePath. Takes (dict "probe" <probe> "root" $).
*/}}
{{- define "console.probe" -}}
{{- $probe := deepCopy .probe }}
{{- if and $probe.httpGet $probe.httpGet.path }}
{{- $_ := set $probe.httpGet "path" (printf "%s%s" (include "console.basePath" .root) (trimPrefix "/" $probe.httpGet.path)) }}
{{- end }}
{{- toYaml $probe }}
{{- end }}

{{/*
Name of the OAuthClient secret, generated when oauthClient.existingSecretName is unset.
*/}}
{{- define "console.oauthClientSecretName" -}}
{{- default (printf "%s-oauth-client-secret" (include "console.fullname" .)) .Values.oauthClient.existingSecretName }}
{{- end }}

{{/*
Scheme bridge listens on ("https" or "http"), derived from config.listen so
it doesn't need its own dedicated value. Also used as the container/service
port name. Anything other than an explicit "http://" prefix is treated as
https, matching the chart's TLS-by-default behavior.
*/}}
{{- define "console.listenScheme" -}}
{{- if hasPrefix "http://" .Values.config.listen }}http{{- else }}https{{- end }}
{{- end }}

{{/*
Port bridge listens on, parsed from config.listen's ":<port>" suffix when
present, otherwise falling back to service.port.
*/}}
{{- define "console.listenPort" -}}
{{- $port := regexFind ":[0-9]+$" .Values.config.listen | trimPrefix ":" }}
{{- default (.Values.service.port | toString) $port }}
{{- end }}
