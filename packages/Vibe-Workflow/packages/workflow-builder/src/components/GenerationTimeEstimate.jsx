import React, { useEffect, useMemo, useState } from "react";

const FADE_MS = 600;

export function getEstimatedSeconds(estimate) {
  const seconds = Number(
    estimate?.total_time ?? estimate?.totalTimeSeconds ?? estimate?.seconds
  );
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function formatEstimatedDuration(seconds) {
  if (seconds == null || seconds === "") return null;
  const rounded = Math.max(0, Math.ceil(Number(seconds)));
  if (!Number.isFinite(rounded)) return null;
  if (rounded > 60) return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
  return `${rounded}s`;
}

function remainingSeconds(totalSeconds, createdAt) {
  const startedAt = Date.parse(createdAt);
  if (!Number.isFinite(startedAt)) return totalSeconds;
  return Math.max(0, Math.ceil(totalSeconds - (Date.now() - startedAt) / 1000));
}

export default function GenerationTimeEstimate({ estimate, createdAt, className = "" }) {
  const totalSeconds = getEstimatedSeconds(estimate);
  const hasStartTime = useMemo(
    () => Number.isFinite(Date.parse(createdAt)),
    [createdAt]
  );
  const [remaining, setRemaining] = useState(() =>
    totalSeconds == null ? null : remainingSeconds(totalSeconds, createdAt)
  );
  const [expired, setExpired] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setExpired(false);
    setHidden(false);
    if (totalSeconds == null) {
      setRemaining(null);
      return undefined;
    }
    if (!hasStartTime) {
      setRemaining(totalSeconds);
      return undefined;
    }

    const update = () => {
      const next = remainingSeconds(totalSeconds, createdAt);
      setRemaining(next);
      if (next === 0) setExpired(true);
    };
    update();
    const interval = setInterval(update, 250);
    return () => clearInterval(interval);
  }, [totalSeconds, createdAt, hasStartTime]);

  useEffect(() => {
    if (!expired) return undefined;
    const timeout = setTimeout(() => setHidden(true), FADE_MS);
    return () => clearTimeout(timeout);
  }, [expired]);

  const duration = formatEstimatedDuration(remaining);
  if (!hasStartTime || !duration || hidden) return null;
  return (
    <span
      className={`whitespace-nowrap text-[10px] font-medium tabular-nums text-white/50 transition-opacity duration-500 ${expired ? "opacity-0" : "opacity-100"} ${className}`}
    >
      {`~${duration} left`}
    </span>
  );
}
