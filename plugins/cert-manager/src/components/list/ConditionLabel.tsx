import * as React from 'react';
import { Label } from '@patternfly/react-core';

import { Condition } from '../../types';

const ConditionLabel: React.FC<{ condition?: Condition; trueText?: string; falseText?: string }> = ({
  condition,
  trueText = 'Ready',
  falseText = 'NotReady',
}) => {
  if (!condition) {
    return <>-</>;
  }
  const isTrue = condition.status === 'True';
  return (
    <Label color={isTrue ? 'green' : 'red'} title={condition.message}>
      {condition.reason || (isTrue ? trueText : falseText)}
    </Label>
  );
};

export default ConditionLabel;
