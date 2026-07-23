"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DynamicModelInputs, { DynamicModelInputsPanel, createDefaultModelParams } from "../DynamicModelInputs.jsx";
import ModelProviderMark from "../ModelProviderMark.jsx";
import { mergeRemixProjectPatch, subscribeRemixJobs } from "../../remixEvents.js";

const api = async (path, options = {}) => {
  const response = await fetch(`/api/remix${path}`, {
    cache: "no-store",
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || data.error || "Remix request failed.");
  return data;
};

const uniqueKey = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;

function formatTime(seconds = 0) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const remainder = value - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function uploadWithProgress(path, form, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/remix${path}`);
    request.setRequestHeader("idempotency-key", uniqueKey());
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let data = {};
      try { data = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300) resolve(data);
      else reject(new Error(data.error?.message || "Upload failed."));
    };
    request.onerror = () => reject(new Error("Upload failed."));
    request.send(form);
  });
}

function TrashIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" />
    </svg>
  );
}

function ImageIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  );
}

function ErrorBanner({ error, onClose }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex shrink-0 items-center justify-between gap-4 border-b border-red-400/20 bg-red-500/10 px-4 py-2.5 text-xs text-red-100">
      <span>{error}</span>
      <button type="button" onClick={onClose} aria-label="Dismiss error" className="text-base text-red-200/60 hover:text-white">×</button>
    </div>
  );
}

function ProjectOverview({ projects, onSelectProject, onDeleteProject, onFile, uploadProgress, busy, deletingIds }) {
  const inputRef = useRef(null);
  return (
    <div className="h-full overflow-y-auto bg-[#050506] px-5 py-8 sm:px-8">
      <section
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          if (event.dataTransfer.files?.[0]) onFile(event.dataTransfer.files[0]);
        }}
        className="mx-auto flex min-h-[52vh] max-w-5xl flex-col items-center justify-center rounded-[2rem] border border-dashed border-white/15 bg-[radial-gradient(circle_at_50%_10%,rgba(255,255,255,0.07),transparent_45%)] px-6 text-center"
      >
        <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.06] text-[var(--primary-color)]">
          <svg width="27" height="27" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m14 2 6 6-10 10-6 1 1-6L15 3" /><path d="m13 5 6 6" /></svg>
        </div>
        <p className="text-[10px] font-bold uppercase tracking-[0.26em] text-[var(--primary-color)]">Remix Studio</p>
        <h1 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl">Edit a video from the exact frame you choose.</h1>
        <p className="mt-4 max-w-xl text-sm leading-6 text-white/40">Upload a clip, select a frame, create an edited keyframe, then carry that change through the video.</p>
        <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/webm" className="hidden" onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])} />
        <button type="button" disabled={busy} onClick={() => inputRef.current?.click()} className="mt-7 rounded-xl bg-[var(--primary-color)] px-6 py-3 text-sm font-bold text-black transition hover:brightness-110 disabled:opacity-50">
          {busy ? `Uploading ${uploadProgress}%` : "Upload video"}
        </button>
        <p className="mt-3 text-[11px] text-white/25">MP4, MOV, or WebM · up to 250 MB</p>
        {busy && <div className="mt-4 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/10"><div className="h-full bg-[var(--primary-color)] transition-all" style={{ width: `${uploadProgress}%` }} /></div>}
      </section>

      {projects.length > 0 && (
        <section className="mx-auto mt-10 max-w-5xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.18em] text-white/35">Your projects</h2>
            <span className="text-xs text-white/20">{projects.length}</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((project) => {
              const deleting = deletingIds.has(project.id);
              return (
                <article key={project.id} className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0d0d0f] transition hover:-translate-y-0.5 hover:border-white/20">
                  <button type="button" disabled={deleting} onClick={() => onSelectProject(project.id)} className="block w-full text-left disabled:opacity-40">
                    <div className="aspect-video overflow-hidden bg-black/60">
                      {project.previewUrl
                        ? <video src={project.previewUrl} muted preload="metadata" className="h-full w-full object-cover opacity-75 transition duration-300 group-hover:scale-[1.02] group-hover:opacity-100" />
                        : <div className="flex h-full items-center justify-center text-xs text-white/20">{project.status === "failed" ? "Preparation failed" : "Preparing video"}</div>}
                    </div>
                    <div className="p-4 pr-14">
                      <p className="truncate text-sm font-semibold text-white/85">{project.name}</p>
                      <p className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-white/25">{project.status}</p>
                    </div>
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete project ${project.name}`}
                    title="Delete project"
                    disabled={deleting}
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteProject(project.id);
                    }}
                    className="absolute right-3 top-3 flex h-9 items-center gap-2 rounded-lg border border-red-300/20 bg-black/80 px-2.5 text-[10px] font-semibold text-red-200 opacity-100 shadow-lg transition hover:bg-red-500/20 disabled:opacity-50 sm:pointer-events-none sm:translate-y-1 sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:translate-y-0 sm:group-hover:opacity-100"
                  >
                    <TrashIcon size={14} />
                    <span>Delete</span>
                  </button>
                </article>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function VideoFramePreview({ src, time, fallback, className = "" }) {
  const videoRef = useRef(null);
  const [ready, setReady] = useState(false);

  const seekPreview = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 1) return;
    setReady(false);
    video.currentTime = Math.max(0, Math.min(Number(time) || 0, Math.max(0, video.duration - 0.01)));
  }, [time]);

  useEffect(() => {
    seekPreview();
  }, [seekPreview]);

  if (!src) return fallback ? <img src={fallback} alt="" className={className} /> : <div className={`bg-white/[0.04] ${className}`} />;
  return (
    <div className={`relative overflow-hidden bg-black ${className}`}>
      {fallback && <img src={fallback} alt="" className={`absolute inset-0 h-full w-full object-cover transition-opacity ${ready ? "opacity-0" : "opacity-60"}`} />}
      <video
        ref={videoRef}
        src={src}
        muted
        playsInline
        preload="auto"
        aria-hidden="true"
        onLoadedMetadata={seekPreview}
        onSeeked={() => setReady(true)}
        className={`h-full w-full object-cover transition-opacity ${ready ? "opacity-100" : "opacity-0"}`}
      />
    </div>
  );
}

function useTimelineFrames(videoUrl, duration, count) {
  const [frames, setFrames] = useState([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const objectUrls = [];
    setFrames([]);
    setFailed(false);
    if (!videoUrl || !duration || !count) return undefined;

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    const waitFor = (eventName) => new Promise((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener(eventName, resolveEvent);
        video.removeEventListener("error", rejectEvent);
      };
      const resolveEvent = () => { cleanup(); resolve(); };
      const rejectEvent = () => { cleanup(); reject(new Error("Video frame could not be loaded.")); };
      video.addEventListener(eventName, resolveEvent, { once: true });
      video.addEventListener("error", rejectEvent, { once: true });
    });

    const extract = async () => {
      video.src = videoUrl;
      video.load();
      if (video.readyState < 1) await waitFor("loadedmetadata");
      const canvas = document.createElement("canvas");
      const sourceWidth = video.videoWidth || 160;
      const sourceHeight = video.videoHeight || 90;
      canvas.width = 240;
      canvas.height = Math.max(90, Math.round(240 * (sourceHeight / sourceWidth)));
      const context = canvas.getContext("2d", { alpha: false });
      const nextFrames = [];

      for (let index = 0; index < count && !cancelled; index += 1) {
        const time = Math.min((duration * index) / Math.max(1, count - 1), Math.max(0, duration - 0.01));
        if (Math.abs(video.currentTime - time) > 0.001) {
          video.currentTime = time;
          await waitFor("seeked");
        } else if (video.readyState < 2) {
          await waitFor("loadeddata");
        }
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.72));
        if (!blob) throw new Error("Video frame could not be captured.");
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        nextFrames.push({ time, url });
        if (!cancelled) setFrames([...nextFrames]);
      }
    };

    extract().catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
      video.removeAttribute("src");
      video.load();
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [videoUrl, duration, count]);

  return { frames, failed };
}

