{{/*
Expand the name of the chart.
*/}}
{{- define "openshift-synchronizer.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "openshift-synchronizer.fullname" -}}
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
{{- define "openshift-synchronizer.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "openshift-synchronizer.labels" -}}
helm.sh/chart: {{ include "openshift-synchronizer.chart" . }}
{{ include "openshift-synchronizer.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "openshift-synchronizer.selectorLabels" -}}
app.kubernetes.io/name: {{ include "openshift-synchronizer.name" . }}
app.kubernetes.io/instance: {{ include "openshift-synchronizer.instance" . }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "openshift-synchronizer.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "openshift-synchronizer.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Value of the app.kubernetes.io/instance label, which every selector includes:
the release name unless instanceOverride pins it. An umbrella chart (e.g.
openshift-console-stack) sets it to the release name this chart had when it
was installed on its own, since Deployment/DaemonSet selectors are immutable.
*/}}
{{- define "openshift-synchronizer.instance" -}}
{{- default .Release.Name .Values.instanceOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
