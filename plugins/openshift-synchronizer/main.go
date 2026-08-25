package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	"k8s.io/client-go/util/homedir"
)

func main() {
	prometheusURL := flag.String("prometheus-url", os.Getenv("PROMETHEUS_URL"),
		"Base URL of a Prometheus-compatible query API (e.g. http://prometheus.openshift-monitoring.svc:9090), "+
			"used to derive a Node's beta.kubernetes.io/instance-type label from node_dmi_info when the Node "+
			"has no openshift.io/instance-type label of its own. Defaults to $PROMETHEUS_URL. Empty disables the fallback.")
	flag.Parse()

	cfg, err := loadConfig()
	if err != nil {
		log.Fatalf("failed to load kubernetes config: %v", err)
	}

	kubeClient, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("failed to create kubernetes client: %v", err)
	}

	dynamicClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		log.Fatalf("failed to create dynamic client: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	c := NewController(kubeClient, dynamicClient, *prometheusURL)
	if err := c.Run(ctx, 2); err != nil {
		log.Fatalf("controller exited with error: %v", err)
	}
}

// loadConfig returns an in-cluster config when running inside a pod, and
// otherwise falls back to KUBECONFIG / ~/.kube/config for local development.
func loadConfig() (*rest.Config, error) {
	if cfg, err := rest.InClusterConfig(); err == nil {
		return cfg, nil
	}

	kubeconfig := os.Getenv("KUBECONFIG")
	if kubeconfig == "" {
		if home := homedir.HomeDir(); home != "" {
			kubeconfig = filepath.Join(home, ".kube", "config")
		}
	}

	return clientcmd.BuildConfigFromFlags("", kubeconfig)
}
