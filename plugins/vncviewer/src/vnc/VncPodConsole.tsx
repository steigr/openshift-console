import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FC } from 'react';
import { Button } from '@patternfly/react-core';
import { useTranslation } from 'react-i18next';
import RFB from '@novnc/novnc/lib/rfb';

import { vncPort } from './endpoints';
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
  addEventListener: (type: string, listener: (event: CustomEvent) => void) => void;
};

export const VncPodConsole: FC<PodConnectTransportProps> = ({
  obj,
  containerName,
  subprotocols,
  isFullscreen,
  onError,
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

  useEffect(() => {
    if (!screenRef.current || !namespace || !podName || port === undefined) {
      return undefined;
    }

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

    return () => {
      rfbRef.current = null;
      // Also closes the websocket underneath the channel.
      rfb.disconnect();
    };
    // `t` and `onError` are stable enough; reconnecting on either would drop the
    // session on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namespace, podName, containerName, port, attempt]);

  const reconnect = useCallback(() => setAttempt((n) => n + 1), []);

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
        {state === 'connected' ? (
          <Button
            variant="link"
            isInline
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
            data-test="vnc-send-ctrl-alt-del"
          >
            {t('Send Ctrl+Alt+Delete')}
          </Button>
        ) : (
          state === 'disconnected' && (
            <Button variant="link" isInline onClick={reconnect} data-test="vnc-reconnect">
              {t('Reconnect')}
            </Button>
          )
        )}
      </div>
      <div className="vncviewer-console__screen" ref={screenRef} data-test="vnc-screen" />
    </div>
  );
};
