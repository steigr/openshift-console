// Package wire holds the few names both halves of this plugin have to agree
// on: the backend sets these headers, the agent reads them.
package wire

const (
	// HeaderContainerID carries the CRI container ID (as kubelet reports it
	// in a pod's containerStatuses, scheme and all) that the backend resolved
	// the request's Target to.
	//
	// It travels as a header rather than as a proto field so that the service
	// definition stays a description of what a *user* asked for -- a
	// namespace, a pod, a container name. A container ID is the backend's
	// answer to that question, not part of the question, and putting it in
	// the message would make it look like something a browser could send.
	HeaderContainerID = "X-Filesystem-Container-Id"
)
