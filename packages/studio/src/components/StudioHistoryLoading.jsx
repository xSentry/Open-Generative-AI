"use client";

import { useEffect, useState } from "react";

export default function StudioHistoryLoading({ label = "Loading your generations" }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 250);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed left-0 top-0 z-40 flex h-[100dvh] w-[100dvw] flex-col items-center justify-center gap-5 px-6 text-center animate-fade-in-up pointer-events-none">
      <div className="relative h-16 w-16">
        <div className="absolute inset-0 rounded-full border border-primary/10 bg-primary/5" />
        <div className="absolute inset-1 rounded-full border-2 border-white/10 border-t-primary animate-spin" />
        <div className="absolute inset-5 rounded-full bg-primary/20 animate-pulse" />
      </div>
      <div className="space-y-2">
        <div className="text-xs font-black uppercase tracking-[0.28em] text-primary">
          {label}
        </div>
        <div className="text-sm font-medium text-white/45">
          Fetching saved results from the database...
        </div>
      </div>
    </div>
  );
}
