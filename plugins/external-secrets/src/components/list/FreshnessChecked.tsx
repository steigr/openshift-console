import * as React from 'react';
import { formatDurationCompact } from '../../utils/duration';

const FreshnessChecked: React.FC<{ timestamp?: string }> = ({ timestamp }) => {
  const [, forceTick] = React.useState(0);

  React.useEffect(() => {
    if (!timestamp) {
      return undefined;
    }
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [timestamp]);

  if (!timestamp) {
    return <>-</>;
  }

  const elapsedMs = Date.now() - new Date(timestamp).getTime();
  return <>{formatDurationCompact(elapsedMs)} ago</>;
};

export default FreshnessChecked;
