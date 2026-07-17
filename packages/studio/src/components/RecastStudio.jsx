"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { processRecast, uploadFile } from "../muapi.js";
import { useServerGenerations } from "../useServerGenerations.js";
import ModelProviderMark from "./ModelProviderMark.jsx";
import StudioHistoryLoading from "./StudioHistoryLoading.jsx";
import RuntimeEstimate from "./RuntimeEstimate.jsx";
import {
  recastModels,
} from "../models.js";

// ---------------------------------------------------------------------------
// Upload button states
// ---------------------------------------------------------------------------
const UPLOAD_STATE = {
  IDLE: "idle",
  UPLOADING: "uploading",
  READY: "ready",
};

function CheckSvg() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      className="text-primary"
    >
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function MediaPickerButton({
  accept,
  label,
  icon,
  onUpload,
  onClear,
  uploadState,
  progress,
  fileName,
  previewUrl,
  isVideo,
}) {
  const inputRef = useRef(null);

  const handleClick = (e) => {
    e.stopPropagation();
    if (uploadState === UPLOAD_STATE.READY) {
      onClear();
      return;
    }
    inputRef.current?.click();
  };

  const handleChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await onUpload(file);
  };

  const borderClass =
    uploadState === UPLOAD_STATE.READY
      ? "border-primary/60 bg-primary/5"
      : "border-white/[0.03] bg-white/[0.03] hover:bg-white/[0.06] hover:border-primary/40";

  return (
    <button
      type="button"
      title={
        uploadState === UPLOAD_STATE.READY
          ? `${fileName} — click to clear`
          : `Upload ${label.toLowerCase()} file`
      }
      onClick={handleClick}
      className={`flex-shrink-0 w-10 h-10 rounded-full border transition-all flex items-center justify-center relative overflow-hidden group ${borderClass}`}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={handleChange}
      />

      {/* Idle state */}
      {uploadState === UPLOAD_STATE.IDLE && (
        <div className="flex flex-col items-center justify-center gap-1 w-full h-full">
          {icon}
        </div>
      )}

      {/* Uploading indicator */}
      {uploadState === UPLOAD_STATE.UPLOADING && (
        <div className="flex flex-col items-center justify-center w-full h-full absolute inset-0 bg-black/80 z-20 backdrop-blur-[2px]">
          <svg className="w-8 h-8 -rotate-90">
            <circle
              cx="16"
              cy="16"
              r="14"
              stroke="currentColor"
              strokeWidth="2"
              fill="transparent"
              className="text-white/10"
            />
            <circle
              cx="16"
              cy="16"
              r="14"
              stroke="currentColor"
              strokeWidth="2"
              fill="transparent"
              strokeDasharray={88}
              strokeDashoffset={88 - (88 * progress) / 100}
              className="text-primary transition-all duration-300"
            />
          </svg>
          <span className="absolute text-[9px] font-black text-primary leading-none">
            {progress}%
          </span>
        </div>
      )}

      {/* Ready state */}
      {uploadState === UPLOAD_STATE.READY && (
        <div className="flex flex-col items-center justify-center gap-1 w-full h-full absolute inset-0 bg-primary/10 rounded-full group-hover:bg-primary/20 transition-all">
          {previewUrl ? (
            isVideo ? (
              <video
                src={previewUrl}
                className="w-full h-full object-cover"
                muted
              />
            ) : (
              <img
                src={previewUrl}
                alt=""
                className="w-full h-full object-cover"
              />
            )
          ) : (
            icon
          )}
        </div>
      )}
    </button>
  );
}

