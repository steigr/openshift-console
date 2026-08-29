export type NodeKind = {
  metadata: {
    name: string;
    annotations?: Record<string, string>;
  };
  status?: {
    nodeInfo?: {
      operatingSystem?: string;
    };
  };
};

export type PodKind = {
  kind: 'Pod';
  apiVersion: 'v1';
  metadata: {
    name: string;
    namespace: string;
    annotations?: Record<string, string>;
  };
  spec: {
    containers: Array<{
      name: string;
      image?: string;
      command?: string[];
      env?: Array<{ name: string; value?: string }>;
      resources?: Record<string, unknown>;
      securityContext?: Record<string, unknown>;
      stdin?: boolean;
      stdinOnce?: boolean;
      tty?: boolean;
      volumeMounts?: Array<{ name: string; mountPath: string }>;
    }>;
    hostIPC?: boolean;
    hostPID?: boolean;
    hostNetwork?: boolean;
    nodeName?: string;
    restartPolicy?: string;
    volumes?: unknown[];
    OS?: string;
    [key: string]: unknown;
  };
  status?: {
    phase?: string;
    message?: string;
    containerStatuses?: Array<{
      state?: { terminated?: { message?: string } };
    }>;
  };
};