function FrameTimeline({ videoUrl, fallback, duration, fps, selectedTime, onSeek, onCommit }) {
  const playhead = duration ? Math.min(100, Math.max(0, (selectedTime / duration) * 100)) : 0;
  const count = 10;
  const { frames, failed } = useTimelineFrames(videoUrl, duration, count);
  return (
    <section className="border-t border-white/[0.06] bg-[#080809] px-4 py-2.5 sm:px-6">
      <div className="mx-auto max-w-[1100px]">
        <div className="mb-2 flex items-center justify-between text-[10px] font-medium text-white/35">
          <span className="tabular-nums text-white/60">{formatTime(selectedTime)}</span>
          <span>Frame selector · {fps.toFixed(2)} fps · {formatTime(duration)}</span>
        </div>
        <div className="relative h-14 overflow-hidden rounded-lg border border-white/10 bg-black">
          <div className="grid h-full" style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>
            {Array.from({ length: count }, (_, index) => {
              const time = (duration * index) / Math.max(1, count - 1);
              const frame = frames[index];
              return (
                <button key={index} type="button" onClick={() => { onSeek(time); onCommit(time); }} aria-label={`Seek to ${formatTime(time)}`} className="min-w-0 overflow-hidden border-r border-black/70 last:border-0">
                  {frame ? (
                    <img src={frame.url} alt="" draggable="false" className="h-full w-full object-cover opacity-80 transition hover:opacity-100" />
                  ) : fallback ? (
                    <img src={fallback} alt="" draggable="false" className="h-full w-full object-cover opacity-30" />
                  ) : (
                    <span className="block h-full w-full animate-pulse bg-white/[0.04]" />
                  )}
                </button>
              );
            })}
          </div>
          {failed && <span className="pointer-events-none absolute bottom-1 right-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[8px] text-white/40">Preview unavailable</span>}
          <div className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-[var(--primary-color)] shadow-[0_0_10px_var(--primary-color)]" style={{ left: `${playhead}%` }}>
            <span className="absolute -left-1.5 -top-0.5 h-2.5 w-3 rounded-sm bg-[var(--primary-color)]" />
          </div>
          <input
            aria-label="Precise video frame selector"
            type="range"
            min="0"
            max={duration || 0}
            step={1 / fps}
            value={selectedTime}
            onChange={(event) => onSeek(event.target.value)}
            onPointerUp={(event) => onCommit(event.currentTarget.value)}
            onKeyUp={(event) => onCommit(event.currentTarget.value)}
            className="absolute inset-0 z-20 h-full w-full cursor-ew-resize opacity-0"
          />
        </div>
      </div>
    </section>
  );
}