function ModelDropdown({ models, selectedModel, onSelect, onClose }) {
  const [search, setSearch] = useState("");
  const needle = search.toLowerCase();
  const filtered = models.filter((model) =>
    String(model.name || "").toLowerCase().includes(needle) ||
    String(model.id || "").toLowerCase().includes(needle)
  );

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="mb-2 shrink-0 border-b border-white/5 px-2 pb-3">
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/5 px-4 py-2.5 transition-colors focus-within:border-primary/50">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="text-muted"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            className="w-full border-none bg-transparent p-0 text-xs text-white outline-none focus:ring-0"
          />
        </div>
      </div>
      <div className="shrink-0 px-3 py-2 text-xs font-bold text-secondary">
        Body swap models
      </div>
      <div className="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1 pb-2">
        {filtered.map((model) => (
          <div
            key={model.id}
            className={`flex cursor-pointer items-center justify-between rounded-2xl border border-transparent p-3.5 transition-all hover:border-white/5 hover:bg-white/5 ${
              selectedModel === model.id ? "border-white/5 bg-white/5" : ""
            }`}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(model);
              onClose();
            }}
          >
            <div className="flex min-w-0 items-center gap-3.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-primary/10 text-xs font-black uppercase text-primary shadow-inner">
                <ModelProviderMark model={model} glyphClassName="w-4 h-4" />
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-xs font-bold tracking-tight text-white">
                  {model.name}
                </span>
                <span className="truncate text-[9px] text-white/35">
                  {model.id}
                </span>
              </div>
            </div>
            {selectedModel === model.id && <CheckSvg />}
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-white/35">
            No models found
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline dropdown
// ---------------------------------------------------------------------------
function Dropdown({ isOpen, items, selectedId, onSelect, onClose, anchorRef }) {
  const dropRef = useRef(null);
  const [style, setStyle] = useState({});

  useEffect(() => {
    if (!isOpen || !anchorRef?.current || !dropRef.current) return;

    const rect = anchorRef.current.getBoundingClientRect();
    const ddHeight = dropRef.current.offsetHeight;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;

    let top, bottom, maxHeight;
    if (spaceBelow >= ddHeight || spaceBelow >= spaceAbove) {
      top = rect.bottom + 8;
      bottom = "auto";
      maxHeight = Math.min(300, Math.max(150, spaceBelow - 8));
    } else {
      top = "auto";
      bottom = window.innerHeight - rect.top + 8;
      maxHeight = Math.min(300, Math.max(150, spaceAbove - 8));
    }
    const left = Math.min(rect.left, window.innerWidth - 220);
    setStyle({ top, bottom, left, maxHeight });
  }, [isOpen, anchorRef]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (
        !dropRef.current?.contains(e.target) &&
        !anchorRef?.current?.contains(e.target)
      ) {
        onClose();
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [isOpen, onClose, anchorRef]);

  if (!isOpen) return null;

  return (
    <div
      ref={dropRef}
      style={{
        position: "fixed",
        zIndex: 100,
        overflowY: "auto",
        ...style,
      }}
      className="bg-[#111] border border-white/10 rounded-lg shadow-3xl p-1.5 custom-scrollbar w-[calc(100vw-3rem)] max-w-[240px]"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => {
            onSelect(item);
            onClose();
          }}
          className={`w-full text-left px-3 py-1.5 rounded text-xs transition-all hover:bg-white/10 ${
            item.id === selectedId
              ? "text-primary font-bold bg-primary/5"
              : "text-white font-medium"
          }`}
        >
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 text-primary border border-white/5 flex items-center justify-center text-xs font-black shadow-inner uppercase overflow-hidden">
              <ModelProviderMark model={item} glyphClassName="w-4 h-4" />
            </span>
            <span className="truncate">{item.name}</span>
          </div>
          {item.description && (
            <div className="text-[10px] text-muted mt-0.5 line-clamp-2">
              {item.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------
const VideoIcon = ({
  className = "text-white/40 group-hover:text-primary transition-colors",
}) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={className}
  >
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
  </svg>
);

const ImageIcon = ({
  className = "text-white/40 group-hover:text-primary transition-colors",
}) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className={className}
  >
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
);

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function RecastStudio({
  apiKey,
  provider = "replicate",
  onGenerationComplete,
  historyItems,
  droppedFiles,
  onFilesHandled,
  modelsByMode,
}) {
  const PERSIST_KEY = "hg_recast_studio_persistent";
  const DEFAULT_PERSISTENCE = {
    version: 1,
    provider: "replicate",
    selectedModelId: "seedance-2-0-mini",
    options: {
      aspect_ratio: "16:9",
    },
    uploads: {
      video_url: null,
      video_name: "",
      image_url: null,
      image_name: "",
    },
    prompt: "",
  };

  // ── Provider-aware model catalog ──────────────────────────────────────────
  // When the active provider is Replicate, the shell passes provider-correct
  // recast models via `modelsByMode.recast`. Fall back to the bundled MuAPI
  // catalog only when nothing was supplied, so we never send a MuAPI-only id
  // (e.g. "kling-v3.0-pro-recast") to Replicate.
  const effectiveRecastModels = useMemo(
    () => (modelsByMode?.recast?.length ? modelsByMode.recast : recastModels),
    [modelsByMode],
  );

  // ── Model state ───────────────────────────────────────────────────────────
  const firstModel = effectiveRecastModels[0];
  const [selectedModelId, setSelectedModelId] = useState(firstModel?.id ?? "");
  const [selectedAspectRatio, setSelectedAspectRatio] = useState(
    firstModel?.inputs?.aspect_ratio?.default ?? "16:9",
  );

  // ── Upload state ──────────────────────────────────────────────────────────
  const [videoState, setVideoState] = useState(UPLOAD_STATE.IDLE);
  const [videoName, setVideoName] = useState("");
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoProgress, setVideoProgress] = useState(0);

  const [imageState, setImageState] = useState(UPLOAD_STATE.IDLE);
  const [imageName, setImageName] = useState("");
  const [imageUrl, setImageUrl] = useState(null);
  const [imageProgress, setImageProgress] = useState(0);

  // ── Prompt ────────────────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");

  // ── Generation / UI state ─────────────────────────────────────────────────
  const [isGenerating, setIsGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [fullscreenUrl, setFullscreenUrl] = useState(null);

  // ── History ───────────────────────────────────────────────────────────────
  const [internalHistory, setInternalHistory] = useState([]);
  const serverGen = useServerGenerations({ mediaType: "video", mode: "recast" });
  const history = historyItems ?? (serverGen.active ? serverGen.items : internalHistory);

  // ── Dropdown state ────────────────────────────────────────────────────────
  const [openDropdown, setOpenDropdown] = useState(null); // 'model' | 'aspect' | null
  const aspectBtnRef = useRef(null);
  const dropdownRef = useRef(null);
  const hasRestored = useRef(false);
  const appliedProviderDefaultRef = useRef(new Set());
  const suppressProviderDefaultRef = useRef(false);
  const restoredPersistentModelRef = useRef(false);
  const restoredPersistentModelIdRef = useRef(null);
  const skipNextConfigSaveRef = useRef(false);
  const hasProviderCatalog = provider === "muapi" || !!modelsByMode?.recast?.length;

  useEffect(() => {
    if (openDropdown !== "model") return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpenDropdown(null);
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [openDropdown]);

  // ── Persistence: Load ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!modelsByMode || !hasProviderCatalog) return;
    if (hasRestored.current) return;
    try {
      const stored = localStorage.getItem(PERSIST_KEY);
      const data = stored ? JSON.parse(stored) : DEFAULT_PERSISTENCE;
      const storedProvider = data.provider || "replicate";
      if (storedProvider !== provider) {
        restoredPersistentModelRef.current = false;
        restoredPersistentModelIdRef.current = null;
        return;
      }
      if (!stored) localStorage.setItem(PERSIST_KEY, JSON.stringify(data));
      skipNextConfigSaveRef.current = true;
      const options = data.options || data;
      const restoredModelId = data.selectedModelId || data.selectedModel;
      const restoredModel = effectiveRecastModels.find((model) => model.id === restoredModelId);
      restoredPersistentModelRef.current = !!restoredModel;
      restoredPersistentModelIdRef.current = restoredModel ? restoredModel.id : null;
      if (restoredModelId) setSelectedModelId(restoredModelId);
      if (options.aspect_ratio || data.selectedAspectRatio) setSelectedAspectRatio(options.aspect_ratio || data.selectedAspectRatio);
      if (data.uploads?.video_url || data.videoUrl) {
        setVideoUrl(data.uploads?.video_url || data.videoUrl);
        setVideoState(UPLOAD_STATE.READY);
      }
      if (data.uploads?.image_url || data.imageUrl) {
        setImageUrl(data.uploads?.image_url || data.imageUrl);
        setImageState(UPLOAD_STATE.READY);
      }
      if (data.uploads?.video_name || data.videoName) setVideoName(data.uploads?.video_name || data.videoName);
      if (data.uploads?.image_name || data.imageName) setImageName(data.uploads?.image_name || data.imageName);
      if (data.prompt) setPrompt(data.prompt);
      suppressProviderDefaultRef.current = true;
    } catch (err) {
      console.warn("Failed to load RecastStudio persistence:", err);
    } finally {
      hasRestored.current = true;
    }
  }, [modelsByMode, hasProviderCatalog, provider, effectiveRecastModels]);

  // ── Persistence: Save ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!modelsByMode || !hasProviderCatalog || !hasRestored.current) return;
    if (skipNextConfigSaveRef.current) {
      skipNextConfigSaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          PERSIST_KEY,
          JSON.stringify({
            version: 1,
            provider,
            selectedModelId,
            options: {
              aspect_ratio: selectedAspectRatio,
            },
            uploads: {
              video_url: videoUrl,
              video_name: videoName,
              image_url: imageUrl,
              image_name: imageName,
            },
            prompt,
            // Phase 5: results live server-side when active — persist prefs only.
          }),
        );
      } catch (err) {
        console.warn("Failed to save RecastStudio persistence:", err);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [
    selectedModelId,
    selectedAspectRatio,
    videoUrl,
    videoName,
    imageUrl,
    imageName,
    prompt,
    modelsByMode,
    hasProviderCatalog,
    provider,
  ]);

  // ── Derived model info ──────────────────────────────────────────────────────
  const selectedModel = effectiveRecastModels.find((m) => m.id === selectedModelId);
  const aspectOptions = selectedModel?.inputs?.aspect_ratio?.enum || [];
  const showAspect = aspectOptions.length > 0;
  const showPrompt = !!selectedModel?.hasPrompt;

  // ── Keep the selection valid for the active provider ──────────────────────
  // A stale id can come from localStorage or from switching providers (e.g. a
  // MuAPI-only "kling-v3.0-pro-recast" id while Replicate is active). If the
  // catalog doesn't contain it, fall back to the first available model.
  useEffect(() => {
    if (!modelsByMode || !hasProviderCatalog) return;
    if (!effectiveRecastModels.length) return;
    if (restoredPersistentModelIdRef.current) return;
    if (effectiveRecastModels.some((m) => m.id === selectedModelId)) return;
    const first = effectiveRecastModels[0];
    restoredPersistentModelRef.current = false;
    restoredPersistentModelIdRef.current = null;
    setSelectedModelId(first.id);
    setSelectedAspectRatio(first.inputs?.aspect_ratio?.default ?? "16:9");
  }, [modelsByMode, hasProviderCatalog, effectiveRecastModels, selectedModelId]);

  useEffect(() => {
    if (restoredPersistentModelIdRef.current) return;
    if (restoredPersistentModelRef.current && effectiveRecastModels.some((model) => model.id === selectedModelId)) return;
    if (suppressProviderDefaultRef.current) {
      suppressProviderDefaultRef.current = false;
      return;
    }
    if (!modelsByMode?.recast?.length) return;
    const first = modelsByMode.recast[0];
    const key = `recast:${first.provider || "muapi"}:${first.id}`;
    if (appliedProviderDefaultRef.current.has(key)) return;
    appliedProviderDefaultRef.current.add(key);
    setSelectedModelId(first.id);
    setSelectedAspectRatio(first.inputs?.aspect_ratio?.default ?? "16:9");
  }, [modelsByMode?.recast, effectiveRecastModels, selectedModelId]);

  // ── Upload handlers ─────────────────────────────────────────────────────────
  const handleVideoPick = useCallback(
    async (file) => {
      if (file.size > 50 * 1024 * 1024) {
        alert("Video exceeds 50MB limit.");
        return;
      }
      setVideoState(UPLOAD_STATE.UPLOADING);
      setVideoProgress(0);
      try {
        const url = await uploadFile(apiKey, file, (pct) => setVideoProgress(pct));
        setVideoUrl(url);
        setVideoName(file.name);
        setVideoState(UPLOAD_STATE.READY);
      } catch (err) {
        setVideoState(UPLOAD_STATE.IDLE);
        alert(`Video upload failed: ${err.message}`);
      } finally {
        setVideoProgress(0);
      }
    },
    [apiKey],
  );

  const handleImageUpload = useCallback(
    async (file) => {
      if (file.size > 10 * 1024 * 1024) {
        alert("Image exceeds 10MB limit.");
        return;
      }
      setImageState(UPLOAD_STATE.UPLOADING);
      setImageProgress(0);
      try {
        const url = await uploadFile(apiKey, file, (pct) => setImageProgress(pct));
        setImageUrl(url);
        setImageName(file.name);
        setImageState(UPLOAD_STATE.READY);
      } catch (err) {
        setImageState(UPLOAD_STATE.IDLE);
        alert(`Image upload failed: ${err.message}`);
      } finally {
        setImageProgress(0);
      }
    },
    [apiKey],
  );

  // ── Handle Dropped Files ────────────────────────────────────────────────────
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      const imageFiles = droppedFiles.filter((f) => f.type.startsWith("image/"));
      const videoFiles = droppedFiles.filter((f) => f.type.startsWith("video/"));
      if (videoFiles.length > 0) handleVideoPick(videoFiles[0]);
      if (imageFiles.length > 0) handleImageUpload(imageFiles[0]);
      onFilesHandled?.();
    }
  }, [droppedFiles, onFilesHandled, handleVideoPick, handleImageUpload]);

  // ── Model selection ─────────────────────────────────────────────────────────
  const handleModelSelect = (model) => {
    restoredPersistentModelRef.current = false;
    restoredPersistentModelIdRef.current = null;
    setSelectedModelId(model.id);
    const ratios = model.inputs?.aspect_ratio?.enum || [];
    if (ratios.length > 0) {
      setSelectedAspectRatio(model.inputs?.aspect_ratio?.default ?? ratios[0]);
    }
  };

  // ── History helpers ─────────────────────────────────────────────────────────
  const addToInternalHistory = useCallback((entry) => {
    setInternalHistory((prev) => [entry, ...prev].slice(0, 30));
  }, []);

  const downloadFile = async (url, filename) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(url, "_blank");
    }
  };

  // ── Generation ──────────────────────────────────────────────────────────────
  // Reuse a past generation's settings back into the form.
  const handleReuse = (entry) => {
    const p = entry.params || {};
    if (entry.model) setSelectedModelId(entry.model);
    if (p.video_url) setVideoUrl(p.video_url);
    if (p.image_url) setImageUrl(p.image_url);
    if (p.aspect_ratio) setSelectedAspectRatio(p.aspect_ratio);
    setPrompt(p.prompt || entry.prompt || "");
  };

  const handleGenerate = async () => {
    if (!videoUrl) {
      alert("Please upload a source video first.");
      return;
    }
    if (!imageUrl) {
      alert("Please upload a character image first.");
      return;
    }

    setIsGenerating(true);
    setGenerateError(null);

    try {
      const params = {
        model: selectedModelId,
        video_url: videoUrl,
        image_url: imageUrl,
      };
      if (showAspect) params.aspect_ratio = selectedAspectRatio;
      if (prompt && selectedModel?.hasPrompt) params.prompt = prompt;

      // ── Server-persisted async path ──────────────────────────────────────
      if (serverGen.active) {
        const { model, ...serverParams } = params;
        await serverGen.generate({ mode: "recast", model: selectedModelId, params: serverParams });
        return;
      }

      const res = await processRecast(apiKey, params);

      if (!res?.url) throw new Error("No video URL returned by API");

      const genId = res.id || Date.now().toString();
      const entry = {
        id: genId,
        url: res.url,
        prompt,
        model: selectedModel?.name || selectedModelId,
        timestamp: new Date().toISOString(),
      };

      if (!historyItems) addToInternalHistory(entry);

      if (onGenerationComplete) {
        onGenerationComplete({
          url: res.url,
          model: selectedModelId,
          prompt,
          type: "recast",
        });
      }
    } catch (e) {
      console.error("[RecastStudio]", e);
      setGenerateError(e.message?.slice(0, 80) ?? "Unknown error");
      setTimeout(() => setGenerateError(null), 4000);
    } finally {
      setIsGenerating(false);
    }
  };

  // ── Dropdown item lists ─────────────────────────────────────────────────────
  const aspectDropdownItems = aspectOptions.map((r) => ({ id: r, name: r }));

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-app-bg relative overflow-hidden">

      {/* ── CENTRAL GALLERY AREA ── */}
      <div className="flex-1 w-full max-w-7xl mx-auto overflow-y-auto custom-scrollbar pb-40 lg:pb-32 px-2">
        {serverGen.active && serverGen.loading && history.length === 0 ? (
          <StudioHistoryLoading label="Loading your body swap videos" />
        ) : history.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full pt-4 animate-fade-in-up">
            {history.map((entry, idx) => (
              <div
                key={entry.id || idx}
                className="relative group rounded-2xl overflow-hidden border border-white/10 bg-[#0a0a0a] shadow-xl hover:border-primary/50 transition-all duration-300 flex flex-col"
              >
                <video
                  src={entry.url}
                  className="w-full aspect-video object-cover bg-black/40 cursor-pointer hover:opacity-80 transition-opacity"
                  onClick={() => setFullscreenUrl(entry.url)}
                  controls={false}
                  loop
                  muted
                  playsInline
                  onMouseOver={(e) => e.target.play()}
                  onMouseOut={(e) => {
                    e.target.pause();
                    e.target.currentTime = 0;
                  }}
                  style={{ display: entry.url ? "block" : "none" }}
                />

                {!entry.url && entry.status !== "failed" && (
                  <div className="w-full aspect-video bg-black/40 flex flex-col items-center justify-center gap-2">
                    <div className="animate-spin text-primary text-2xl">◌</div>
                    <span className="text-[11px] text-white/40">Generating…</span>
                    <RuntimeEstimate
                      estimate={entry.runtimeEstimate}
                      createdAt={entry.providerCreatedAt}
                    />
                  </div>
                )}
                {!entry.url && entry.status === "failed" && (
                  <div className="w-full aspect-video bg-black/40 flex flex-col items-center justify-center gap-2 px-3 text-center">
                    <span className="text-red-400 text-xl">⚠</span>
                    <span className="text-[11px] text-white/50 line-clamp-3">
                      {entry.error || "Generation failed"}
                    </span>
                  </div>
                )}

                {/* Overlay actions */}
                <div className="absolute top-2 right-2 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    type="button"
                    title="Fullscreen"
                    onClick={(e) => {
                      e.stopPropagation();
                      setFullscreenUrl(entry.url);
                    }}
                    className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-primary hover:text-black transition-all border border-white/10"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <polyline points="15 3 21 3 21 9" />
                      <polyline points="9 21 3 21 3 15" />
                      <line x1="21" y1="3" x2="14" y2="10" />
                      <line x1="3" y1="21" x2="10" y2="14" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    title="Download"
                    onClick={(e) => {
                      e.stopPropagation();
                      downloadFile(entry.url, `bodyswap-${entry.id || idx}.mp4`);
                    }}
                    className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-primary hover:text-black transition-all border border-white/10"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                  </button>
                  {serverGen.active && entry.id && (
                    <button
                      type="button"
                      title="Reuse settings"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleReuse(entry);
                      }}
                      className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-primary hover:text-black transition-all border border-white/10"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="23 4 23 10 17 10" />
                        <path d="M20.49 15a9 9 0 11-2.12-9.36L23 10" />
                      </svg>
                    </button>
                  )}
                  {serverGen.active && entry.id && (
                    <button
                      type="button"
                      title="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        serverGen.remove(entry.id);
                      }}
                      className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-red-500 hover:text-white transition-all border border-white/10"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Details */}
                <div className="p-3 bg-black/80 backdrop-blur-sm border-t border-white/5 flex-1 flex flex-col justify-between gap-2">
                  <div className="flex items-center justify-between flex-wrap gap-1">
                    <span className="text-[10px] font-bold text-primary px-2 py-0.5 bg-primary/10 rounded border border-primary/20 whitespace-nowrap">
                      {entry.model?.name || entry.model || "Body Swap"}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in-up transition-all duration-700 min-h-[50vh]">
            <div className="mb-12 relative group">
              <div className="absolute inset-0 bg-primary/10 blur-[120px] rounded-full opacity-30 group-hover:opacity-60 transition-opacity duration-1000" />
              <div className="relative w-24 h-24 md:w-32 md:h-32 bg-white/[0.02] rounded-[2rem] flex items-center justify-center border border-white/[0.05] overflow-hidden backdrop-blur-sm">
                <div className="w-16 h-16 bg-primary/5 rounded-2xl flex items-center justify-center border border-primary/10 relative z-10 transition-transform duration-500 group-hover:scale-110">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary opacity-80">
                    <path d="M16 3h5v5" />
                    <path d="M8 21H3v-5" />
                    <path d="M21 3l-7 7" />
                    <path d="M3 21l7-7" />
                    <circle cx="12" cy="12" r="2.2" />
                  </svg>
                </div>
                <div className="absolute top-4 right-4 text-[10px] text-primary/40 animate-pulse">🎭</div>
              </div>
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold text-white tracking-tight mb-4 text-center px-4">
              <span className="text-white/40 font-medium">START CREATING WITH</span><br />
              <span className="text-white">BODY SWAP</span>
            </h1>
            <p className="text-white/40 text-sm md:text-base font-medium tracking-wide text-center max-w-lg leading-relaxed">
              Swap the character in any video — drop in a clip and a character image
            </p>
          </div>
        )}
      </div>

      {/* ── BOTTOM PROMPT BAR ── */}
      <div className="absolute bottom-4 w-full max-w-[95%] lg:max-w-4xl z-40 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
        <div className="w-full bg-[#0a0a0a]/80 backdrop-blur-3xl rounded-md border border-white/10 p-4 flex flex-col gap-2 shadow-2xl">
          {/* Uploads row */}
          <div className="flex items-center gap-2 px-1">
            <div className="flex items-center gap-2">
              {/* Source video */}
              <MediaPickerButton
                accept="video/*"
                label="Video"
                icon={<VideoIcon />}
                onUpload={handleVideoPick}
                onClear={() => {
                  setVideoUrl(null);
                  setVideoState(UPLOAD_STATE.IDLE);
                  setVideoName("");
                }}
                uploadState={videoState}
                progress={videoProgress}
                fileName={videoName}
                previewUrl={videoUrl}
                isVideo={true}
              />

              {/* Character image */}
              <MediaPickerButton
                accept="image/*"
                label="Character image"
                icon={<ImageIcon />}
                onUpload={handleImageUpload}
                onClear={() => {
                  setImageUrl(null);
                  setImageState(UPLOAD_STATE.IDLE);
                  setImageName("");
                }}
                uploadState={imageState}
                progress={imageProgress}
                fileName={imageName}
                previewUrl={imageUrl}
                isVideo={false}
              />
            </div>

            {/* Hint / prompt */}
            {showPrompt ? (
              <div className="flex-1 flex flex-col">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Optional — describe the motion or scene..."
                  className="w-full bg-transparent border-none text-white text-sm placeholder:text-white/10 focus:outline-none resize-none pt-1 leading-relaxed min-h-[40px] max-h-[150px] md:max-h-[250px] overflow-y-auto custom-scrollbar disabled:opacity-40"
                  rows={1}
                />
              </div>
            ) : (
              <div className="flex-1 flex items-center pl-2">
                <span className="text-xs text-white/30 font-medium">
                  Your Video + Character Image → swapped video
                </span>
              </div>
            )}
          </div>

          {/* Bottom controls row */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 pt-2 border-t border-white/[0.03] relative">
            <div className="flex items-center gap-2 px-1">
              {/* Model selector */}
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenDropdown(openDropdown === "model" ? null : "model");
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                >
                  <div className="w-5 h-5 shrink-0 rounded-md bg-white/[0.04] text-white/70 border border-white/[0.06] flex items-center justify-center overflow-hidden shadow-inner">
                    <ModelProviderMark
                      model={selectedModel}
                      glyphClassName="w-3.5 h-3.5"
                    />
                  </div>
                  <span className="text-xs font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors">
                    {selectedModel?.name ?? "Select model"}
                  </span>
                  <svg
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                    className="opacity-50 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {openDropdown === "model" && (
                  <div
                    ref={dropdownRef}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-[calc(100%+12px)] left-0 z-50 w-[calc(100vw-3rem)] max-w-xs rounded-[1.5rem] border border-white/[0.05] bg-[#0a0a0a] p-3 shadow-2xl"
                  >
                    <ModelDropdown
                      models={effectiveRecastModels}
                      selectedModel={selectedModelId}
                      onSelect={handleModelSelect}
                      onClose={() => setOpenDropdown(null)}
                    />
                  </div>
                )}
              </div>

              {/* Aspect ratio selector */}
              {showAspect && (
                <div className="relative">
                  <button
                    ref={aspectBtnRef}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenDropdown(openDropdown === "aspect" ? null : "aspect");
                    }}
                    className="flex items-center gap-2 px-2 py-1.5 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                  >
                    <span className="text-xs font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors">
                      {selectedAspectRatio}
                    </span>
                  </button>
                  <Dropdown
                    isOpen={openDropdown === "aspect"}
                    items={aspectDropdownItems}
                    selectedId={selectedAspectRatio}
                    onSelect={(item) => setSelectedAspectRatio(item.id)}
                    onClose={() => setOpenDropdown(null)}
                    anchorRef={aspectBtnRef}
                  />
                </div>
              )}
            </div>

            {/* Generate button */}
            <button
              type="button"
              onClick={handleGenerate}
              disabled={isGenerating}
              className="bg-[var(--primary-color)] text-black px-4 py-2 rounded-md font-medium text-sm hover:bg-[var(--primary-light-color)] hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2 w-full sm:w-auto shadow-lg shadow-[var(--primary-color)]/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGenerating ? (
                <>
                  <span className="animate-spin inline-block text-black">◌</span>{" "}
                  Swapping...
                </>
              ) : generateError ? (
                `Error: ${generateError}`
              ) : (
                <span>Swap Body</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── FULLSCREEN MEDIA MODAL ── */}
      {fullscreenUrl && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-sm animate-fade-in"
          onClick={() => setFullscreenUrl(null)}
        >
          <button
            type="button"
            className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white transition-colors border border-white/10"
            onClick={(e) => {
              e.stopPropagation();
              setFullscreenUrl(null);
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <video
            src={fullscreenUrl}
            controls
            autoPlay
            loop
            className="max-w-[95vw] max-h-[95vh] rounded-2xl shadow-2xl object-contain animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
