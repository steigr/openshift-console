import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FC, FormEvent } from 'react';
import { Button, TextInput } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import { consoleFetchJSON } from '@openshift-console/dynamic-plugin-sdk';
import RFB from '@novnc/novnc/lib/rfb';
import KeyTable from '@novnc/novnc/lib/input/keysym';

import { DEFAULT_SECRET_KEY, vncEndpointsForContainer } from './endpoints';
import type { VncAuth } from './endpoints';
import { PORT_FORWARD_SUBPROTOCOL, PortForwardChannel, portForwardURL } from './portforward';
import type { PodConnectTransportProps } from './types';

import './vnc-console.css';

type ConnectionState = 'connecting' | 'connected' | 'disconnected';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 64_000;

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
  connectionId,
}) => {
  const { t } = useTranslation('plugin__terminal-console-plugin');
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance>(null);
  const [state, setState] = useState<ConnectionState>('connecting');
  // Bumped to force a reconnect; `connect` is otherwise fully derived.
  const [attempt, setAttempt] = useState(0);
  // Auto-reconnect (with exponential backoff) only kicks in once this
  // session has connected at least once - a server that was never reachable
  // to begin with (bad port, wrong auth, ...) still requires an explicit
  // Reconnect click, same as before. Both refs are reset whenever the
  // connection's identity itself changes (a different pod/container/target),
  // not on every reconnect attempt.
  const hasConnectedRef = useRef(false);
  const backoffMsRef = useRef(INITIAL_BACKOFF_MS);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>();
  // Set when the server asked for a password we don't have (or couldn't
  // resolve); cleared as soon as any credentials are actually sent.
  const [needsManualPassword, setNeedsManualPassword] = useState(false);
  const [manualPassword, setManualPassword] = useState('');

  const namespace = obj?.metadata?.namespace;
  const podName = obj?.metadata?.name;

  // Console's own merged "Connecting to" dropdown drives which endpoint is
  // selected (via `connectionId`, our own port number stringified - see
  // transport.tsx's listVncConnections) once a container has more than one;
  // with only one, or while `connectionId` doesn't match any (e.g. a stale
  // value from a container switch), the first endpoint applies.
  const endpoints = useMemo(() => vncEndpointsForContainer(obj, containerName), [obj, containerName]);
  const endpoint =
    (connectionId && endpoints.find((e) => String(e.port) === connectionId)) || endpoints[0];
  const port = endpoint?.port;
  const auth = endpoint?.auth;

  // A different pod/container/target is a new session - forget that we ever
  // connected and restart the backoff schedule from scratch. Runs before the
  // connect effect below (declaration order) so it sees the reset values.
  useEffect(() => {
    hasConnectedRef.current = false;
    backoffMsRef.current = INITIAL_BACKOFF_MS;
  }, [namespace, podName, port]);

  useEffect(() => {
    if (!screenRef.current || !namespace || !podName || port === undefined) {
      return undefined;
    }

    let cancelled = false;
    // Whether a specific error was already reported for this attempt - the
    // generic "Lost the VNC connection" disconnect message below must not
    // clobber a more specific one (e.g. "Authentication failure") that a
    // securityfailure/credentials event already surfaced for the same
    // underlying failure; noVNC dispatches both.
    let reportedSpecificError = false;
    setState('connecting');
    setNeedsManualPassword(false);
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
      setNeedsManualPassword(false);
      onError(null);
      rfb.focus();
      hasConnectedRef.current = true;
      backoffMsRef.current = INITIAL_BACKOFF_MS;
    });

    rfb.addEventListener('disconnect', (event: CustomEvent) => {
      setState('disconnected');
      if (!event?.detail?.clean && !reportedSpecificError) {
        onError(
          t('Lost the VNC connection to {{container}} on port {{port}}.', {
            container: containerName,
            port,
          }),
        );
      }
      // Only auto-retry a session that has connected before - a server that
      // was never reachable at all (bad port, unsupported auth, ...) still
      // needs an explicit Reconnect click rather than being hammered forever.
      if (hasConnectedRef.current && !cancelled) {
        const delay = backoffMsRef.current;
        backoffMsRef.current = Math.min(backoffMsRef.current * 2, MAX_BACKOFF_MS);
        reconnectTimerRef.current = setTimeout(() => {
          if (!cancelled) {
            setAttempt((n) => n + 1);
          }
        }, delay);
      }
    });

    rfb.addEventListener('securityfailure', (event: CustomEvent) => {
      reportedSpecificError = true;
      onError(event?.detail?.reason || t('The VNC server rejected the connection.'));
    });

    // The server asked for VNC Authentication. If the endpoint configured an
    // auth source, resolve it (an inline password is immediate, a secretRef is
    // a console API round trip) and hand it back; if that fails, or nothing
    // was configured at all, fall back to asking the user for a password
    // directly - either way, the connection cannot proceed without one.
    rfb.addEventListener('credentialsrequired', (event: CustomEvent) => {
      const types: string[] = event?.detail?.types ?? ['password'];
      // Password-only (RFB "VNC Authentication") is the only scheme this
      // component can fulfil - anything asking for more (e.g. ARD/XVP's
      // username+password+target) can't be satisfied by a bare password field.
      if (types.length !== 1 || types[0] !== 'password') {
        reportedSpecificError = true;
        onError(t('This VNC server requires a kind of authentication this plugin does not support.'));
        return;
      }

      if (!auth) {
        setNeedsManualPassword(true);
        return;
      }

      resolveVncPassword(auth, namespace)
        .then((password) => {
          if (!cancelled) {
            rfb.sendCredentials({ password });
          }
        })
        .catch((err: unknown) => {
          if (cancelled) {
            return;
          }
          reportedSpecificError = true;
          const message = err instanceof Error ? err.message : String(err);
          onError(t('Could not resolve the VNC password: {{message}}', { message }));
          setNeedsManualPassword(true);
        });
    });

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = undefined;
      }
      rfbRef.current = null;
      // Also closes the websocket underneath the channel.
      rfb.disconnect();
    };
    // `t`, `onError` and `auth` are stable enough for one connection attempt;
    // reconnecting on any of them would drop the session on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, podName, containerName, port, attempt]);

  const reconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = undefined;
    }
    backoffMsRef.current = INITIAL_BACKOFF_MS;
    setAttempt((n) => n + 1);
  }, []);

  const submitManualPassword = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      rfbRef.current?.sendCredentials({ password: manualPassword });
      setNeedsManualPassword(false);
      setManualPassword('');
    },
    [manualPassword],
  );

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

  if (endpoints.length === 0) {
    return null;
  }

  return (
    <div className={`terminal-vnc-console${isFullscreen ? ' terminal-vnc-console--fullscreen' : ''}`}>
      {/* Once connected the desktop itself is the confirmation - no status line needed,
          and dropping it gives the screen that little bit of extra height. */}
      {state !== 'connected' && (
        <div className="terminal-vnc-console__toolbar">
          <span className="terminal-vnc-console__status" data-test="vnc-status">
            {state === 'connecting'
              ? t('Connecting over VNC on port {{port}}...', { port })
              : hasConnectedRef.current
                ? t('Disconnected. Reconnecting…')
                : t('Disconnected')}
          </span>
          {state === 'disconnected' && (
            <Button variant="link" isInline onClick={reconnect} data-test="vnc-reconnect">
              {t('Reconnect')}
            </Button>
          )}
        </div>
      )}
      {needsManualPassword && (
        <form className="terminal-vnc-console__toolbar" onSubmit={submitManualPassword}>
          <span className="terminal-vnc-console__status">{t('This VNC server requires a password')}</span>
          <TextInput
            type="password"
            value={manualPassword}
            onChange={(_event, value) => setManualPassword(value)}
            aria-label={t('VNC password')}
            data-test="vnc-password-input"
          />
          <Button type="submit" variant="secondary" isInline data-test="vnc-password-submit">
            {t('Connect')}
          </Button>
        </form>
      )}
      <div className="terminal-vnc-console__screen" ref={screenRef} data-test="vnc-screen" />
    </div>
  );
};
