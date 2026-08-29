import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC } from 'react';
import { Button } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import RFB from '@novnc/novnc/lib/rfb';
import KeyTable from '@novnc/novnc/lib/input/keysym';

import { DEFAULT_SECRET_KEY, vncAuth, vncPort } from './endpoints';
import type { VncAuth } from './endpoints';
import { PORT_FORWARD_SUBPROTOCOL, PortForwardChannel, portForwardURL } from './portforward';
import type { PodConnectTransportProps } from './types';

import './vnc-console.css';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/** The bits of noVNC's RFB this component drives. */
type RfbInstance = {
  scaleViewport: boolean;
  viewOnly: boolean;
  focus: () => void;
  disconnect: () => void;
  sendCtrlAltDel: () => void;
  sendKey: (keysym: number, code: string, down?: boolean) => void;
  sendCredentials: (credentials: { password: string }) => void;
  addEventListener: (type: string, listener: (event: CustomEvent) => void) => void;
};

type SecretResource = { data?: { [key: string]: string } };

/**
 * The plaintext password for a container's VNC server, resolving a `secretRef`
 * through console's own k8s API proxy so ordinary Secret RBAC applies to the
 * logged-in user. Secret values are base64 (RFC 4648), same as everywhere else
 * in the Kubernetes API.
 */
const resolveVncPassword = async (auth: VncAuth, namespace: string): Promise<string> => {
  if ('password' in auth) {
    return auth.password;
  }

  const { name, key = DEFAULT_SECRET_KEY } = auth.secretRef;
  const secret = (await consoleFetchJSON(
    `/api/kubernetes/api/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(name)}`,
  )) as SecretResource;
  const value = secret?.data?.[key];
  if (value === undefined) {
    throw new Error(`Secret "${name}" has no key "${key}"`);
  }
  return atob(value);
};

export const VncPodConsole: FC<PodConnectTransportProps> = ({
  obj,
  containerName,
  subprotocols,
  isFullscreen,
  onError,
  onActionsChange,
}) => {
  const { t } = useTranslation('plugin__vncviewer-console-plugin');
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  // Bumped to force a reconnect; `connect` is otherwise fully derived.
  const [attempt, setAttempt] = useState(0);

  const namespace = obj?.metadata?.namespace;
  const podName = obj?.metadata?.name;
  const port = vncPort(obj, containerName);
  const auth = vncAuth(obj, containerName);

  useEffect(() => {
    if (!screenRef.current || !namespace || !podName || port === undefined) {
      return undefined;
    }

    let cancelled = false;
    setState('connecting');
    onError(null);

    // Impersonation subprotocols must come first: console's k8s proxy forwards
    // the last non-impersonation subprotocol to the API server.
    const socket = new WebSocket(portForwardURL(namespace, podName, port), [
      ...subprotocols,
      PORT_FORWARD_SUBPROTOCOL,
    ]);

    const channel = new PortForwardChannel(socket, {
      onStreamError: (message) => onError(message),
    });

    const rfb: RfbInstance = new RFB(screenRef.current, channel, {});
    rfb.scaleViewport = true;
    rfb.viewOnly = false;
    rfbRef.current = rfb;

    rfb.addEventListener('connect', () => {
      setState('connected');
      onError(null);
      rfb.focus();
    });

    rfb.addEventListener('disconnect', (event: CustomEvent) => {
      setState('disconnected');
      if (!event?.detail?.clean) {
        onError(
          t('Lost the VNC connection to {{container}} on port {{port}}.', {
            container: containerName,
            port,
          }),
        );
      }
    });

    rfb.addEventListener('securityfailure', (event: CustomEvent) => {
      onError(event?.detail?.reason || t('The VNC server rejected the connection.'));
    });

    // The server asked for VNC Authentication - resolve the password (an
    // inline value is immediate, a secretRef is a console API round trip) and
    // hand it back. If nothing was configured, do nothing: the connection then
    // fails on its own and securityfailure/disconnect report it.
    rfb.addEventListener('credentialsrequired', () => {
      if (!auth) {
        return;
      }
      resolveVncPassword(auth, namespace)
        .then((password) => {
          if (!cancelled) {
            rfb.sendCredentials({ password });
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            const message = err instanceof Error ? err.message : String(err);
            onError(t('Could not resolve the VNC password: {{message}}', { message }));
          }
        });
    });

    return () => {
      cancelled = true;
      rfbRef.current = null;
      // Also closes the websocket underneath the channel.
      rfb.disconnect();
    };
    // `t` and `onError` are stable enough; reconnecting on either would drop the
    // session on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, podName, containerName, port, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

  // Offered in the toolbar's "send key" menu (left of Expand) only once actually
  // connected - sendCtrlAltDel/sendKey are themselves no-ops before then, but
  // showing the menu earlier would be misleading.
  const actions = useMemo(
    () =>
      state === 'connected'
        ? [
            {
              id: 'ctrl-alt-del',
              label: t('Ctrl+Alt+Del'),
              onSelect: () => rfbRef.current?.sendCtrlAltDel(),
            },
            {
              id: 'f11',
              label: t('F11'),
              onSelect: () => rfbRef.current?.sendKey(KeyTable.XK_F11, 'F11'),
            },
          ]
        : [],
    [state, t],
  );

  useEffect(() => {
    onActionsChange(actions);
    return () => onActionsChange([]);
  }, [actions, onActionsChange]);

  if (port === undefined) {
    return null;
  }

  return (
    <div className={`vncviewer-console${isFullscreen ? ' vncviewer-console--fullscreen' : ''}`}>
      <div className="vncviewer-console__toolbar">
        <span className="vncviewer-console__status" data-test="vnc-status">
          {state === 'connected'
            ? t('Connected over VNC on port {{port}}', { port })
            : state === 'connecting'
              ? t('Connecting over VNC on port {{port}}...', { port })
              : t('Disconnected')}
        </span>
        {state === 'disconnected' && (
          <Button variant="link" isInline onClick={reconnect} data-test="vnc-reconnect">
            {t('Reconnect')}
          </Button>
        )}
      </div>
      <div className="vncviewer-console__screen" ref={screenRef} data-test="vnc-screen" />
    </div>
  );
};
