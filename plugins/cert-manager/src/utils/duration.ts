export const formatDurationCompact = (ms: number): string => {
  const clamped = ms < 0 ? 0 : ms;
  const totalSeconds = Math.floor(clamped / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
};

// Renders the time between now and a future ISO timestamp as "Nd" / "expired".
export const formatTimeUntil = (isoTimestamp?: string): string => {
  if (!isoTimestamp) {
    return '-';
  }
  const target = new Date(isoTimestamp).getTime();
  if (Number.isNaN(target)) {
    return '-';
  }
  const remainingMs = target - Date.now();
  if (remainingMs <= 0) {
    return 'expired';
  }
  return formatDurationCompact(remainingMs);
};
