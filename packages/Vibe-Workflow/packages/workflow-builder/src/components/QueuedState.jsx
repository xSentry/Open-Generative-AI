import React from "react";

const TONE = {
  blue: {
    ring: "border-blue-400/20",
    dot: "bg-blue-400",
    text: "text-blue-300",
  },
  green: {
    ring: "border-emerald-400/20",
    dot: "bg-emerald-400",
    text: "text-emerald-300",
  },
  orange: {
    ring: "border-orange-400/20",
    dot: "bg-orange-400",
    text: "text-orange-300",
  },
  yellow: {
    ring: "border-yellow-400/20",
    dot: "bg-yellow-400",
    text: "text-yellow-300",
  },
  zinc: {
    ring: "border-zinc-300/15",
    dot: "bg-zinc-300",
    text: "text-zinc-300",
  },
};

export default function QueuedState({ tone = "zinc", label = "Queued", className = "" }) {
  const colors = TONE[tone] || TONE.zinc;

  return (
    <div className={`flex h-full min-h-[140px] w-full items-center justify-center bg-white/[0.025] ${className}`}>
      <div className={`flex flex-col items-center gap-3 rounded-lg px-5 py-4`}>
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${colors.dot} animate-pulse`} />
          <span className={`h-1.5 w-1.5 rounded-full ${colors.dot} animate-pulse [animation-delay:160ms]`} />
          <span className={`h-1.5 w-1.5 rounded-full ${colors.dot} animate-pulse [animation-delay:320ms]`} />
        </div>
        <span className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${colors.text}`}>
          {label}
        </span>
      </div>
    </div>
  );
}