function RemixModelSelector({ models, value, onChange, label = "Model", placement = "above" }) {
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [menuStyle, setMenuStyle] = useState(null);
  const selected = models.find((model) => (model.id || model.key) === value) || models[0];
  const filtered = models.filter((model) => {
    const query = search.trim().toLowerCase();
    return !query || `${model.name || model.label || ""} ${model.id || model.key || ""}`.toLowerCase().includes(query);
  });

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);

  const positionMenu = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportMargin = 8;
    const menuGap = 8;
    const width = Math.max(0, Math.min(320, window.innerWidth - (viewportMargin * 2)));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const availableHeight = placement === "below"
      ? window.innerHeight - rect.bottom - menuGap - viewportMargin
      : rect.top - menuGap - viewportMargin;
    const maxHeight = Math.max(0, Math.min(352, availableHeight));
    setMenuStyle(placement === "below"
      ? { bottom: "auto", left, top: rect.bottom + menuGap, width, maxHeight }
      : { bottom: window.innerHeight - rect.top + menuGap, left, top: "auto", width, maxHeight });
  }, [placement]);

  useEffect(() => {
    if (!open) return undefined;
    positionMenu();
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open, positionMenu]);

  useEffect(() => {
    if (!open || !menuStyle) return undefined;
    const menu = menuRef.current;
    if (!menu?.showPopover) return undefined;
    try {
      if (!menu.matches(":popover-open")) menu.showPopover();
    } catch {}
    return () => {
      try {
        if (menu.matches(":popover-open")) menu.hidePopover();
      } catch {}
    };
  }, [open, menuStyle]);

  if (!selected) return null;
  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!open) positionMenu();
          setOpen((current) => !current);
        }}
        className="flex h-8 max-w-[230px] items-center gap-2 rounded-md border border-white/[0.12] px-2 text-left shadow-md transition hover:brightness-110"
        style={{ backgroundColor: "#18181b", colorScheme: "dark" }}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/[0.06] bg-white/[0.04] text-[10px] text-white/65">
          <ModelProviderMark model={selected} glyphClassName="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-white/70">{selected.name || selected.label || selected.id || selected.key}</span>
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className={`shrink-0 text-white/30 transition ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && menuStyle && (
        <div
          ref={menuRef}
          popover="manual"
          className="fixed flex flex-col rounded-2xl border border-white/[0.12] p-2 shadow-[0_24px_80px_rgba(0,0,0,0.9)]"
          style={{
            ...menuStyle,
            position: "fixed",
            zIndex: 2147483647,
            margin: 0,
            right: "auto",
            overflow: "hidden",
            background: "#0a0a0c",
            backgroundColor: "#0a0a0c",
            colorScheme: "dark",
          }}
        >
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.04] px-3 py-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-white/30"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search models…" className="min-w-0 flex-1 bg-transparent text-xs text-white outline-none placeholder:text-white/20" />
          </div>
          <div role="listbox" className="custom-scrollbar min-h-0 flex-1 space-y-1 overflow-y-auto">
            {filtered.map((model) => {
              const id = model.id || model.key;
              const active = id === (selected.id || selected.key);
              return (
                <button key={`${model.mode || "model"}:${id}`} type="button" role="option" aria-selected={active} onClick={() => { onChange(id); setOpen(false); setSearch(""); }} className={`flex w-full items-center gap-3 rounded-xl border p-2.5 text-left transition ${active ? "border-white/[0.08] bg-white/[0.06]" : "border-transparent hover:border-white/[0.05] hover:bg-white/[0.04]"}`}>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/[0.06] bg-[var(--primary-color)]/10 text-xs text-[var(--primary-color)]"><ModelProviderMark model={model} glyphClassName="h-4 w-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-semibold text-white/85">{model.name || model.label || id}</span><span className="block truncate text-[9px] text-white/30">{model.provider || "replicate"} · {model.mode || "image edit"}</span></span>
                  {active && <span className="text-sm text-[var(--primary-color)]">✓</span>}
                </button>
              );
            })}
            {!filtered.length && <p className="px-3 py-6 text-center text-[11px] text-white/30">No matching models</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function catalogImageFields(model) {
  return Object.entries(model?.inputs || {})
    .filter(([, schema]) => schema?.mediaKind === "image" || schema?.field === "image" || schema?.field === "images_list")
    .map(([name, schema]) => ({
      name,
      schema,
      title: schema.title || name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      limit: schema.type === "array" ? Math.max(1, Number(schema.maxItems || 5)) : 1,
      required: (model.required || []).includes(name),
    }));
}

function reconcileImageAssignments(fields, previous, selectedFrame, references) {
  const next = Object.fromEntries(fields.map((field) => [field.name, []]));
  const validTokens = new Set([
    ...(selectedFrame ? ["frame"] : []),
    ...references.map((asset) => `reference:${asset.id}`),
  ]);
  const used = new Set();
  for (const field of fields) {
    for (const token of previous?.[field.name] || []) {
      if (!validTokens.has(token) || used.has(token) || next[field.name].length >= field.limit) continue;
      next[field.name].push(token);
      used.add(token);
    }
  }
  if (selectedFrame && !used.has("frame") && fields[0]) {
    if (next[fields[0].name].length >= fields[0].limit) {
      const displaced = next[fields[0].name].pop();
      if (displaced) used.delete(displaced);
    }
    next[fields[0].name].unshift("frame");
    used.add("frame");
  }
  const pending = references
    .map((asset) => `reference:${asset.id}`)
    .filter((token) => !used.has(token));
  for (const token of pending) {
    const target = fields.find((field) => next[field.name].length < field.limit);
    if (!target) break;
    next[target.name].push(token);
    used.add(token);
  }
  return next;
}

function RemixInputOptions({
  model, values, onChange, selectedFrame, references, assignments, onMove, onRemoveReference,
}) {
  const [open, setOpen] = useState(false);
  const imageFields = catalogImageFields(model);
  const excluded = [model?.promptField, ...imageFields.map((field) => field.name)].filter(Boolean);
  const assetFor = (token) => token === "frame"
    ? selectedFrame
    : references.find((asset) => token === `reference:${asset.id}`);
  const assignedCount = Object.values(assignments || {}).flat().length;
  const frameField = imageFields.find((field) => (assignments[field.name] || []).includes("frame"));

  if (!model) return null;
  return (
    <div className="relative w-full rounded-xl border border-white/[0.1]" style={{ backgroundColor: "#0b0b0e" }}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-white/[0.04]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/45"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></svg>
        <span className="text-[11px] font-semibold text-white/80">Input options</span>
        <span className="text-[10px] text-white/30">{imageFields.length} image {imageFields.length === 1 ? "input" : "inputs"}</span>
        {selectedFrame?.url && (
          <span className="ml-1 flex min-w-0 items-center gap-1.5 rounded-md border border-white/10 bg-black/40 py-0.5 pl-0.5 pr-2">
            <img src={selectedFrame.url} alt="" className="h-6 w-8 shrink-0 rounded object-cover" />
            <span className="max-w-28 truncate text-[9px] font-medium text-white/55">{frameField?.title || "Assigning frame…"}</span>
          </span>
        )}
        {assignedCount > 0 && <span className="text-[9px] tabular-nums text-white/25">{assignedCount} assigned</span>}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className={`ml-auto text-white/35 transition ${open ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <section className="absolute inset-x-0 bottom-[calc(100%+8px)] z-[80] flex max-h-[50dvh] flex-col overflow-hidden rounded-xl border border-white/[0.12] shadow-[0_24px_80px_rgba(0,0,0,0.9)]" style={{ maxHeight: "50dvh", backgroundColor: "#0b0b0e" }}>
          <div className="flex items-center justify-between border-b border-white/[0.08] px-3.5 py-2.5">
            <div>
              <p className="text-[11px] font-semibold text-white/75">{model.name || model.id}</p>
              <p className="mt-0.5 text-[9px] text-white/30">Drag images between the catalog inputs below.</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="rounded-md px-2 py-1 text-xs text-white/40 hover:bg-white/5 hover:text-white">Close</button>
          </div>
          <div className="custom-scrollbar min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {imageFields.map((field, fieldIndex) => {
                const tokens = assignments[field.name] || [];
                return (
                  <div
                    key={field.name}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const token = event.dataTransfer.getData("application/x-remix-image") || event.dataTransfer.getData("text/plain");
                      if (token) onMove(token, field.name);
                    }}
                    className="min-w-0 rounded-xl border border-dashed border-white/[0.13] p-2.5"
                    style={{ backgroundColor: "#111114" }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-semibold text-white/75">{field.title}{field.required && <span className="ml-1 text-[var(--primary-color)]">*</span>}</p>
                        {field.schema.description && <p className="mt-0.5 line-clamp-2 text-[9px] leading-3 text-white/30">{field.schema.description}</p>}
                      </div>
                      <span className="shrink-0 text-[9px] tabular-nums text-white/25">{tokens.length}/{field.limit}</span>
                    </div>
                    <div className="mt-2 flex min-h-16 flex-wrap gap-2">
                      {tokens.map((token) => {
                        const asset = assetFor(token);
                        if (!asset?.url) return null;
                        const isFrame = token === "frame";
                        return (
                          <div
                            key={token}
                            draggable
                            onDragStart={(event) => {
                              event.dataTransfer.effectAllowed = "move";
                              event.dataTransfer.setData("application/x-remix-image", token);
                              event.dataTransfer.setData("text/plain", token);
                            }}
                            className="group relative h-16 w-20 cursor-grab overflow-hidden rounded-lg border border-white/15 bg-black active:cursor-grabbing"
                          >
                            <img src={asset.url} alt={isFrame ? "Selected frame" : "Reference image"} draggable="false" className="h-full w-full object-cover" />
                            <span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/80 px-1 py-0.5 text-center text-[8px] font-semibold text-white/80">{isFrame ? "Selected frame" : "Reference"}</span>
                            {imageFields.length > 1 && (
                              <button
                                type="button"
                                aria-label={`Move ${isFrame ? "selected frame" : "reference image"} to next image input`}
                                title={`Move to ${imageFields[(fieldIndex + 1) % imageFields.length].title}`}
                                onClick={() => onMove(token, imageFields[(fieldIndex + 1) % imageFields.length].name)}
                                className="absolute left-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/85 text-[10px] text-white hover:bg-[var(--primary-color)] hover:text-black group-hover:flex"
                              >
                                →
                              </button>
                            )}
                            {!isFrame && (
                              <button type="button" aria-label="Remove reference image" onClick={() => onRemoveReference(asset.id)} className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/85 text-xs text-white hover:bg-red-500 group-hover:flex">×</button>
                            )}
                          </div>
                        );
                      })}
                      {tokens.length < field.limit && (
                        <div className="flex h-16 min-w-20 flex-1 items-center justify-center rounded-lg border border-dashed border-white/10 px-2 text-center text-[8px] leading-3 text-white/20">
                          {fieldIndex === 0 && !selectedFrame ? "Add the selected frame" : "Drop image here"}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <DynamicModelInputs model={model} values={values} onChange={onChange} exclude={excluded} />
          </div>
        </section>
      )}
    </div>
  );
}

