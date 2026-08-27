import * as React from 'react';
import { Icon, Tooltip } from '@patternfly/react-core';
import { CheckCircleIcon, ExclamationCircleIcon, HourglassHalfIcon, SearchIcon } from '@patternfly/react-icons';

import { Condition } from '../../types';
import { getReadyStatus, ReadyStatusKind } from '../../utils/readyStatus';
import './ReadyStatusIcon.css';

type IconStatus = 'success' | 'warning' | 'danger';

const STATUS_ICON: Record<ReadyStatusKind, { Icon: React.ComponentType; status: IconStatus; muted?: boolean }> = {
  success: { Icon: CheckCircleIcon, status: 'success' },
  'rollback-recent': { Icon: ExclamationCircleIcon, status: 'danger' },
  'failed-nonretryable': { Icon: ExclamationCircleIcon, status: 'danger' },
  'failed-retryable': { Icon: HourglassHalfIcon, status: 'danger', muted: true },
  'artifact-failed-recent': { Icon: SearchIcon, status: 'warning' },
  'artifact-failed-stale': { Icon: SearchIcon, status: 'danger' },
  'dependency-not-ready': { Icon: HourglassHalfIcon, status: 'warning' },
};

type ConditionBearer = {
  spec?: Record<string, unknown>;
  status?: { conditions?: Condition[] };
};

const ReadyStatusIcon: React.FC<{ obj?: ConditionBearer }> = ({ obj }) => {
  const readyStatus = getReadyStatus(obj);
  if (!readyStatus) {
    return <>-</>;
  }

  const { Icon: StatusIcon, status, muted } = STATUS_ICON[readyStatus.kind];

  return (
    <Tooltip content={readyStatus.message || readyStatus.label}>
      <span>
        <Icon status={status} className={muted ? 'flux-icons__muted-danger' : undefined}>
          <StatusIcon />
        </Icon>{' '}
        {readyStatus.label}
      </span>
    </Tooltip>
  );
};

export default ReadyStatusIcon;