function SourceFrameChip({ selectedFrame, videoUrl, fallback, selectedTime, committing, onAttach }) {
  return (
    <div className={`relative h-14 w-20 shrink-0 overflow-hidden rounded-lg border ${selectedFrame ? "border-[var(--primary-color)]/70" : "border-white/10"} bg-black`}>
      {selectedFrame?.url
        ? <img src={selectedFrame.url} alt="Current video frame" className="h-full w-full object-cover" />
        : <VideoFramePreview src={videoUrl} time={selectedTime} fallback={fallback} className="h-full w-full" />}
      <button type="button" disabled={committing || Boolean(selectedFrame)} onClick={onAttach} className="absolute inset-x-1 bottom-1 rounded bg-black/85 px-1 py-0.5 text-[8px] font-bold text-white/85 hover:bg-black disabled:cursor-default">
        {committing ? "Adding…" : selectedFrame ? `Frame ${formatTime(selectedTime)}` : "+ Add frame"}
      </button>
    </div>
  );
}

function CenterComposer({
  mode, setMode, selectedFrame, videoUrl, videoFallback, selectedTime, committing, onAttachFrame,
  framePrompt, setFramePrompt, videoPrompt, setVideoPrompt, imageModel, imageModels,
  onModelChange, imageParams, setImageParams, references, setReferences, onAddReference,
  imageAssignments, onMoveImage, referenceInput, submittingFrame, onEditFrame, selectedEdit,
  scope, setScope, duration, fps, sectionEndTime, setSectionEndTime,
  videoModels, videoModelKey, setVideoModelKey,
  videoOptionsModel, videoParams, setVideoParams, submittingVideo, hasCredential, onGenerateVideo,
}) {
  const editingFrame = mode === "frame";
  const videoStartTime = Number(selectedEdit?.actual_timestamp_seconds ?? selectedTime);
  return (
    <section className="relative z-30 min-h-0 overflow-visible border-t border-white/[0.06] bg-[#060607] px-3 py-3 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center justify-center">
          <div className="flex rounded-lg bg-white/[0.04] p-0.5 text-[10px] font-semibold">
            <button type="button" onClick={() => setMode("frame")} className={`rounded-md px-3 py-1.5 ${editingFrame ? "bg-white/10 text-white" : "text-white/35 hover:text-white/70"}`}>Edit frame</button>
            <button type="button" onClick={() => setMode("video")} className={`rounded-md px-3 py-1.5 ${!editingFrame ? "bg-white/10 text-white" : "text-white/35 hover:text-white/70"}`}>Generate video</button>
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-[#101012]/95 p-3 shadow-[0_18px_70px_rgba(0,0,0,0.5)] backdrop-blur-2xl">
          {editingFrame && (
            <div className="relative z-20 mb-2">
              <RemixInputOptions
                model={imageModel}
                values={imageParams}
                onChange={setImageParams}
                selectedFrame={selectedFrame}
                references={references}
                assignments={imageAssignments}
                onMove={onMoveImage}
                onRemoveReference={(id) => setReferences((items) => items.filter((item) => item.id !== id))}
              />
            </div>
          )}
          {!editingFrame && selectedEdit && (
            <div className="relative z-20 mb-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(190px,0.8fr)]">
              <div>
                <div className="grid grid-cols-3 gap-1.5">
                  <label className={`rounded-lg border px-2 py-2 text-[10px] ${scope === "whole" ? "border-[var(--primary-color)]/50 bg-[var(--primary-color)]/[0.08] text-white" : "border-white/10 text-white/40"}`}>
                    <input type="radio" className="mr-1 accent-[var(--primary-color)]" checked={scope === "whole"} onChange={() => setScope("whole")} />
                    Entire video
                  </label>
                  <label className={`rounded-lg border px-2 py-2 text-[10px] ${scope === "from-frame" ? "border-[var(--primary-color)]/50 bg-[var(--primary-color)]/[0.08] text-white" : "border-white/10 text-white/40"}`}>
                    <input type="radio" className="mr-1 accent-[var(--primary-color)]" checked={scope === "from-frame"} onChange={() => setScope("from-frame")} />
                    Frame to end
                  </label>
                  <label className={`rounded-lg border px-2 py-2 text-[10px] ${scope === "range" ? "border-[var(--primary-color)]/50 bg-[var(--primary-color)]/[0.08] text-white" : "border-white/10 text-white/40"}`}>
                    <input type="radio" className="mr-1 accent-[var(--primary-color)]" checked={scope === "range"} onChange={() => setScope("range")} />
                    Section
                  </label>
                </div>
                {scope === "range" && (
                  <div className="mt-2 rounded-lg border border-white/[0.08] bg-black/25 px-2.5 py-2">
                    <div className="mb-1.5 flex items-center justify-between text-[9px] font-medium text-white/40">
                      <span>Selected section</span>
                      <span className="tabular-nums text-white/65">
                        {formatTime(videoStartTime)}–{formatTime(sectionEndTime)}
                      </span>
                    </div>
                    <input
                      type="range"
                      aria-label="Selected section end"
                      min={Math.min(duration, videoStartTime + 2)}
                      max={duration}
                      step={1 / fps}
                      value={sectionEndTime}
                      onChange={(event) => setSectionEndTime(Number(event.target.value))}
                      className="h-1.5 w-full cursor-ew-resize accent-[var(--primary-color)]"
                    />
                  </div>
                )}
              </div>
              <DynamicModelInputsPanel model={videoOptionsModel} values={videoParams} onChange={setVideoParams} title="Video options" placement="above" />
            </div>
          )}
          <div className="flex items-start gap-3">
            {editingFrame ? (
              <SourceFrameChip selectedFrame={selectedFrame} videoUrl={videoUrl} fallback={videoFallback} selectedTime={selectedTime} committing={committing} onAttach={onAttachFrame} />
            ) : (
              <div className={`relative h-14 w-20 shrink-0 overflow-hidden rounded-lg border ${selectedEdit ? "border-[var(--primary-color)]/70" : "border-dashed border-white/15"} bg-black`}>
                {selectedEdit?.outputUrl ? <img src={selectedEdit.outputUrl} alt="Selected edited frame" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center px-2 text-center text-[8px] leading-3 text-white/25">Choose an edited frame on the right</div>}
              </div>
            )}
            <textarea
              value={editingFrame ? framePrompt : videoPrompt}
              onChange={(event) => editingFrame ? setFramePrompt(event.target.value) : setVideoPrompt(event.target.value)}
              placeholder={editingFrame ? "Describe the change you want to make to this frame…" : "Describe how the edited frame should move through the video…"}
              rows={2}
              className="min-h-14 flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-5 text-white outline-none placeholder:text-white/20"
            />
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] pt-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {editingFrame && (
                <>
                  <RemixModelSelector models={imageModels} value={imageModel?.id || ""} onChange={onModelChange} label="Image edit model" />
                  <button type="button" disabled={!imageModel || references.length >= Math.max(0, catalogImageFields(imageModel).reduce((total, field) => total + field.limit, 0) - 1)} onClick={() => referenceInput.current?.click()} className="flex h-8 items-center gap-1.5 rounded-md border border-white/[0.06] bg-white/[0.04] px-2.5 text-[10px] font-semibold text-white/55 hover:text-white disabled:opacity-30">
                    <ImageIcon size={14} /> Add image
                  </button>
                  <input ref={referenceInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => event.target.files?.[0] && onAddReference(event.target.files[0])} />
                </>
              )}
              {!editingFrame && (
                <RemixModelSelector models={videoModels} value={videoModelKey} onChange={setVideoModelKey} label="Video generation model" />
              )}
            </div>
            {editingFrame ? (
              <button type="button" disabled={!selectedFrame || !framePrompt.trim() || submittingFrame} onClick={onEditFrame} className="h-8 rounded-md bg-[var(--primary-color)] px-4 text-xs font-bold text-black transition hover:brightness-110 disabled:opacity-30">
                {submittingFrame ? "Starting…" : "Edit frame"}
              </button>
            ) : (
              <button
                type="button"
                disabled={!selectedEdit || selectedEdit.status !== "succeeded" || !videoPrompt.trim() || submittingVideo || !hasCredential}
                onClick={onGenerateVideo}
                className="h-8 rounded-md bg-[var(--primary-color)] px-4 text-xs font-bold text-black transition hover:brightness-110 disabled:opacity-30"
              >
                {submittingVideo ? "Starting…" : hasCredential ? "Generate video" : "Add Replicate token"}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function FrameGenerationCard({ edit, selected, onSelect, onDelete }) {
  return (
    <article className={`group overflow-hidden rounded-xl border ${selected ? "border-[var(--primary-color)]/70 bg-[var(--primary-color)]/[0.07]" : "border-white/[0.07] bg-white/[0.025]"}`}>
      <button type="button" disabled={edit.status !== "succeeded"} onClick={onSelect} className="block w-full text-left disabled:cursor-wait">
        <div className="relative aspect-video bg-black">
          {edit.outputUrl ? <img src={edit.outputUrl} alt="Generated edited frame" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs capitalize text-white/30">{edit.status}</div>}
          <span className="absolute bottom-2 left-2 rounded bg-black/75 px-1.5 py-1 text-[9px] tabular-nums text-white/65">{formatTime(edit.actual_timestamp_seconds)}</span>
          {selected && <span className="absolute right-2 top-2 rounded-full bg-[var(--primary-color)] px-2 py-1 text-[8px] font-bold text-black">Selected</span>}
        </div>
        <div className="p-2.5">
          <p className="truncate text-[11px] font-semibold text-white/75">{edit.model}</p>
          <p className="mt-1 line-clamp-2 text-[10px] leading-4 text-white/30">{edit.error || edit.prompt}</p>
        </div>
      </button>
      <button type="button" onClick={onDelete} className="flex w-full items-center justify-center gap-1.5 border-t border-white/[0.06] py-2 text-[9px] font-semibold text-white/30 hover:text-red-300"><TrashIcon size={12} /> Delete frame</button>
    </article>
  );
}

function VideoGenerationCard({ version, selected, index, onSelect, onCompare, onDelete }) {
  return (
    <article className={`overflow-hidden rounded-xl border ${selected ? "border-[var(--primary-color)]/70 bg-[var(--primary-color)]/[0.07]" : "border-white/[0.07] bg-white/[0.025]"}`}>
      <button type="button" disabled={version.status !== "succeeded"} onClick={onSelect} className="block w-full text-left disabled:cursor-wait">
        <div className="aspect-video bg-black">
          {version.thumbnailUrl ? <img src={version.thumbnailUrl} alt="" className="h-full w-full object-cover" /> : version.url ? <video src={version.url} muted preload="metadata" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-xs capitalize text-white/30">{version.status}</div>}
        </div>
        <div className="p-2.5">
          <p className="text-[11px] font-semibold text-white/75">{version.scope === "original" ? "Original video" : `Video generation ${String(index).padStart(2, "0")}`}</p>
          {version.error && <p className="mt-1 text-[10px] text-red-300/70">{version.error}</p>}
        </div>
      </button>
      {version.status === "succeeded" && (
        <div className="flex border-t border-white/[0.06] text-[9px] font-semibold text-white/35">
          <button type="button" onClick={onCompare} className="flex-1 py-2 hover:text-white">Compare</button>
          <a href={version.downloadUrl} download className="flex-1 py-2 text-center hover:text-white">Download</a>
          {version.scope !== "original" && <button type="button" onClick={onDelete} className="flex-1 py-2 hover:text-red-300">Delete</button>}
        </div>
      )}
    </article>
  );
}

function RightPanel({
  tab, setTab, edits, versions, activeId, selectedEditId, onSelectEdit, onDeleteEdit,
  onSelectVersion, onCompareVersion, onDeleteVersion,
}) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-white/[0.07] bg-[#09090a]">
      <div className="shrink-0 border-b border-white/[0.07] p-3">
        <p className="px-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/30">Generations</p>
        <div className="mt-2 grid grid-cols-2 rounded-lg bg-black/40 p-0.5 text-[10px] font-semibold">
          <button type="button" onClick={() => setTab("frames")} className={`rounded-md py-1.5 ${tab === "frames" ? "bg-white/10 text-white" : "text-white/35 hover:text-white/70"}`}>Edited frames <span className="ml-1 opacity-45">{edits.length}</span></button>
          <button type="button" onClick={() => setTab("videos")} className={`rounded-md py-1.5 ${tab === "videos" ? "bg-white/10 text-white" : "text-white/35 hover:text-white/70"}`}>Videos <span className="ml-1 opacity-45">{versions.length}</span></button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "frames" ? (
          <div className="space-y-2">
            {edits.length === 0 && <div className="rounded-xl border border-dashed border-white/10 px-4 py-8 text-center text-[11px] leading-5 text-white/25">Your generated edited frames will appear here.</div>}
            {edits.map((edit) => <FrameGenerationCard key={edit.id} edit={edit} selected={edit.id === selectedEditId} onSelect={() => onSelectEdit(edit.id)} onDelete={() => onDeleteEdit(edit.id)} />)}
          </div>
        ) : (
          <div className="space-y-2">
            {versions.map((version, index) => <VideoGenerationCard key={version.id} version={version} selected={version.id === activeId} index={index} onSelect={() => onSelectVersion(version.id)} onCompare={() => onCompareVersion(version)} onDelete={() => onDeleteVersion(version.id)} />)}
          </div>
        )}
      </div>
    </aside>
  );
}

function Editor({ graph, models, selectedFrame, setSelectedFrame, refresh, applyPatch, setError, onBack, onDeleteProject }) {
  const playerRef = useRef(null);
  const referenceInput = useRef(null);
  const frameCommitSequenceRef = useRef(0);
  const active = graph.videoVersions.find((version) => version.id === graph.project.active_video_version_id) || graph.videoVersions[0];
  const duration = Number(active?.duration_seconds || active?.metadata?.source?.durationSeconds || 0);
  const fps = Number(active?.fps || active?.metadata?.source?.fps || 30);
  const [selectedTime, setSelectedTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [mode, setMode] = useState("frame");
  const [rightTab, setRightTab] = useState("frames");
  const imageModels = useMemo(() => models.imageModels.filter((model) => {
    const schema = model.inputs?.[model.mediaField];
    return model.acceptsInputImages === true
      && model.outputKind === "image"
      && Boolean(schema)
      && (schema.mediaKind === "image" || schema.field === "image" || schema.field === "images_list");
  }), [models.imageModels]);
  const [imageModelId, setImageModelId] = useState(imageModels[0]?.id || "");
  const imageModel = imageModels.find((model) => model.id === imageModelId) || imageModels[0];
  const [imageParams, setImageParams] = useState(() => createDefaultModelParams(imageModel));
  const [framePrompt, setFramePrompt] = useState("");
  const [videoPrompt, setVideoPrompt] = useState("");
  const [videoModelKey, setVideoModelKey] = useState(models.videoModels[0]?.key || "");
  const videoModel = models.videoModels.find((model) => model.key === videoModelKey) || models.videoModels[0];
  const videoOptionsModel = useMemo(() => videoModel ? ({
    id: videoModel.key,
    name: videoModel.label,
    provider: videoModel.provider,
    mode: videoModel.mode,
    inputs: videoModel.inputs || {},
    required: [],
  }) : null, [videoModel]);
  const [videoParams, setVideoParams] = useState(() => createDefaultModelParams(videoOptionsModel));
  const [scope, setScope] = useState("whole");
  const [sectionEndTime, setSectionEndTime] = useState(duration);
  const [references, setReferences] = useState([]);
  const imageFieldDefinitions = useMemo(() => catalogImageFields(imageModel), [imageModel]);
  const imageCapacity = imageFieldDefinitions.reduce((total, field) => total + field.limit, 0);
  const [imageAssignments, setImageAssignments] = useState({});
  const assignmentModelRef = useRef(imageModel?.id);
  const assignmentFrameRef = useRef(selectedFrame?.id);
  const [selectedEditId, setSelectedEditId] = useState(null);
  const [submittingFrame, setSubmittingFrame] = useState(false);
  const [submittingVideo, setSubmittingVideo] = useState(false);
  const [compareVersion, setCompareVersion] = useState(null);
  const selectedEdit = graph.frameEdits.find((edit) => edit.id === selectedEditId);
  useEffect(() => {
    setSelectedTime(0);
    setIsPlaying(false);
    setSelectedFrame(null);
    setSelectedEditId(null);
  }, [active?.id, setSelectedFrame]);

  useEffect(() => {
    setImageParams(createDefaultModelParams(imageModel));
    setReferences((items) => items.slice(0, Math.max(0, imageCapacity - 1)));
  }, [imageModel?.id, imageCapacity]);

  const referenceKey = references.map((asset) => asset.id).join("|");
  useEffect(() => {
    const modelChanged = assignmentModelRef.current !== imageModel?.id;
    const frameChanged = assignmentFrameRef.current !== selectedFrame?.id;
    assignmentModelRef.current = imageModel?.id;
    assignmentFrameRef.current = selectedFrame?.id;
    const withoutOldFrame = (previous) => Object.fromEntries(
      Object.entries(previous || {}).map(([field, tokens]) => [field, tokens.filter((token) => token !== "frame")]),
    );
    setImageAssignments((previous) => reconcileImageAssignments(
      imageFieldDefinitions,
      modelChanged ? {} : frameChanged ? withoutOldFrame(previous) : previous,
      selectedFrame,
      references,
    ));
  }, [imageModel?.id, imageFieldDefinitions, referenceKey, selectedFrame?.id]);

  useEffect(() => {
    setVideoParams(createDefaultModelParams(videoOptionsModel));
  }, [videoOptionsModel?.id]);

  useEffect(() => {
    setSectionEndTime(duration);
  }, [active?.id, selectedEdit?.id, duration]);

  const seek = (time) => {
    const value = Math.min(duration, Math.max(0, Number(time)));
    setSelectedTime(value);
    setSelectedFrame(null);
    if (playerRef.current) playerRef.current.currentTime = value;
  };

  const syncPlayerTime = (time) => {
    const value = Math.min(duration, Math.max(0, Number(time)));
    setSelectedTime(value);
    if (selectedFrame && Math.abs(value - Number(selectedFrame.metadata?.actualTimestampSeconds || selectedTime)) > (1 / fps)) setSelectedFrame(null);
  };

  const togglePlayback = () => {
    const player = playerRef.current;
    if (!player) return;
    if (player.paused) {
      if (duration && player.currentTime >= duration - (1 / fps)) player.currentTime = 0;
      void player.play();
    } else {
      player.pause();
    }
  };

  const commitFrame = useCallback(async (time = selectedTime) => {
    if (!active?.id || !duration) return;
    const sequence = frameCommitSequenceRef.current + 1;
    frameCommitSequenceRef.current = sequence;
    setCommitting(true);
    try {
      const timestampSeconds = Math.min(Math.max(0, Number(time)), Math.max(0, duration - (1 / fps)));
      const result = await api(`/projects/${graph.project.id}/frames`, {
        method: "POST",
        headers: { "idempotency-key": uniqueKey() },
        body: JSON.stringify({ videoVersionId: active.id, timestampSeconds }),
      });
      if (sequence !== frameCommitSequenceRef.current) return;
      setSelectedFrame(result.asset);
      setImageAssignments((previous) => {
        const withoutPreviousFrame = Object.fromEntries(
          Object.entries(previous || {}).map(([field, tokens]) => [
            field,
            tokens.filter((token) => token !== "frame"),
          ]),
        );
        return reconcileImageAssignments(
          imageFieldDefinitions,
          withoutPreviousFrame,
          result.asset,
          references,
        );
      });
    } catch (error) {
      if (sequence === frameCommitSequenceRef.current) setError(error.message);
    } finally {
      if (sequence === frameCommitSequenceRef.current) setCommitting(false);
    }
  }, [
    active?.id, duration, fps, graph.project.id, imageFieldDefinitions,
    references, selectedTime, setError, setSelectedFrame,
  ]);

  const addReference = async (file) => {
    const maxReferences = Math.max(0, imageCapacity - 1);
    if (references.length >= maxReferences) return;
    const form = new FormData();
    form.append("file", file);
    form.append("kind", "reference_image");
    try {
      const result = await uploadWithProgress(`/projects/${graph.project.id}/assets`, form);
      setReferences((items) => [...items, result.asset]);
    } catch (error) { setError(error.message); }
  };

  const moveImage = useCallback((token, targetField) => {
    setImageAssignments((previous) => {
      const target = imageFieldDefinitions.find((field) => field.name === targetField);
      if (!target) return previous;
      const source = imageFieldDefinitions.find((field) => (previous[field.name] || []).includes(token));
      const alreadyInTarget = (previous[targetField] || []).includes(token);
      if (alreadyInTarget) return previous;
      const next = Object.fromEntries(imageFieldDefinitions.map((field) => [
        field.name,
        (previous[field.name] || []).filter((item) => item !== token),
      ]));
      const targetTokens = next[targetField];
      let displaced = null;
      if (targetTokens.length >= target.limit) {
        if (!source) return previous;
        displaced = targetTokens.pop();
      }
      next[targetField] = [...next[targetField], token];
      if (displaced && source && source.name !== targetField) {
        if (next[source.name].length >= source.limit) return previous;
        next[source.name] = [...next[source.name], displaced];
      }
      return next;
    });
  }, [imageFieldDefinitions]);

  const editFrame = async () => {
    if (!selectedFrame || !framePrompt.trim() || !imageModel) return;
    const frameAssignments = Object.values(imageAssignments).flat().filter((token) => token === "frame").length;
    if (frameAssignments !== 1) {
      setError("Assign the selected frame to exactly one image input.");
      return;
    }
    setSubmittingFrame(true);
    try {
      const result = await api(`/projects/${graph.project.id}/frame-edits`, {
        method: "POST",
        headers: { "idempotency-key": uniqueKey() },
        body: JSON.stringify({
          videoVersionId: active.id,
          frameAssetId: selectedFrame.id,
          provider: "replicate",
          mode: imageModel.mode,
          model: imageModel.id,
          prompt: framePrompt,
          referenceAssetIds: references.map((asset) => asset.id),
          imageAssignments,
          params: imageParams,
        }),
      });
      applyPatch({ frameEdit: result.frameEdit, job: result.job });
      if (!videoPrompt) setVideoPrompt(framePrompt);
      setSelectedEditId(result.frameEdit?.id || null);
      setRightTab("frames");
    } catch (error) { setError(error.message); }
    finally { setSubmittingFrame(false); }
  };

  const generateVideo = async () => {
    if (!selectedEdit || selectedEdit.status !== "succeeded" || !videoPrompt.trim()) return;
    setSubmittingVideo(true);
    try {
      const result = await api(`/projects/${graph.project.id}/video-edits`, {
        method: "POST",
        headers: { "idempotency-key": uniqueKey() },
        body: JSON.stringify({
          sourceVideoVersionId: active.id,
          frameEditId: selectedEdit.id,
          videoModelKey: videoModel?.key,
          prompt: videoPrompt,
          scope,
          sectionEndSeconds: scope === "range" ? sectionEndTime : undefined,
          params: videoParams,
        }),
      });
      applyPatch({ videoVersion: result.videoVersion, job: result.job });
      setRightTab("videos");
    } catch (error) { setError(error.message); }
    finally { setSubmittingVideo(false); }
  };

  const selectVersion = async (id) => {
    if (id === active.id) return;
    try {
      await api(`/projects/${graph.project.id}/video-versions/${id}`, { method: "PATCH", body: JSON.stringify({ active: true }) });
      await refresh();
    } catch (error) { setError(error.message); }
  };

  const deleteVersion = async (id) => {
    if (!confirm("Delete this generated video version and its stored media?")) return;
    try {
      await api(`/projects/${graph.project.id}/video-versions/${id}`, { method: "DELETE" });
      await refresh();
    } catch (error) { setError(error.message); }
  };

  const deleteFrameEdit = async (id) => {
    if (!confirm("Delete this edited frame? Completed video versions remain available.")) return;
    try {
      await api(`/projects/${graph.project.id}/frame-edits/${id}`, { method: "DELETE" });
      if (selectedEditId === id) setSelectedEditId(null);
      await refresh();
    } catch (error) { setError(error.message); }
  };

  return (
    <div
      className="h-full min-h-0 overflow-hidden bg-[#050506]"
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 310px",
        gridTemplateRows: "minmax(0, 1fr)",
      }}
    >
      <main
        className="h-full min-h-0 overflow-hidden"
        style={{
          display: "grid",
          gridColumn: "1",
          gridRow: "1",
          gridTemplateRows: "2.75rem minmax(210px, 1fr) 5.5rem minmax(210px, 36vh)",
        }}
      >
        <header className="flex min-w-0 items-center justify-between border-b border-white/[0.06] px-4">
          <button type="button" onClick={onBack} className="text-xs font-semibold text-white/45 hover:text-white">← Projects</button>
          <p className="truncate px-4 text-xs font-semibold text-white/65">{graph.project.name}</p>
          <button type="button" onClick={() => onDeleteProject()} className="flex items-center gap-1.5 text-[10px] font-semibold text-white/25 hover:text-red-300"><TrashIcon size={13} /> Delete project</button>
        </header>

        <section className="flex min-h-0 items-center justify-center overflow-hidden bg-[#020203] px-4 py-3 sm:px-6">
          <div className="relative flex h-full max-h-[620px] w-full max-w-[1100px] items-center justify-center overflow-hidden rounded-xl border border-white/[0.07] bg-black shadow-[0_24px_80px_rgba(0,0,0,0.4)]">
            {active?.url
              ? <video ref={playerRef} key={active.id} src={active.url} playsInline onClick={togglePlayback} className="h-full w-full cursor-pointer object-contain" onPlay={() => setIsPlaying(true)} onPause={() => setIsPlaying(false)} onEnded={() => setIsPlaying(false)} onTimeUpdate={(event) => syncPlayerTime(event.currentTarget.currentTime)} onSeeked={(event) => syncPlayerTime(event.currentTarget.currentTime)} />
              : <p className="text-sm text-white/30">Preparing video…</p>}
            {active?.url && (
              <button type="button" onClick={togglePlayback} aria-label={isPlaying ? "Pause video" : "Play video"} className={`absolute bottom-3 left-3 z-20 flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-black/75 text-white shadow-xl backdrop-blur transition hover:scale-105 hover:bg-black ${isPlaying ? "opacity-55 hover:opacity-100" : "opacity-100"}`}>
                {isPlaying
                  ? <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zM14 4h4v16h-4z" /></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="translate-x-px"><path d="m7 4 13 8-13 8z" /></svg>}
              </button>
            )}
            {compareVersion?.url && (
              <div className="absolute inset-0 z-30 flex flex-col bg-black/95 p-4">
                <div className="mb-2 flex items-center justify-between"><span className="text-xs font-semibold text-white/60">Video comparison</span><button type="button" onClick={() => setCompareVersion(null)} className="text-xs text-white/50 hover:text-white">Close</button></div>
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-2"><video src={active.url} controls className="h-full w-full object-contain" /><video src={compareVersion.url} controls className="h-full w-full object-contain" /></div>
              </div>
            )}
          </div>
        </section>

        <FrameTimeline
          videoUrl={active?.url}
          fallback={active?.thumbnailUrl}
          duration={duration}
          fps={fps}
          selectedTime={selectedTime}
          onSeek={seek}
          onCommit={(time) => void commitFrame(time)}
        />

        <CenterComposer
          mode={mode} setMode={setMode} selectedFrame={selectedFrame} videoUrl={active?.url} videoFallback={active?.thumbnailUrl}
          selectedTime={selectedTime} committing={committing} onAttachFrame={() => void commitFrame()}
          framePrompt={framePrompt} setFramePrompt={setFramePrompt} videoPrompt={videoPrompt} setVideoPrompt={setVideoPrompt}
          imageModel={imageModel} imageModels={imageModels} onModelChange={setImageModelId}
          imageParams={imageParams} setImageParams={setImageParams} references={references} setReferences={setReferences}
          imageAssignments={imageAssignments} onMoveImage={moveImage}
          onAddReference={(file) => void addReference(file)} referenceInput={referenceInput}
          submittingFrame={submittingFrame} onEditFrame={editFrame} selectedEdit={selectedEdit}
          scope={scope} setScope={setScope} duration={duration} fps={fps}
          sectionEndTime={sectionEndTime} setSectionEndTime={setSectionEndTime}
          videoModels={models.videoModels} videoModelKey={videoModel?.key || ""} setVideoModelKey={setVideoModelKey}
          videoOptionsModel={videoOptionsModel} videoParams={videoParams} setVideoParams={setVideoParams}
          submittingVideo={submittingVideo} hasCredential={models.hasCredential} onGenerateVideo={generateVideo}
        />
      </main>

      <div style={{ gridColumn: "2", gridRow: "1", minHeight: 0, overflow: "hidden" }}>
        <RightPanel
          tab={rightTab} setTab={setRightTab} edits={graph.frameEdits} versions={graph.videoVersions}
          activeId={active.id} selectedEditId={selectedEditId}
          onSelectEdit={(id) => { setSelectedEditId(id); setMode("video"); }}
          onDeleteEdit={deleteFrameEdit} onSelectVersion={selectVersion}
          onCompareVersion={setCompareVersion} onDeleteVersion={deleteVersion}
        />
      </div>
    </div>
  );
}

export default function RemixStudio({ droppedFiles, onFilesHandled }) {
  const [models, setModels] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState(null);
  const [graph, setGraph] = useState(null);
  const [selectedFrame, setSelectedFrame] = useState(null);
  const [error, setError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [deletingIds, setDeletingIds] = useState(() => new Set());
  const streamConnected = useRef(false);
  const hydrationRequests = useRef(new Map());
  const queuedHydrations = useRef(new Set());
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const loadProjects = useCallback(async () => {
    const result = await api("/projects");
    setProjects(result.projects || []);
  }, []);

  const loadProject = useCallback(async (id = projectId) => {
    if (!id) return;
    const result = await api(`/projects/${id}`);
    setGraph(result);
  }, [projectId]);

  const applyPatch = useCallback((patch) => {
    setGraph((current) => mergeRemixProjectPatch(current, patch));
  }, []);

  const hydrateJob = useCallback(async (targetProjectId, jobId) => {
    if (!targetProjectId || !jobId) return;
    const requestKey = `${targetProjectId}:${jobId}`;
    if (hydrationRequests.current.has(requestKey)) {
      queuedHydrations.current.add(requestKey);
      return hydrationRequests.current.get(requestKey);
    }
    const request = api(`/projects/${targetProjectId}/jobs/${jobId}`)
      .then((patch) => {
        setGraph((current) => (
          current?.project?.id === targetProjectId ? mergeRemixProjectPatch(current, patch) : current
        ));
      })
      .catch((cause) => setError(cause.message))
      .finally(() => {
        hydrationRequests.current.delete(requestKey);
        if (queuedHydrations.current.delete(requestKey)) {
          void hydrateJob(targetProjectId, jobId);
        }
      });
    hydrationRequests.current.set(requestKey, request);
    return request;
  }, []);

  useEffect(() => {
    Promise.all([api("/models"), api("/projects")])
      .then(([modelResult, projectResult]) => {
        setModels(modelResult);
        setProjects(projectResult.projects || []);
      })
      .catch((cause) => setError(cause.message));
  }, []);

  useEffect(() => {
    if (!projectId) {
      setGraph(null);
      return;
    }
    void loadProject(projectId).catch((cause) => setError(cause.message));
  }, [projectId, loadProject]);

  // Remix uses the same authenticated app event stream as the other studios.
  // Notifications hydrate one job and its subject instead of replacing the
  // complete graph (and therefore the active video's signed URL).
  useEffect(() => {
    if (!projectId) return undefined;
    const dispose = subscribeRemixJobs({
      onOpen: () => {
        streamConnected.current = true;
        const activeJobs = graphRef.current?.jobs?.filter(
          (job) => ["queued", "active"].includes(job.status),
        ) || [];
        activeJobs.forEach((job) => void hydrateJob(projectId, job.id));
      },
      onError: () => {
        streamConnected.current = false;
      },
      onUpdate: (event) => {
        if (event.projectId === projectId) void hydrateJob(projectId, event.jobId);
      },
    });
    if (!dispose) streamConnected.current = false;
    return () => {
      streamConnected.current = false;
      dispose?.();
    };
  }, [projectId, hydrateJob]);

  const activeJobKey = graph?.jobs
    ?.filter((job) => ["queued", "active"].includes(job.status))
    .map((job) => job.id)
    .sort()
    .join("|") || "";

  // Hydrate newly tracked jobs once to close the submit/subscribe race. After
  // that, poll only while SSE is unavailable. Each response is a narrow patch,
  // so frame/video cards update without disturbing the player.
  useEffect(() => {
    if (!projectId || !activeJobKey) return undefined;
    const activeJobIds = activeJobKey.split("|");
    if (activeJobIds.length === 0) return undefined;
    activeJobIds.forEach((jobId) => void hydrateJob(projectId, jobId));
    const poll = () => {
      if (streamConnected.current) return;
      activeJobIds.forEach((jobId) => void hydrateJob(projectId, jobId));
    };
    const timer = setInterval(poll, 2500);
    return () => clearInterval(timer);
  }, [projectId, activeJobKey, hydrateJob]);

  const createFromFile = useCallback(async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadProgress(0);
    try {
      const created = await api("/projects", {
        method: "POST",
        body: JSON.stringify({ name: file.name.replace(/\.[^.]+$/, "") || "Untitled Remix" }),
      });
      const form = new FormData();
      form.append("file", file);
      form.append("kind", "source_video");
      await uploadWithProgress(`/projects/${created.project.id}/assets`, form, setUploadProgress);
      setProjectId(created.project.id);
      await loadProjects();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setUploading(false);
    }
  }, [loadProjects]);

  useEffect(() => {
    const file = droppedFiles?.find?.((item) => item.type?.startsWith("video/"));
    if (!file) return;
    void createFromFile(file);
    onFilesHandled?.();
  }, [droppedFiles, onFilesHandled, createFromFile]);

  const deleteProject = async (id = graph?.project.id) => {
    if (!id || !confirm("Delete this Remix project and all of its stored media?")) return;
    setDeletingIds((items) => new Set(items).add(id));
    try {
      await api(`/projects/${id}`, { method: "DELETE" });
      if (id === projectId) {
        setProjectId(null);
        setGraph(null);
      }
      await loadProjects();
    } catch (cause) {
      setError(cause.message);
    } finally {
      setDeletingIds((items) => {
        const next = new Set(items);
        next.delete(id);
        return next;
      });
    }
  };

  if (!models) return <div className="flex h-full items-center justify-center bg-[#050506] text-sm text-white/35">Loading Remix Studio…</div>;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#050506] text-white">
      <ErrorBanner error={error} onClose={() => setError("")} />
      <div className="min-h-0 flex-1">
        {graph ? (
          graph.project.status === "failed" ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
              <h1 className="text-xl font-semibold">Video preparation failed</h1>
              <p className="max-w-lg text-sm text-red-200/70">{graph.project.error}</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setProjectId(null)} className="rounded-lg border border-white/10 px-4 py-2 text-sm">Back to projects</button>
                <button type="button" onClick={() => deleteProject()} className="rounded-lg bg-red-500/20 px-4 py-2 text-sm text-red-200">Delete project</button>
              </div>
            </div>
          ) : graph.videoVersions.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-[var(--primary-color)]" />
              <p className="text-sm text-white/50">Preparing video for editing…</p>
              <button type="button" onClick={() => { setProjectId(null); setGraph(null); void loadProjects(); }} className="text-xs text-white/30 hover:text-white">Return to projects</button>
            </div>
          ) : (
            <Editor
              graph={graph} models={models} selectedFrame={selectedFrame} setSelectedFrame={setSelectedFrame}
              refresh={() => loadProject(graph.project.id)} applyPatch={applyPatch}
              setError={setError} onDeleteProject={deleteProject}
              onBack={() => { setProjectId(null); setGraph(null); void loadProjects(); }}
            />
          )
        ) : (
          <ProjectOverview
            projects={projects} onSelectProject={setProjectId} onDeleteProject={deleteProject}
            onFile={createFromFile} uploadProgress={uploadProgress} busy={uploading} deletingIds={deletingIds}
          />
        )}
      </div>
    </div>
  );
}
