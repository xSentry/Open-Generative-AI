"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { generateVideo, generateI2V, processV2V, uploadFile } from "../muapi.js";
import { useServerGenerations } from "../useServerGenerations.js";
import ModelProviderMark from "./ModelProviderMark.jsx";
import StudioHistoryLoading from "./StudioHistoryLoading.jsx";
import RuntimeEstimate from "./RuntimeEstimate.jsx";
import { DynamicModelInputsPanel, createDefaultModelParams } from "./DynamicModelInputs.jsx";
import {
  t2vModels,
  i2vModels,
  v2vModels,
  getAspectRatiosForVideoModel,
  getDurationsForModel,
  getResolutionsForVideoModel,
  getAspectRatiosForI2VModel,
  getDurationsForI2VModel,
  getResolutionsForI2VModel,
  getEffectsForI2VModel,
  getMaxImagesForI2VModel,
} from "../models.js";

// ── tiny helpers ──────────────────────────────────────────────────────────────

function getQualitiesForModel(modelList, modelId) {
  const model = modelList.find((m) => m.id === modelId);
  return model?.inputs?.quality?.enum || [];
}

function getInputOptions(model, inputName) {
  const input = model?.inputs?.[inputName];
  if (!input) return [];
  if (Array.isArray(input.enum)) return input.enum;
  if (
    input.minValue !== undefined &&
    input.maxValue !== undefined &&
    input.step
  ) {
    const values = [];
    for (let value = input.minValue; value <= input.maxValue; value += input.step) {
      values.push(value);
    }
    return values;
  }
  return input.default !== undefined && input.default !== null
    ? [input.default]
    : [];
}

function modelRequiresImageInput(model) {
  if (!model) return false;
  const required = new Set(model.required || []);
  return Object.entries(model.inputs || {}).some(([name, input]) => {
    const isImage =
      input?.mediaKind === "image" ||
      input?.field === "images_list" ||
      name === model.imageField ||
      name === model.swapField;
    return isImage && required.has(name);
  });
}

function modelAcceptsPrompt(model) {
  if (!model) return false;
  if (typeof model.hasPrompt === "boolean") return model.hasPrompt;
  return Boolean(model.inputs?.prompt);
}

function compactParams(params) {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) =>
      value !== undefined && value !== null && value !== "" &&
      (!Array.isArray(value) || value.length > 0),
    ),
  );
}

function modelAcceptsImageInput(model) {
  if (!model) return false;
  if (model.imageField || model.swapField) return true;
  if (model.inputs) {
    return Object.values(model.inputs).some((input) => input?.mediaKind === "image" || input?.field === "images_list");
  }
  return true;
}

function imageArrayInputs(model) {
  if (!model?.inputs) return [];
  return Object.values(model.inputs).filter(
    (input) => input?.type === "array" && (input.mediaKind === "image" || input.field === "images_list"),
  );
}

function maxImagesForI2VModel(model) {
  if (!model) return 1;
  if (Number(model.maxImages) > 0) return Number(model.maxImages);

  const arrayInputs = imageArrayInputs(model);
  if (arrayInputs.length > 0) {
    const maxItems = arrayInputs
      .map((input) => Number(input.maxItems))
      .filter((value) => Number.isFinite(value) && value > 1);
    if (maxItems.length > 0) return Math.max(...maxItems);
    return 10;
  }

  return getMaxImagesForI2VModel(model.id) || 1;
}

async function downloadFile(url, filename) {
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
}

// ── SVG icons (kept inline to avoid extra deps) ───────────────────────────────

const CheckSvg = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="var(--primary-color)"
    strokeWidth="4"
  >
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const VideoIconSvg = ({ className }) => (
  <svg
    width="18"
    height="18"
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

const VideoReadySvg = () => (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="text-primary"
  >
    <polygon points="23 7 16 12 23 17 23 7" />
    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
    <polyline points="7 10 10 13 15 8" stroke="var(--primary-color)" strokeWidth="2.5" />
  </svg>
);

// ── Dropdown components ───────────────────────────────────────────────────────

function DropdownItem({ label, selected, onClick }) {
  return (
    <div
      className="flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all group"
      onClick={onClick}
    >
      <span className="text-xs font-bold text-white opacity-80 group-hover:opacity-100 capitalize">
        {label}
      </span>
      {selected && <CheckSvg />}
    </div>
  );
}

function ModelDropdown({ imageMode, selectedModel, onSelect, onClose, modelsByMode }) {
  const [search, setSearch] = useState("");

  const t2vModelList = modelsByMode?.t2v?.length ? modelsByMode.t2v : t2vModels;
  const i2vModelList = modelsByMode?.i2v?.length ? modelsByMode.i2v : i2vModels;
  const v2vModelList = modelsByMode?.v2v?.length ? modelsByMode.v2v : v2vModels;
  const generationModels = imageMode ? i2vModelList : t2vModelList;

  const lf = search.toLowerCase();
  const filteredMain = generationModels.filter(
    (m) => m.name.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf),
  );
  const filteredV2V = v2vModelList.filter(
    (m) => m.name.toLowerCase().includes(lf) || m.id.toLowerCase().includes(lf),
  );

  const getIconColor = (m, isV2V) => {
    if (isV2V) return "bg-orange-500/10 text-orange-400";
    if (m.id.includes("kling")) return "bg-blue-500/10 text-blue-400";
    if (m.id.includes("veo")) return "bg-purple-500/10 text-purple-400";
    if (m.id.includes("sora")) return "bg-rose-500/10 text-rose-400";
    return "bg-primary/10 text-primary";
  };

  const renderItem = (m, isV2V = false) => (
    <div
      key={m.id}
      className={`flex items-center justify-between p-3.5 hover:bg-white/5 rounded-2xl cursor-pointer transition-all border border-transparent hover:border-white/5 ${selectedModel === m.id ? "bg-white/5 border-white/5" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(m, isV2V);
        onClose();
      }}
    >
      <div className="flex items-center gap-3.5">
        <div
          className={`w-8 h-8 ${getIconColor(m, isV2V)} border border-white/5 rounded-lg flex items-center justify-center font-black text-xs shadow-inner uppercase overflow-hidden shrink-0`}
        >
          <ModelProviderMark model={m} glyphClassName="w-4 h-4" />
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-bold text-white tracking-tight">
            {m.name}
          </span>
          {isV2V && (
            <span className="text-[9px] text-orange-400/70">
              {m.imageField ? "Upload a video and image" : "Upload a video to use"}
            </span>
          )}
        </div>
      </div>
      {selectedModel === m.id && <CheckSvg />}
    </div>
  );

  return (
    <div className="flex flex-col h-full max-h-[70vh]">
      <div className="px-2 pb-3 mb-2 border-b border-white/5 shrink-0">
        <div className="flex items-center gap-3 bg-white/5 rounded-xl px-4 py-2.5 border border-white/5 focus-within:border-primary/50 transition-colors">
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
            className="bg-transparent border-none text-xs text-white focus:ring-0 w-full p-0 outline-none"
          />
        </div>
      </div>
      <div className="text-xs font-bold text-secondary px-3 py-2 shrink-0">
        Video models
      </div>
      <div className="flex flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1 pb-2">
        {filteredMain.map((m) => renderItem(m, false))}
        {filteredV2V.length > 0 && (
          <>
            <div className="text-xs font-bold text-orange-400/70 px-3 py-2 mt-1 border-t border-white/5">
              Video Tools
            </div>
            {filteredV2V.map((m) => renderItem(m, true))}
          </>
        )}
      </div>
    </div>
  );
}

// ── Control button ────────────────────────────────────────────────────────────

function ControlBtn({ icon, label, onClick, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      className="flex items-center gap-1.5 md:gap-2.5 px-3 md:px-4 py-2 md:py-2.5 bg-white/5 hover:bg-white/10 rounded-xl md:rounded-2xl transition-all border border-white/5 group whitespace-nowrap"
    >
      {icon}
      <span className="text-xs font-bold text-white group-hover:text-primary transition-colors">
        {label}
      </span>
      <svg
        width="10"
        height="10"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        className="opacity-20 group-hover:opacity-100 transition-opacity"
      >
        <path d="M6 9l6 6 6-6" />
      </svg>
    </button>
  );
}

// ── Dropdown panel ─────────────────────────────────────────────────────────────
// Rendered inside a `relative` wrapper div; floats above the anchor button.

// ── Main component ────────────────────────────────────────────────────────────

export default function VideoStudio({
  apiKey,
  provider = "replicate",
  onGenerationComplete,
  historyItems,
  droppedFiles,
  onFilesHandled,
  modelsByMode,
}) {
  const PERSIST_KEY = "hg_video_studio_persistent";
  const DEFAULT_PERSISTENCE = {
    version: 1,
    provider: "replicate",
    imageMode: false,
    v2vMode: false,
    selectedModelId: "seedance-2-0-mini",
    selectedModelName: "seedance-2.0-mini",
    options: {
      aspect_ratio: "16:9",
      duration: 5,
      resolution: "480p",
      quality: "",
      mode: "",
      effect: "",
    },
    uploads: {
      image_url: null,
      image_urls: [],
      end_image_url: null,
      video_url: null,
      video_name: null,
    },
    prompt: "",
  };
  const t2vModelList = modelsByMode?.t2v?.length ? modelsByMode.t2v : t2vModels;
  const i2vModelList = modelsByMode?.i2v?.length ? modelsByMode.i2v : i2vModels;
  const v2vModelList = modelsByMode?.v2v?.length ? modelsByMode.v2v : v2vModels;

  // ── mode state ──
  const [imageMode, setImageMode] = useState(false); // i2v
  const [v2vMode, setV2vMode] = useState(false);

  // ── model / params ──
  const defaultModel = t2vModelList[0] || t2vModels[0];
  const [selectedModel, setSelectedModel] = useState(defaultModel.id);
  const [selectedModelName, setSelectedModelName] = useState(defaultModel.name);
  const [selectedAr, setSelectedAr] = useState(
    defaultModel.inputs?.aspect_ratio?.default || "16:9",
  );
  const [selectedDuration, setSelectedDuration] = useState(
    defaultModel.inputs?.duration?.default || 5,
  );
  const [selectedResolution, setSelectedResolution] = useState(
    defaultModel.inputs?.resolution?.default || "",
  );
  const [selectedQuality, setSelectedQuality] = useState(
    defaultModel.inputs?.quality?.default || "",
  );
  const [selectedMode, setSelectedMode] = useState("");
  const [selectedEffect, setSelectedEffect] = useState("");

  // ── upload progress ──
  const [imageProgress, setImageProgress] = useState(0);
  const [videoProgress, setVideoProgress] = useState(0);

  // ── control visibility ──
  const [showAr, setShowAr] = useState(true);
  const [showDuration, setShowDuration] = useState(true);
  const [showResolution, setShowResolution] = useState(false);
  const [showQuality, setShowQuality] = useState(false);
  const [showMode, setShowMode] = useState(false);
  const [showEffect, setShowEffect] = useState(false);

  // ── uploads ──
  const [uploadedImageUrl, setUploadedImageUrl] = useState(null);
  const [uploadedImageUrls, setUploadedImageUrls] = useState([]);
  const [imageUploading, setImageUploading] = useState(false);
  const [uploadedEndImageUrl, setUploadedEndImageUrl] = useState(null);
  const [endImageUploading, setEndImageUploading] = useState(false);
  const [endImageProgress, setEndImageProgress] = useState(0);
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [uploadedVideoName, setUploadedVideoName] = useState(null);

  // ── generation / canvas ──
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(null);
  const [fullscreenUrl, setFullscreenUrl] = useState(null);
  const [canvasUrl, setCanvasUrl] = useState(null);
  const [canvasModel, setCanvasModel] = useState(null);
  const [showCanvas, setShowCanvas] = useState(false);
  const [lastGenerationId, setLastGenerationId] = useState(null);
  const [lastGenerationModel, setLastGenerationModel] = useState(null);

  // ── history ──
  const [localHistory, setLocalHistory] = useState([]);
  const [activeHistoryIdx, setActiveHistoryIdx] = useState(0);

  // ── dropdown ──
  const [openDropdown, setOpenDropdown] = useState(null); // 'model'|'ar'|'duration'|'resolution'|'quality'|'mode'|null

  // ── prompt ──
  const [prompt, setPrompt] = useState("");
  const [modelParams, setModelParams] = useState({});

  // ── refs ──
  const containerRef = useRef(null);
  const textareaRef = useRef(null);
  const dropdownRef = useRef(null);
  const imageFileInputRef = useRef(null);
  const endImageFileInputRef = useRef(null);
  const videoFileInputRef = useRef(null);
  const resultVideoRef = useRef(null);
  const hasRestored = useRef(false);
  const appliedProviderDefaultRef = useRef(new Set());
  const suppressProviderDefaultRef = useRef(false);
  const restoredPersistentModelRef = useRef(false);
  const restoredPersistentModelIdRef = useRef(null);
  const skipNextConfigSaveRef = useRef(false);

  // ── derived data ──
  const serverGen = useServerGenerations({ mediaType: "video", mode: ["t2v", "i2v", "v2v"] });
  const history = historyItems ?? (serverGen.active ? serverGen.items : localHistory);

  const getCurrentModels = useCallback(() => {
    if (v2vMode) return v2vModelList;
    return imageMode ? i2vModelList : t2vModelList;
  }, [imageMode, v2vMode, t2vModelList, i2vModelList, v2vModelList]);

  const currentProviderModels = v2vMode
    ? modelsByMode?.v2v
    : imageMode
      ? modelsByMode?.i2v
      : modelsByMode?.t2v;
  const hasProviderCatalog = provider === "muapi" || !!(
    modelsByMode?.t2v?.length ||
    modelsByMode?.i2v?.length ||
    modelsByMode?.v2v?.length
  );

  const getCurrentAspectRatios = useCallback(
    (id) => {
      const model = getCurrentModels().find((item) => item.id === id);
      const options = getInputOptions(model, "aspect_ratio");
      if (options.length > 0) return options;
      return imageMode
        ? getAspectRatiosForI2VModel(id)
        : getAspectRatiosForVideoModel(id);
    },
    [getCurrentModels, imageMode],
  );

  const getCurrentDurations = useCallback(
    (id) => {
      const model = getCurrentModels().find((item) => item.id === id);
      const options = getInputOptions(model, "duration");
      if (options.length > 0) return options;
      return imageMode ? getDurationsForI2VModel(id) : getDurationsForModel(id);
    },
    [getCurrentModels, imageMode],
  );

  const getCurrentResolutions = useCallback(
    (id) => {
      const model = getCurrentModels().find((item) => item.id === id);
      const options = getInputOptions(model, "resolution");
      if (options.length > 0) return options;
      return imageMode
        ? getResolutionsForI2VModel(id)
        : getResolutionsForVideoModel(id);
    },
    [getCurrentModels, imageMode],
  );

  const getCurrentEffects = useCallback(
    (id) => {
      const model = getCurrentModels().find((item) => item.id === id);
      const options = getInputOptions(model, "name");
      if (options.length > 0) return options;
      return imageMode ? getEffectsForI2VModel(id) : [];
    },
    [getCurrentModels, imageMode],
  );

  const getCurrentModel = useCallback(
    () => getCurrentModels().find((m) => m.id === selectedModel),
    [getCurrentModels, selectedModel],
  );

  useEffect(() => {
    const model = getCurrentModel();
    if (!model) return;
    setModelParams((previous) => createDefaultModelParams(model, previous));
  }, [getCurrentModel]);

  const getImageUploadTargetModel = useCallback(
    (modelId = selectedModel, isImageMode = imageMode, isV2vMode = v2vMode) => {
      if (isV2vMode) return v2vModelList.find((m) => m.id === modelId) || null;
      if (isImageMode) return i2vModelList.find((m) => m.id === modelId) || null;
      const currentT2V = t2vModelList.find((m) => m.id === modelId);
      return (
        i2vModelList.find((m) => m.id === modelId) ||
        (currentT2V?.family ? i2vModelList.find((m) => m.family === currentT2V.family) : null) ||
        null
      );
    },
    [selectedModel, imageMode, v2vMode, v2vModelList, i2vModelList, t2vModelList],
  );

  const isV2VImageSelection = useCallback(
    (modelId, isV2v) => {
      if (!isV2v) return false;
      const m = v2vModelList.find((x) => x.id === modelId);
      return modelAcceptsImageInput(m);
    },
    [v2vModelList],
  );

  // ── update controls when model/mode changes ──────────────────────────────
  const applyControlsForModel = useCallback(
    (modelId, isImageMode, isV2vMode) => {
      const modelList = isV2vMode
        ? v2vModelList
        : isImageMode
          ? i2vModelList
          : t2vModelList;
      const model = modelList.find((m) => m.id === modelId);

      const ars = getInputOptions(model, "aspect_ratio");
      if (ars.length > 0) {
        setSelectedAr(ars[0]);
        setShowAr(true);
      } else {
        setShowAr(false);
      }

      const durations = getInputOptions(model, "duration");
      if (durations.length > 0) {
        setSelectedDuration(durations[0]);
        setShowDuration(true);
      } else {
        setShowDuration(false);
      }

      const resolutions = getInputOptions(model, "resolution");
      if (resolutions.length > 0) {
        setSelectedResolution(resolutions[0]);
        setShowResolution(true);
      } else {
        setShowResolution(false);
      }

      const qualities = getQualitiesForModel(modelList, modelId);
      if (qualities.length > 0) {
        setSelectedQuality(model?.inputs?.quality?.default || qualities[0]);
        setShowQuality(true);
      } else {
        setSelectedQuality("");
        setShowQuality(false);
      }

      const modes = getInputOptions(model, "mode");
      if (modes.length > 0) {
        setSelectedMode(model?.inputs?.mode?.default || modes[0]);
        setShowMode(true);
      } else {
        setSelectedMode("");
        setShowMode(false);
      }

      const effects = getInputOptions(model, "name");
      if (effects.length > 0) {
        setSelectedEffect(model?.inputs?.name?.default || effects[0]);
        setShowEffect(true);
      } else {
        setSelectedEffect("");
        setShowEffect(false);
      }
    },
    [t2vModelList, i2vModelList, v2vModelList],
  );

  // ── Persistence: Load ────────────────────────────────────────────────────
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
      const restoredImageMode = data.imageMode !== undefined ? data.imageMode : imageMode;
      const restoredV2vMode = data.v2vMode !== undefined ? data.v2vMode : v2vMode;
      if (data.imageMode !== undefined) setImageMode(restoredImageMode);
      if (data.v2vMode !== undefined) setV2vMode(restoredV2vMode);
      const restoredModelId = data.selectedModelId || data.selectedModel;
      const restoredModels = restoredV2vMode ? v2vModelList : restoredImageMode ? i2vModelList : t2vModelList;
      const restoredModel = restoredModels.find((model) => model.id === restoredModelId);
      restoredPersistentModelRef.current = !!restoredModel;
      restoredPersistentModelIdRef.current = restoredModel ? restoredModel.id : null;
      if (restoredModelId) setSelectedModel(restoredModelId);
      if (restoredModelId || data.selectedModelName) {
        setSelectedModelName(restoredModel?.name || data.selectedModelName);
      }
      if (options.aspect_ratio || data.selectedAr) setSelectedAr(options.aspect_ratio || data.selectedAr);
      if (options.duration || data.selectedDuration) setSelectedDuration(options.duration || data.selectedDuration);
      if (options.resolution || data.selectedResolution) setSelectedResolution(options.resolution || data.selectedResolution);
      if (options.quality || data.selectedQuality) setSelectedQuality(options.quality || data.selectedQuality);
      if (options.mode || data.selectedMode) setSelectedMode(options.mode || data.selectedMode);
      if (options.effect || data.selectedEffect) setSelectedEffect(options.effect || data.selectedEffect);
      if (data.uploads?.image_url || data.uploadedImageUrl) setUploadedImageUrl(data.uploads?.image_url || data.uploadedImageUrl);
      if (data.uploads?.image_urls || data.uploadedImageUrls) {
        setUploadedImageUrls(data.uploads?.image_urls || data.uploadedImageUrls);
      } else if (data.uploads?.image_url || data.uploadedImageUrl) {
        setUploadedImageUrls([data.uploads?.image_url || data.uploadedImageUrl]);
      }
      if (data.uploads?.end_image_url || data.uploadedEndImageUrl) setUploadedEndImageUrl(data.uploads?.end_image_url || data.uploadedEndImageUrl);
      if (data.uploads?.video_url || data.uploadedVideoUrl) setUploadedVideoUrl(data.uploads?.video_url || data.uploadedVideoUrl);
      if (data.uploads?.video_name || data.uploadedVideoName) setUploadedVideoName(data.uploads?.video_name || data.uploadedVideoName);
      if (data.prompt) setPrompt(data.prompt);
      if (data.modelParams) setModelParams(data.modelParams);
      suppressProviderDefaultRef.current = true;

      // Update control visibility based on restored model/mode
      applyControlsForModel(
        restoredModelId || defaultModel.id,
        !!restoredImageMode,
        !!restoredV2vMode
      );
      if (options.aspect_ratio || data.selectedAr) setSelectedAr(options.aspect_ratio || data.selectedAr);
      if (options.duration || data.selectedDuration) setSelectedDuration(options.duration || data.selectedDuration);
      if (options.resolution || data.selectedResolution) setSelectedResolution(options.resolution || data.selectedResolution);
      if (options.quality || data.selectedQuality) setSelectedQuality(options.quality || data.selectedQuality);
      if (options.mode || data.selectedMode) setSelectedMode(options.mode || data.selectedMode);
      if (options.effect || data.selectedEffect) setSelectedEffect(options.effect || data.selectedEffect);
    } catch (err) {
      console.warn("Failed to load VideoStudio persistence:", err);
    } finally {
      hasRestored.current = true;
    }
  }, [modelsByMode, hasProviderCatalog, applyControlsForModel, defaultModel.id, provider, imageMode, v2vMode]);

  useEffect(() => {
    if (uploadedImageUrls.length === 0) {
      if (uploadedImageUrl) setUploadedImageUrl(null);
      return;
    }
    if (uploadedImageUrl !== uploadedImageUrls[0]) {
      setUploadedImageUrl(uploadedImageUrls[0]);
    }
  }, [uploadedImageUrls, uploadedImageUrl]);

  // ── Adjust height on load ────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      if (textareaRef.current) {
        const el = textareaRef.current;
        el.style.height = "auto";
        const maxH = window.innerWidth < 768 ? 150 : 250;
        el.style.height = Math.min(el.scrollHeight, maxH) + "px";
      }
    }, 150);
    return () => clearTimeout(timer);
  }, []);

  // ── Persistence: Save ────────────────────────────────────────────────────
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        if (!modelsByMode || !hasProviderCatalog || !hasRestored.current) return;
        if (!getCurrentModels().some((model) => model.id === selectedModel)) return;
        if (skipNextConfigSaveRef.current) {
          skipNextConfigSaveRef.current = false;
          return;
        }
        const state = {
          version: 1,
          provider,
          imageMode,
          v2vMode,
          selectedModelId: selectedModel,
          selectedModelName,
          options: {
            aspect_ratio: selectedAr,
            duration: selectedDuration,
            resolution: selectedResolution,
            quality: selectedQuality,
            mode: selectedMode,
            effect: selectedEffect,
          },
          uploads: {
            image_url: uploadedImageUrl,
            image_urls: uploadedImageUrls,
            end_image_url: uploadedEndImageUrl,
            video_url: uploadedVideoUrl,
            video_name: uploadedVideoName,
          },
          prompt,
          modelParams,
          // Phase 5: results live server-side when active — persist prefs only.
        };
        localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
      } catch (err) {
        console.warn("Failed to save VideoStudio persistence:", err);
      }
    }, 500); // 500ms debounce
    return () => clearTimeout(timer);
  }, [
    imageMode,
    v2vMode,
    selectedModel,
    selectedModelName,
    selectedAr,
    selectedDuration,
    selectedResolution,
    selectedQuality,
    selectedMode,
    selectedEffect,
    uploadedImageUrl,
    uploadedImageUrls,
    uploadedEndImageUrl,
    uploadedVideoUrl,
    uploadedVideoName,
    prompt,
    modelParams,
    modelsByMode,
    hasProviderCatalog,
    getCurrentModels,
    provider,
  ]);

  // ── Derived UI values ────────────────────────────────────────────────────

  const processImageFiles = useCallback(async (filesInput) => {
    const files = Array.from(filesInput || []).filter(Boolean);
    if (files.length === 0) return;

    const tooLarge = files.filter((file) => file.size > 10 * 1024 * 1024);
    if (tooLarge.length > 0) {
      alert("Image exceeds 10MB limit.");
      return;
    }

    const targetModel = getImageUploadTargetModel();
    if (!modelAcceptsImageInput(targetModel)) {
      alert("The selected model does not accept reference images.");
      return;
    }
    const maxImgs = maxImagesForI2VModel(targetModel);
    const toUpload = files.slice(0, Math.max(1, maxImgs - uploadedImageUrls.length));

    setImageUploading(true);
    setImageProgress(0);
    try {
      const urls = await Promise.all(
        toUpload.map((file) => uploadFile(apiKey, file, (pct) => setImageProgress(pct))),
      );

      if (isV2VImageSelection(selectedModel, v2vMode)) {
        const nextUrls = [...uploadedImageUrls, ...urls].slice(0, maxImgs);
        setUploadedImageUrl(nextUrls[0] || null);
        setUploadedImageUrls(nextUrls);
      } else {
        setUploadedVideoUrl(null);
        setUploadedVideoName(null);
        setV2vMode(false);

        if (!imageMode) {
          suppressProviderDefaultRef.current = true;
          setImageMode(true);
          setSelectedModel(targetModel.id);
          setSelectedModelName(targetModel.name);
          applyControlsForModel(targetModel.id, true, false);
        }

        const nextUrls = maxImgs > 1 ? [...uploadedImageUrls, ...urls].slice(0, maxImgs) : [urls[0]];
        setUploadedImageUrl(nextUrls[0] || null);
        setUploadedImageUrls(nextUrls);
      }
    } catch (err) {
      alert(`Image upload failed: ${err.message}`);
    } finally {
      setImageUploading(false);
      setImageProgress(0);
    }
  }, [
    apiKey,
    getImageUploadTargetModel,
    uploadedImageUrls,
    selectedModel,
    v2vMode,
    imageMode,
    isV2VImageSelection,
    applyControlsForModel,
  ]);

  const processDroppedVideo = async (file) => {
    if (file.size > 50 * 1024 * 1024) {
      alert("Video exceeds 50MB limit.");
      return;
    }
    setVideoUploading(true);
    setVideoProgress(0);
    try {
      const url = await uploadFile(apiKey, file, (pct) => {
        setVideoProgress(pct);
      });
      setUploadedVideoUrl(url);
      setUploadedVideoName(file.name);
      if (imageMode) {
        setUploadedImageUrl(null);
        setUploadedImageUrls([]);
        suppressProviderDefaultRef.current = true;
        setImageMode(false);
      }
      suppressProviderDefaultRef.current = true;
      setV2vMode(true);
      const selectedV2V = v2vModelList.find((m) => m.id === selectedModel);
      const target = selectedV2V || v2vModelList[0] || v2vModels[0];
      setSelectedModel(target.id);
      setSelectedModelName(target.name);
      applyControlsForModel(target.id, false, true);
    } catch (err) {
      alert(`Video upload failed: ${err.message}`);
    } finally {
      setVideoUploading(false);
      setVideoProgress(0);
    }
  };

  // ── Handle Dropped Files ────────────────────────────────────────────────
  useEffect(() => {
    if (droppedFiles && droppedFiles.length > 0) {
      const imageFiles = droppedFiles.filter(f => f.type.startsWith('image/'));
      const videoFiles = droppedFiles.filter(f => f.type.startsWith('video/'));
      
      if (videoFiles.length > 0) {
        processDroppedVideo(videoFiles[0]);
      } else if (imageFiles.length > 0) {
        processImageFiles(imageFiles);
      }
      onFilesHandled?.();
    }
  }, [droppedFiles, onFilesHandled, processImageFiles, processDroppedVideo]);

  // Initialise controls for default model on mount
  useEffect(() => {
    if (hasRestored.current) return;
    applyControlsForModel(defaultModel.id, false, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── close dropdown on outside click ─────────────────────────────────────
  useEffect(() => {
    if (!openDropdown) return;
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpenDropdown(null);
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [openDropdown]);

  // ── textarea auto-resize ──────────────────────────────────────────────────
  const handlePromptInput = (e) => {
    setPrompt(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    const maxH = window.innerWidth < 768 ? 150 : 250;
    el.style.height = Math.min(el.scrollHeight, maxH) + "px";
  };

  // ── image upload ─────────────────────────────────────────────────────────
  const handleImageFileChange = async (e) => {
    await processImageFiles(e.target.files);
    if (imageFileInputRef.current) imageFileInputRef.current.value = "";
  };

  const clearImageUpload = () => {
    setUploadedImageUrl(null);
    setUploadedImageUrls([]);
    setUploadedEndImageUrl(null);
    // Motion-control v2v: keep model and video; just drop the image
    if (isV2VImageSelection(selectedModel, v2vMode)) return;
    const currentI2V = i2vModelList.find((m) => m.id === selectedModel);
    const target =
      t2vModelList.find((m) => m.id === selectedModel) ||
      (currentI2V?.family ? t2vModelList.find((m) => m.family === currentI2V.family) : null) ||
      t2vModelList[0] ||
      t2vModels[0];
    suppressProviderDefaultRef.current = true;
    setImageMode(false);
    setSelectedModel(target.id);
    setSelectedModelName(target.name);
    applyControlsForModel(target.id, false, false);
  };

  const removeImageAtIndex = (idx) => {
    const nextUrls = uploadedImageUrls.filter((_, i) => i !== idx);
    setUploadedImageUrls(nextUrls);
    if (nextUrls.length === 0) {
      setUploadedImageUrl(null);
      // Reset to text-to-video if empty list
      if (isV2VImageSelection(selectedModel, v2vMode)) return;
      const currentI2V = i2vModelList.find((m) => m.id === selectedModel);
      const target =
        t2vModelList.find((m) => m.id === selectedModel) ||
        (currentI2V?.family ? t2vModelList.find((m) => m.family === currentI2V.family) : null) ||
        t2vModelList[0] ||
        t2vModels[0];
      suppressProviderDefaultRef.current = true;
      setImageMode(false);
      setSelectedModel(target.id);
      setSelectedModelName(target.name);
      applyControlsForModel(target.id, false, false);
    } else {
      setUploadedImageUrl(nextUrls[0]);
    }
  };

  // ── end-frame upload (FLF i2v models) ──────────────────────────────────────
  const handleEndImageFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      alert("Image exceeds 10MB limit.");
      return;
    }
    setEndImageUploading(true);
    setEndImageProgress(0);
    try {
      const url = await uploadFile(apiKey, file, (pct) => {
        setEndImageProgress(pct);
      });
      setUploadedEndImageUrl(url);
    } catch (err) {
      alert(`End frame upload failed: ${err.message}`);
    } finally {
      setEndImageUploading(false);
      setEndImageProgress(0);
      if (endImageFileInputRef.current) endImageFileInputRef.current.value = "";
    }
  };

  const clearEndImage = () => setUploadedEndImageUrl(null);

  // ── video upload ─────────────────────────────────────────────────────────
  const handleVideoFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      alert("Video exceeds 50MB limit.");
      return;
    }
    setVideoUploading(true);
    setVideoProgress(0);
    try {
      const url = await uploadFile(apiKey, file, (pct) => {
        setVideoProgress(pct);
      });
      setUploadedVideoUrl(url);
      setUploadedVideoName(file.name);

      if (isV2VImageSelection(selectedModel, v2vMode)) {
        // Already using a V2V model that also accepts images — keep both inputs.
      } else {
        // Default v2v flow (e.g. watermark remover) — auto-pick the first v2v model
        if (imageMode) {
          setUploadedImageUrl(null);
          setUploadedImageUrls([]);
          suppressProviderDefaultRef.current = true;
          setImageMode(false);
        }
        suppressProviderDefaultRef.current = true;
        setV2vMode(true);
        const selectedV2V = v2vModelList.find((m) => m.id === selectedModel);
        const target = selectedV2V || v2vModelList[0] || v2vModels[0];
        setSelectedModel(target.id);
        setSelectedModelName(target.name);
        applyControlsForModel(target.id, false, true);
      }
    } catch (err) {
      console.error("[VideoStudio] Video upload failed:", err);
      alert(`Video upload failed: ${err.message}`);
    } finally {
      setVideoUploading(false);
      setVideoProgress(0);
      if (videoFileInputRef.current) videoFileInputRef.current.value = "";
    }
  };

  const clearVideoUpload = () => {
    setUploadedVideoUrl(null);
    setUploadedVideoName(null);
    const currentV2V = v2vModelList.find((m) => m.id === selectedModel);
    const target =
      t2vModelList.find((m) => m.id === selectedModel) ||
      (currentV2V?.family ? t2vModelList.find((m) => m.family === currentV2V.family) : null) ||
      t2vModelList[0] ||
      t2vModels[0];
    suppressProviderDefaultRef.current = true;
    setV2vMode(false);
    setSelectedModel(target.id);
    setSelectedModelName(target.name);
    applyControlsForModel(target.id, false, false);
  };

  // ── model selection from dropdown ─────────────────────────────────────────
  const handleModelSelect = useCallback(
    (m, isV2V) => {
      restoredPersistentModelRef.current = false;
      restoredPersistentModelIdRef.current = null;
      if (isV2V) {
        setV2vMode(true);
        setImageMode(false);
        const acceptsImage = modelAcceptsImageInput(m);
        if (!acceptsImage) {
          // Single-input v2v (watermark remover etc.) — drop any image
          setUploadedImageUrl(null);
          setUploadedImageUrls([]);
        }
        setSelectedModel(m.id);
        setSelectedModelName(m.name);
        applyControlsForModel(m.id, false, true);
      } else {
        if (v2vMode) {
          setV2vMode(false);
          setUploadedVideoUrl(null);
          setUploadedVideoName(null);
        }
        setSelectedModel(m.id);
        setSelectedModelName(m.name);
        applyControlsForModel(m.id, imageMode, false);
      }
    },
    [v2vMode, imageMode, applyControlsForModel],
  );

  // ── add to local history ──────────────────────────────────────────────────
  const addToLocalHistory = useCallback((entry) => {
    setLocalHistory((prev) => [entry, ...prev].slice(0, 30));
    setActiveHistoryIdx(0);
  }, []);

  // ── show result in canvas ─────────────────────────────────────────────────
  const showVideoInCanvas = useCallback((url, model) => {
    setCanvasUrl(url);
    setCanvasModel(model);
    setShowCanvas(true);
  }, []);

  // ── generate ──────────────────────────────────────────────────────────────
  // ── Reuse a past generation's settings back into the form ────────────────
  const handleReuse = useCallback((entry) => {
    const p = entry.params || {};
    const isV2V = entry.mode === "v2v";
    const isI2V = entry.mode === "i2v";
    setV2vMode(isV2V);
    setImageMode(isI2V);
    setSelectedModel(entry.model);
    setPrompt(p.prompt || entry.prompt || "");
    if (p.aspect_ratio) setSelectedAr(p.aspect_ratio);
    if (p.duration != null) setSelectedDuration(p.duration);
    if (p.resolution) setSelectedResolution(p.resolution);
    if (p.quality) setSelectedQuality(p.quality);
    if (p.mode) setSelectedMode(p.mode);
    if (p.name) setSelectedEffect(p.name);
    if (isV2V) {
      setUploadedVideoUrl(p.video_url || null);
      setUploadedImageUrl(p.image_url || null);
    } else if (isI2V) {
      if (Array.isArray(p.images_list) && p.images_list.length > 0) {
        setUploadedImageUrls(p.images_list);
        setUploadedImageUrl(p.images_list[0] || null);
      } else if (p.image_url) {
        setUploadedImageUrl(p.image_url);
        setUploadedImageUrls([p.image_url]);
      }
      if (p.last_image) setUploadedEndImageUrl(p.last_image);
    }
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, []);

  const handleGenerate = useCallback(async () => {
    const currentModel = getCurrentModel();
    const isExtendMode = currentModel?.requiresRequestId;
    const trimmedPrompt = prompt.trim();
    const requestParams = { ...modelParams };
    if (modelAcceptsPrompt(currentModel)) requestParams.prompt = trimmedPrompt;
    if (currentModel?.inputs?.aspect_ratio) requestParams.aspect_ratio = selectedAr;
    if (currentModel?.inputs?.duration) requestParams.duration = selectedDuration;
    if (currentModel?.inputs?.resolution) requestParams.resolution = selectedResolution;
    if (currentModel?.inputs?.quality) requestParams.quality = selectedQuality;
    if (currentModel?.inputs?.mode) requestParams.mode = selectedMode;
    if (currentModel?.inputs?.name) requestParams.name = selectedEffect;
    if (uploadedImageUrls.length > 0) requestParams.images_list = uploadedImageUrls;
    else if (uploadedImageUrl) requestParams.image_url = uploadedImageUrl;
    if (uploadedEndImageUrl) requestParams.last_image = uploadedEndImageUrl;
    if (uploadedVideoUrl) requestParams.video_url = uploadedVideoUrl;
    const compactRequestParams = compactParams(requestParams);

    const missingRequired = (currentModel?.required || []).find((name) => {
      const value = compactRequestParams[name];
      return value === undefined || (Array.isArray(value) && value.length === 0);
    });
    if (missingRequired) {
      const label = currentModel.inputs?.[missingRequired]?.title || missingRequired;
      alert(`Please provide ${label}.`);
      return;
    }

    if (v2vMode) {
      const hasVideo = uploadedVideoUrl || Object.entries(currentModel?.inputs || {}).some(
        ([name, schema]) => {
          const isVideo = schema?.mediaKind === "video" || schema?.field === "video" || schema?.field === "videos_list";
          const value = compactRequestParams[name];
          return isVideo && (Array.isArray(value) ? value.length > 0 : Boolean(value));
        },
      );
      if (!hasVideo) {
        alert("Please upload a video first.");
        return;
      }
      const hasImage = uploadedImageUrl || uploadedImageUrls.length > 0 || Object.entries(currentModel?.inputs || {}).some(
        ([name, schema]) => {
          const isImage = schema?.mediaKind === "image" || schema?.field === "image" || schema?.field === "images_list";
          const value = compactRequestParams[name];
          return isImage && (Array.isArray(value) ? value.length > 0 : Boolean(value));
        },
      );
      if (modelRequiresImageInput(currentModel) && !hasImage) {
        alert("Please upload a reference image for motion control.");
        return;
      }
      if (currentModel?.promptRequired && !trimmedPrompt) {
        alert("Please describe the motion you want.");
        return;
      }
    } else if (isExtendMode) {
      if (!lastGenerationId) {
        alert(
          "No Seedance 2.0 generation found to extend. Generate a video first.",
        );
        return;
      }
    } else if (imageMode) {
      const hasImage = uploadedImageUrl || uploadedImageUrls.length > 0 || Object.entries(currentModel?.inputs || {}).some(
        ([name, schema]) => {
          const isImage = schema?.mediaKind === "image" || schema?.field === "image" || schema?.field === "images_list";
          const value = compactRequestParams[name];
          return isImage && (Array.isArray(value) ? value.length > 0 : Boolean(value));
        },
      );
      if (!hasImage) {
        alert("Please upload at least one image first.");
        return;
      }
    } else {
      if (modelAcceptsPrompt(currentModel) && currentModel?.promptRequired !== false && !trimmedPrompt) {
        alert("Please enter a prompt to generate a video.");
        return;
      }
    }

    setGenerating(true);
    setGenerateError(null);

    let hadError = false;

    try {
      // ── Server-persisted async path (skips seedance extend chaining) ──────
      if (serverGen.active && !isExtendMode) {
        const mode = v2vMode ? "v2v" : imageMode ? "i2v" : "t2v";
        await serverGen.generate({ mode, model: selectedModel, params: compactRequestParams, count: 1 });
        setActiveHistoryIdx(0);
        return;
      }

      let res;

      if (v2vMode) {
        // V2V: keep every supported model control alongside the video input.
        const v2vParams = {
          model: selectedModel,
          ...compactRequestParams,
          inputSchema: currentModel?.inputs,
        };
        res = await processV2V(apiKey, v2vParams);
        if (!res?.url) throw new Error("No video URL returned by API");

        const genId = res.id || Date.now().toString();
        setLastGenerationId(null);
        setLastGenerationModel(null);
        const entry = {
          id: genId,
          url: res.url,
          prompt: modelAcceptsPrompt(currentModel) ? trimmedPrompt : "",
          model: selectedModel,
          timestamp: new Date().toISOString(),
        };
        addToLocalHistory(entry);
        showVideoInCanvas(res.url, selectedModel);
        if (onGenerationComplete)
          onGenerationComplete({
            url: res.url,
            model: selectedModel,
            prompt: modelAcceptsPrompt(currentModel) ? trimmedPrompt : "",
            type: "video",
          });
      } else if (imageMode) {
        const maxImgs = maxImagesForI2VModel(currentModel);
        const i2vParams = { model: selectedModel, ...compactRequestParams, inputSchema: currentModel?.inputs };
        if (maxImgs > 1) {
          i2vParams.images_list = uploadedImageUrls;
        } else {
          i2vParams.image_url = uploadedImageUrl;
        }
        if (trimmedPrompt) i2vParams.prompt = trimmedPrompt;
        i2vParams.aspect_ratio = selectedAr;
        const i2vModel = i2vModelList.find((m) => m.id === selectedModel) || i2vModels.find((m) => m.id === selectedModel);
        if (uploadedEndImageUrl && i2vModel?.lastImageField) {
          i2vParams.last_image = uploadedEndImageUrl;
        }
        const durations = getDurationsForI2VModel(selectedModel);
        if (durations.length > 0) i2vParams.duration = selectedDuration;
        const resolutions = getResolutionsForI2VModel(selectedModel);
        if (resolutions.length > 0) i2vParams.resolution = selectedResolution;
        if (selectedQuality) i2vParams.quality = selectedQuality;
        if (selectedMode) i2vParams.mode = selectedMode;
        if (showEffect && selectedEffect) i2vParams.name = selectedEffect;

        res = await generateI2V(apiKey, i2vParams);
        if (!res?.url) throw new Error("No video URL returned by API");

        const genId = res.id || Date.now().toString();
        if (selectedModel === "seedance-v2.0-i2v") {
          setLastGenerationId(genId);
          setLastGenerationModel(selectedModel);
        } else {
          setLastGenerationId(null);
          setLastGenerationModel(null);
        }
        const entry = {
          id: genId,
          url: res.url,
          prompt: trimmedPrompt,
          model: selectedModel,
          aspect_ratio: selectedAr,
          duration: selectedDuration,
          timestamp: new Date().toISOString(),
        };
        addToLocalHistory(entry);
        showVideoInCanvas(res.url, selectedModel);
        if (onGenerationComplete)
          onGenerationComplete({
            url: res.url,
            model: selectedModel,
            prompt: trimmedPrompt,
            type: "video",
          });
      } else {
        // T2V (including extend mode)
        const params = { model: selectedModel, ...compactRequestParams, inputSchema: currentModel?.inputs };
        if (trimmedPrompt) params.prompt = trimmedPrompt;

        if (isExtendMode) {
          params.request_id = lastGenerationId;
        } else {
          params.aspect_ratio = selectedAr;
        }

        const durations = getDurationsForModel(selectedModel);
        if (durations.length > 0) params.duration = selectedDuration;
        const resolutions = getResolutionsForVideoModel(selectedModel);
        if (resolutions.length > 0) params.resolution = selectedResolution;
        if (selectedQuality) params.quality = selectedQuality;
        if (selectedMode) params.mode = selectedMode;

        res = await generateVideo(apiKey, params);
        if (!res?.url) throw new Error("No video URL returned by API");

        const genId = res.id || Date.now().toString();
        if (
          selectedModel === "seedance-v2.0-t2v" ||
          selectedModel === "seedance-v2.0-i2v"
        ) {
          setLastGenerationId(genId);
          setLastGenerationModel(selectedModel);
        } else {
          setLastGenerationId(null);
          setLastGenerationModel(null);
        }
        const entry = {
          id: genId,
          url: res.url,
          prompt: trimmedPrompt,
          model: selectedModel,
          aspect_ratio: selectedAr,
          duration: selectedDuration,
          timestamp: new Date().toISOString(),
        };
        addToLocalHistory(entry);
        showVideoInCanvas(res.url, selectedModel);
        if (onGenerationComplete)
          onGenerationComplete({
            url: res.url,
            model: selectedModel,
            prompt: trimmedPrompt,
            type: "video",
          });
      }
    } catch (e) {
      hadError = true;
      console.error("[VideoStudio]", e);
      setGenerateError(e.message?.slice(0, 80) || "Generation failed");
      setTimeout(() => setGenerateError(null), 4000);
    } finally {
      setGenerating(false);
    }
  }, [
    apiKey,
    prompt,
    modelParams,
    v2vMode,
    imageMode,
    selectedModel,
    selectedAr,
    selectedDuration,
    selectedResolution,
    selectedQuality,
    selectedMode,
    selectedEffect,
    showEffect,
    uploadedImageUrl,
    uploadedImageUrls,
    uploadedEndImageUrl,
    uploadedVideoUrl,
    lastGenerationId,
    getCurrentModel,
    addToLocalHistory,
    showVideoInCanvas,
    onGenerationComplete,
  ]);

  // ── reset to prompt bar ───────────────────────────────────────────────────
  const resetToPromptBar = useCallback(() => {
    setShowCanvas(false);
  }, []);

  const handleNewPrompt = useCallback(() => {
    resetToPromptBar();
    setPrompt("");
    setUploadedImageUrl(null);
    setUploadedImageUrls([]);
    setImageMode(false);
    setUploadedVideoUrl(null);
    setUploadedVideoName(null);
    setV2vMode(false);
    const first = t2vModelList[0] || t2vModels[0];
    setSelectedModel(first.id);
    setSelectedModelName(first.name);
    applyControlsForModel(first.id, false, false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [resetToPromptBar, applyControlsForModel, t2vModelList]);

  const handleExtend = useCallback(() => {
    if (!lastGenerationId) return;
    resetToPromptBar();
    setPrompt("");
    setUploadedImageUrl(null);
    setUploadedImageUrls([]);
    setImageMode(false);
    setSelectedModel("seedance-v2.0-extend");
    setSelectedModelName("Seedance 2.0 Extend");
    applyControlsForModel("seedance-v2.0-extend", false, false);
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [lastGenerationId, resetToPromptBar, applyControlsForModel]);

  // ── derived UI values ────────────────────────────────────────────────────
  const isSeedance2Canvas =
    canvasModel === "seedance-v2.0-t2v" || canvasModel === "seedance-v2.0-i2v";
  const currentModelObj = getCurrentModel();
  const isExtendMode = currentModelObj?.requiresRequestId;
  const promptDisabled = currentModelObj ? !modelAcceptsPrompt(currentModelObj) : false;
  const dynamicInputValues = {
    ...modelParams,
    ...(currentModelObj?.inputs?.prompt ? { prompt } : {}),
    ...(currentModelObj?.inputs?.aspect_ratio ? { aspect_ratio: selectedAr } : {}),
    ...(currentModelObj?.inputs?.duration ? { duration: selectedDuration } : {}),
    ...(currentModelObj?.inputs?.resolution ? { resolution: selectedResolution } : {}),
    ...(currentModelObj?.inputs?.quality ? { quality: selectedQuality } : {}),
    ...(currentModelObj?.inputs?.mode ? { mode: selectedMode } : {}),
    ...(currentModelObj?.inputs?.name ? { name: selectedEffect } : {}),
  };
  const handleDynamicInputsChange = (next) => {
    setModelParams(next);
    if (next.prompt !== undefined) setPrompt(next.prompt);
    if (next.aspect_ratio !== undefined) setSelectedAr(next.aspect_ratio);
    if (next.duration !== undefined) setSelectedDuration(next.duration);
    if (next.resolution !== undefined) setSelectedResolution(next.resolution);
    if (next.quality !== undefined) setSelectedQuality(next.quality);
    if (next.mode !== undefined) setSelectedMode(next.mode);
    if (next.name !== undefined) setSelectedEffect(next.name);
  };
  const imageUploadTargetModel = getImageUploadTargetModel();
  const canUploadImages = modelAcceptsImageInput(imageUploadTargetModel);
  const imageUploadMaxImages = canUploadImages ? maxImagesForI2VModel(imageUploadTargetModel) : 0;
  const isMultiImageUpload = imageUploadMaxImages > 1;

  useEffect(() => {
    if (!modelsByMode || !hasProviderCatalog) return;
    if (currentModelObj) return;
    if (restoredPersistentModelIdRef.current) return;
    const fallback = getCurrentModels()[0] || defaultModel;
    if (!fallback) return;
    restoredPersistentModelRef.current = false;
    restoredPersistentModelIdRef.current = null;
    setSelectedModel(fallback.id);
    setSelectedModelName(fallback.name);
    applyControlsForModel(fallback.id, imageMode, v2vMode);
  }, [modelsByMode, hasProviderCatalog, currentModelObj, getCurrentModels, defaultModel, applyControlsForModel, imageMode, v2vMode]);

  useEffect(() => {
    if (!currentProviderModels?.length) return;
    if (restoredPersistentModelIdRef.current) return;
    if (restoredPersistentModelRef.current && getCurrentModels().some((model) => model.id === selectedModel)) return;
    if (suppressProviderDefaultRef.current) {
      suppressProviderDefaultRef.current = false;
      return;
    }
    const first = currentProviderModels[0];
    const modeKey = v2vMode ? "v2v" : imageMode ? "i2v" : "t2v";
    const key = `${modeKey}:${first.provider || "muapi"}:${first.id}`;
    if (appliedProviderDefaultRef.current.has(key)) return;
    appliedProviderDefaultRef.current.add(key);
    setSelectedModel(first.id);
    setSelectedModelName(first.name);
    applyControlsForModel(first.id, imageMode, v2vMode);
  }, [currentProviderModels, imageMode, v2vMode, applyControlsForModel, getCurrentModels, selectedModel]);

  const promptPlaceholder = v2vMode
    ? modelAcceptsPrompt(currentModelObj)
      ? currentModelObj?.promptRequired
        ? "Describe how to use or transform the video"
        : "Describe how to use or transform the video (optional)"
      : "This model does not accept a prompt"
    : imageMode
      ? "Describe the motion or effect (optional)"
      : isExtendMode
        ? "Optional: describe how to continue the video..."
        : "Describe the video you want to create";

  const toggleDropdown = (type) => (e) => {
    e.stopPropagation();
    setOpenDropdown((prev) => (prev === type ? null : type));
  };

  // ── render ────────────────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="w-full h-full flex flex-col items-center justify-center bg-app-bg relative overflow-hidden"
    >
      {/* ── CENTRAL GALLERY AREA ── */}
      <div className="flex-1 w-full max-w-7xl mx-auto overflow-y-auto custom-scrollbar pb-40 lg:pb-32 px-2">
        {serverGen.active && serverGen.loading && history.length === 0 ? (
          <StudioHistoryLoading label="Loading your videos" />
        ) : history.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 w-full pt-4 animate-fade-in-up">
            {history.map((entry, idx) => {
              const isSeedance2 = entry.model === "seedance-v2.0-t2v" || entry.model === "seedance-v2.0-i2v";
              return (
                <div
                  key={entry.id || idx}
                  className="relative group rounded-lg overflow-hidden border border-white/10 bg-[#0a0a0a] shadow-xl hover:border-primary/50 transition-all duration-300 flex flex-col"
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

                  {/* Loading / error placeholders for async generations */}
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
                        downloadFile(entry.url, `video-${entry.id || idx}.mp4`);
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
                    {isSeedance2 && (
                      <button
                        type="button"
                        title="Extend this video using Seedance 2.0 Extend"
                        onClick={(e) => {
                          e.stopPropagation();
                          setLastGenerationId(entry.id);
                          handleExtend();
                        }}
                        className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-primary hover:text-black transition-all border border-white/10"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 12h14M12 5l7 7-7 7" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* Prompt & Details */}
                  <div className="p-3 bg-black/80 backdrop-blur-sm border-t border-white/5 flex-1 flex flex-col justify-between gap-2">
                    <p className="text-white/70 text-xs line-clamp-3 leading-relaxed" title={entry.prompt}>
                      {entry.prompt || "No prompt provided"}
                    </p>
                    <div className="flex items-center justify-between mt-1 flex-wrap gap-1">
                      <span className="text-[10px] font-bold text-primary px-2 py-0.5 bg-primary/10 rounded border border-primary/20 whitespace-nowrap">
                        {entry.model?.replace("-", " ")}
                      </span>
                      <div className="flex gap-2">
                        {entry.resolution && (
                          <span className="text-[10px] text-white/40">{entry.resolution}</span>
                        )}
                        {entry.duration && (
                          <span className="text-[10px] text-white/40">{entry.duration}s</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full animate-fade-in-up transition-all duration-700 min-h-[50vh]">
            <div className="mb-12 relative group">
              <div className="absolute inset-0 bg-primary/10 blur-[120px] rounded-full opacity-30 group-hover:opacity-60 transition-opacity duration-1000" />
              <div className="relative w-24 h-24 md:w-32 md:h-32 bg-white/[0.02] rounded-[2rem] flex items-center justify-center border border-white/[0.05] overflow-hidden backdrop-blur-sm">
                <div className="w-16 h-16 bg-primary/5 rounded-2xl flex items-center justify-center border border-primary/10 relative z-10 transition-transform duration-500 group-hover:scale-110">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary opacity-80">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                </div>
                <div className="absolute top-4 right-4 text-[10px] text-primary/40 animate-pulse">✨</div>
              </div>
            </div>
            <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold text-white tracking-tight mb-4 text-center px-4">
              <span className="text-white/40 font-medium">START CREATING WITH</span><br />
              <span className="text-white">VIDEO STUDIO</span>
            </h1>
            <p className="text-white/40 text-sm md:text-base font-medium tracking-wide text-center max-w-lg leading-relaxed">
              Animate images into stunning AI videos with motion effects
            </p>
          </div>
        )}
      </div>

      {/* ── BOTTOM PROMPT BAR ── */}
      <div className="absolute bottom-4 w-full max-w-[95%] lg:max-w-4xl z-40 animate-fade-in-up" style={{ animationDelay: "0.2s" }}>
        <div className="w-full bg-[#0a0a0a]/80 backdrop-blur-3xl rounded-md border border-white/10 p-4 flex flex-col gap-2 shadow-2xl">
          <DynamicModelInputsPanel
            model={currentModelObj}
            values={dynamicInputValues}
            onChange={handleDynamicInputsChange}
            apiKey={apiKey}
            exclude={["prompt"]}
          />
          <div className="flex items-center gap-2 px-1">
            <div className="hidden">
            {/* Image upload button / thumbnails */}
            {canUploadImages && imageMode && isMultiImageUpload ? (
              <div className="flex items-center gap-2 flex-wrap">
                {uploadedImageUrls.map((url, idx) => (
                  <div key={idx} className="relative w-10 h-10 shrink-0 rounded-full border border-primary/60 bg-primary/5 overflow-hidden group">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImageAtIndex(idx)}
                      className="absolute inset-0 bg-black/75 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-xs font-black transition-opacity"
                      title="Remove image"
                    >
                      ✕
                    </button>
                    <span className="absolute bottom-0.5 right-0.5 px-1 h-3.5 bg-black/60 rounded-full text-[8px] font-black text-primary leading-none flex items-center justify-center pointer-events-none">
                      {idx + 1}
                    </span>
                  </div>
                ))}
                {uploadedImageUrls.length < imageUploadMaxImages && (
                  <div className="relative">
                    <input
                      ref={imageFileInputRef}
                      type="file"
                      accept="image/*"
                      multiple={isMultiImageUpload}
                      className="hidden"
                      onChange={handleImageFileChange}
                    />
                    <button
                      type="button"
                      title="Upload reference image"
                      onClick={() => imageFileInputRef.current?.click()}
                      className="w-10 h-10 shrink-0 rounded-full border transition-all flex items-center justify-center bg-white/5 border-white/[0.03] hover:bg-white/10 hover:border-primary/40 relative overflow-hidden group"
                    >
                      {imageUploading ? (
                        <div className="flex flex-col items-center justify-center w-full h-full absolute inset-0 bg-black/80 z-20 backdrop-blur-[2px]">
                          <svg className="w-8 h-8 -rotate-90">
                            <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" fill="transparent" className="text-white/10" />
                            <circle
                              cx="16"
                              cy="16"
                              r="14"
                              stroke="currentColor"
                              strokeWidth="2"
                              fill="transparent"
                              strokeDasharray={88}
                              strokeDashoffset={88 - (88 * imageProgress) / 100}
                              className="text-primary transition-all duration-300"
                            />
                          </svg>
                          <span className="absolute text-[9px] font-black text-primary leading-none">{imageProgress}%</span>
                        </div>
                      ) : uploadedImageUrls.length > 0 ? (
                        <div className="flex flex-col items-center justify-center leading-none">
                          <span className="text-xs font-black text-primary">{uploadedImageUrls.length}</span>
                          <span className="mt-0.5 text-[8px] font-bold text-white/45">/{imageUploadMaxImages}</span>
                        </div>
                      ) : (
                        <span className="text-lg font-bold text-white/40 group-hover:text-primary transition-colors">+</span>
                      )}
                    </button>
                  </div>
                )}
              </div>
            ) : canUploadImages ? (
              <div className="relative">
                <input
                  ref={imageFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple={isMultiImageUpload}
                  className="hidden"
                  onChange={handleImageFileChange}
                />
                <button
                  type="button"
                  title={
                    uploadedImageUrl
                      ? "Clear image"
                      : "Upload image for Image-to-Video"
                  }
                  onClick={() =>
                    uploadedImageUrl
                      ? clearImageUpload()
                      : imageFileInputRef.current?.click()
                  }
                  className={`w-10 h-10 shrink-0 rounded-full border transition-all flex items-center justify-center relative overflow-hidden ${uploadedImageUrl ? "border-primary/60 bg-primary/5" : "bg-white/5 border-white/[0.03] hover:bg-white/10 hover:border-primary/40"} group`}
                >
                  {imageUploading ? (
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
                          strokeDashoffset={88 - (88 * imageProgress) / 100}
                          className="text-primary transition-all duration-300"
                        />
                      </svg>
                      <span className="absolute text-[9px] font-black text-primary leading-none">
                        {imageProgress}%
                      </span>
                    </div>
                  ) : null}

                  {uploadedImageUrl ? (
                    <img
                      src={uploadedImageUrl}
                      alt=""
                      className={`w-full h-full object-cover rounded-full ${imageUploading ? "opacity-40 blur-[2px]" : "opacity-100"}`}
                    />
                  ) : (
                    !imageUploading && (
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        className="text-white/40 group-hover:text-primary transition-colors"
                      >
                        <rect
                          x="3"
                          y="3"
                          width="18"
                          height="18"
                          rx="2"
                          ry="2"
                        />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                    )
                  )}
                </button>
              </div>
            ) : null}

            {/* End-frame upload button (FLF i2v models only) */}
            {imageMode && (i2vModelList.find((m) => m.id === selectedModel) || i2vModels.find((m) => m.id === selectedModel))?.lastImageField && (
              <div className="relative">
                <input
                  ref={endImageFileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleEndImageFileChange}
                />
                <button
                  type="button"
                  title={uploadedEndImageUrl ? "Clear end frame" : "Upload end frame (optional)"}
                  onClick={() =>
                    uploadedEndImageUrl
                      ? clearEndImage()
                      : endImageFileInputRef.current?.click()
                  }
                  className={`w-10 h-10 shrink-0 rounded-full border transition-all flex items-center justify-center relative overflow-hidden ${uploadedEndImageUrl ? "border-primary/60 bg-primary/5" : "bg-white/5 border-white/[0.03] hover:bg-white/10 hover:border-primary/40"} group`}
                >
                  {endImageUploading ? (
                    <div className="flex flex-col items-center justify-center w-full h-full absolute inset-0 bg-black/80 z-20 backdrop-blur-[2px]">
                      <svg className="w-8 h-8 -rotate-90">
                        <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2" fill="transparent" className="text-white/10" />
                        <circle
                          cx="16"
                          cy="16"
                          r="14"
                          stroke="currentColor"
                          strokeWidth="2"
                          fill="transparent"
                          strokeDasharray={88}
                          strokeDashoffset={88 - (88 * endImageProgress) / 100}
                          className="text-primary transition-all duration-300"
                        />
                      </svg>
                      <span className="absolute text-[9px] font-black text-primary leading-none">
                        {endImageProgress}%
                      </span>
                    </div>
                  ) : null}

                  {uploadedEndImageUrl ? (
                    <img
                      src={uploadedEndImageUrl}
                      alt=""
                      className={`w-full h-full object-cover rounded-full ${endImageUploading ? "opacity-40 blur-[2px]" : "opacity-100"}`}
                    />
                  ) : (
                    !endImageUploading && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-white/40 group-hover:text-primary transition-colors">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                    )
                  )}
                  <span className="absolute top-0.5 left-0.5 px-1 h-3.5 bg-black/60 rounded-md text-[7px] font-black text-primary leading-none flex items-center justify-center pointer-events-none">
                    END
                  </span>
                </button>
              </div>
            )}

            {/* Video upload button */}
            <div className="relative">
              <input
                ref={videoFileInputRef}
                type="file"
                accept="video/*"
                className="hidden"
                onChange={handleVideoFileChange}
              />
              <button
                type="button"
                title={
                  uploadedVideoUrl
                    ? `${uploadedVideoName} — click to clear`
                    : "Upload video to remove watermark"
                }
                onClick={() =>
                  uploadedVideoUrl
                    ? clearVideoUpload()
                    : videoFileInputRef.current?.click()
                }
                className={`w-10 h-10 shrink-0 rounded-full border transition-all flex items-center justify-center relative overflow-hidden ${uploadedVideoUrl ? "border-primary/60 bg-white/5" : "bg-white/[0.03] border-white/[0.03] hover:bg-white/10 hover:border-primary/40"} group`}
              >
                {videoUploading ? (
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
                        strokeDashoffset={88 - (88 * videoProgress) / 100}
                        className="text-primary transition-all duration-300"
                      />
                    </svg>
                    <span className="absolute text-[9px] font-black text-primary leading-none">
                      {videoProgress}%
                    </span>
                  </div>
                ) : uploadedVideoUrl ? (
                  <video
                    src={uploadedVideoUrl}
                    className={`w-full h-full object-cover rounded-full ${videoUploading ? "opacity-40 blur-[2px]" : "opacity-100"}`}
                    muted
                  />
                ) : (
                  <VideoIconSvg className="text-white/40 group-hover:text-primary transition-colors" />
                )}
              </button>
            </div>
            </div>

            {/* Prompt textarea */}
            <div className="flex-1 flex flex-col gap-1">
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={handlePromptInput}
                placeholder={promptPlaceholder}
                disabled={promptDisabled}
                rows={1}
                className="w-full bg-transparent border-none text-white text-sm placeholder:text-white/10 focus:outline-none resize-none pt-1 leading-relaxed min-h-[40px] max-h-[150px] md:max-h-[250px] overflow-y-auto custom-scrollbar disabled:opacity-40"
              />
            </div>
          </div>

          {/* Extend banner */}
          {isExtendMode && (
            <div className="flex items-center gap-2 px-3 py-1.5 mx-3 bg-primary/5 border border-primary/10 rounded-lg text-[10px] text-primary/80 font-medium tracking-tight">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              <span>Extending previous Seedance 2.0 generation</span>
            </div>
          )}

          {/* Bottom row: controls + generate */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-4 pt-2 border-t border-white/[0.03] relative">
            <div className="flex items-center gap-2 relative flex-wrap pb-1 md:pb-0">
              {/* Model btn */}
              <div className="relative">
                <button
                  type="button"
                  onClick={toggleDropdown("model")}
                  className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                >
                  <div className="w-5 h-5 shrink-0 rounded-md bg-white/[0.04] text-white/70 border border-white/[0.06] flex items-center justify-center overflow-hidden shadow-inner">
                    <ModelProviderMark
                      model={currentModelObj}
                      glyphClassName="w-3.5 h-3.5"
                    />
                  </div>
                  <span className="text-xs font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors">
                    {selectedModelName}
                  </span>
                  <svg
                    width="8"
                    height="8"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="4"
                    className="opacity-20 group-hover:opacity-100 transition-opacity"
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {openDropdown === "model" && (
                  <div
                    ref={dropdownRef}
                    onClick={(e) => e.stopPropagation()}
                    className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded-[1.5rem] p-3 shadow-2xl border border-white/[0.05] w-[calc(100vw-3rem)] max-w-xs"
                  >
                    <ModelDropdown
                      imageMode={imageMode}
                      selectedModel={selectedModel}
                      onSelect={handleModelSelect}
                      onClose={() => setOpenDropdown(null)}
                      modelsByMode={modelsByMode}
                    />
                  </div>
                )}
              </div>

              {/* Aspect ratio btn */}
              {showAr && (
                <div className="hidden relative">
                  <button
                    type="button"
                    onClick={toggleDropdown("ar")}
                    className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="opacity-40 text-white"
                    >
                      <rect
                        x="3"
                        y="3"
                        width="18"
                        height="18"
                        rx="2"
                        ry="2"
                      />
                    </svg>
                    <span className="text-[11px] font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors">
                      {selectedAr}
                    </span>
                  </button>
                  {openDropdown === "ar" && (
                    <div
                      ref={dropdownRef}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded-lg p-3 shadow-2xl border border-white/[0.05] max-h-80 overflow-y-auto custom-scrollbar min-w-[160px]"
                    >
                      <div className="text-xs font-bold text-white/20 border-b border-white/[0.03] mb-2">
                        Aspect Ratio
                      </div>
                      <div className="flex flex-col gap-1">
                        {getCurrentAspectRatios(selectedModel).map((r) => (
                          <div
                            key={r}
                            className="flex items-center justify-between p-3 hover:bg-white/5 rounded cursor-pointer transition-all group/opt"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedAr(r);
                              setOpenDropdown(null);
                            }}
                          >
                            <span className="text-[11px] font-semibold text-white/70 group-hover/opt:text-white transition-opacity">
                              {r}
                            </span>
                            {selectedAr === r && <CheckSvg />}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Effect btn */}
              {showEffect && (
                <div className="hidden relative">
                  <button
                    type="button"
                    onClick={toggleDropdown("effect")}
                    className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="opacity-40 text-white"
                    >
                      <path d="M5 3l14 9-14 9V3z" />
                    </svg>
                    <span className="text-[11px] font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors max-w-[140px] truncate">
                      {selectedEffect || "Effect"}
                    </span>
                  </button>
                  {openDropdown === "effect" && (
                    <div
                      ref={dropdownRef}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded-lg p-3 shadow-2xl border border-white/[0.05] max-h-80 overflow-y-auto custom-scrollbar min-w-[200px]"
                    >
                      <div className="text-xs font-bold text-white/20 border-b border-white/[0.03] mb-2">
                        Effect Type
                      </div>
                      <div className="flex flex-col gap-1">
                        {getCurrentEffects(selectedModel).map((eff) => (
                          <div
                            key={eff}
                            className="flex items-center justify-between p-2 hover:bg-white/5 rounded cursor-pointer transition-all group/opt"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedEffect(eff);
                              setOpenDropdown(null);
                            }}
                          >
                            <span className="text-[11px] font-semibold text-white/70 group-hover/opt:text-white">
                              {eff}
                            </span>
                            {selectedEffect === eff && <CheckSvg />}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Duration btn */}
              {showDuration && (
                <div className="hidden relative">
                  <button
                    type="button"
                    onClick={toggleDropdown("duration")}
                    className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="opacity-40 text-white"
                    >
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span className="text-xs font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors">
                      {selectedDuration}s
                    </span>
                  </button>
                  {openDropdown === "duration" && (
                    <div
                      ref={dropdownRef}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded-md p-3 shadow-2xl border border-white/10 min-w-[140px]"
                    >
                      <div className="text-xs font-bold text-white/20 border-b border-white/[0.03] mb-2">
                        Duration
                      </div>
                      <div className="flex flex-col gap-1">
                        {getCurrentDurations(selectedModel).map((d) => (
                          <div
                            key={d}
                            className="flex items-center justify-between p-2 hover:bg-white/5 rounded-md cursor-pointer transition-all group/opt"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedDuration(d);
                              setOpenDropdown(null);
                            }}
                          >
                            <span className="text-xs font-semibold text-white/70 group-hover/opt:text-white">
                              {d}s
                            </span>
                            {selectedDuration === d && <CheckSvg />}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Resolution btn */}
              {showResolution && (
                <div className="hidden relative">
                  <button
                    type="button"
                    onClick={toggleDropdown("resolution")}
                    className="flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.06] rounded-md transition-all border border-white/[0.03] group whitespace-nowrap"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className="opacity-40 text-white"
                    >
                      <path d="M6 2L3 6v15a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6z" />
                    </svg>
                    <span className="text-[11px] font-semibold text-white/70 group-hover:text-[var(--primary-color)] transition-colors">
                      {selectedResolution || "720p"}
                    </span>
                  </button>
                  {openDropdown === "resolution" && (
                    <div
                      ref={dropdownRef}
                      onClick={(e) => e.stopPropagation()}
                      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded-md p-3 shadow-2xl border border-white/[0.05] min-w-[140px]"
                    >
                      <div className="text-xs font-bold text-white/20 border-b border-white/[0.03] mb-2">
                        Resolution
                      </div>
                      <div className="flex flex-col gap-1">
                        {getCurrentResolutions(selectedModel).map((r) => (
                          <div
                            key={r}
                            className="flex items-center justify-between p-3 hover:bg-white/5 rounded cursor-pointer transition-all group/opt"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedResolution(r);
                              setOpenDropdown(null);
                            }}
                          >
                            <span className="text-[11px] font-semibold text-white/70 group-hover/opt:text-white">
                              {r}
                            </span>
                            {selectedResolution === r && <CheckSvg />}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Generate button */}
            <button
              type="button"
              onClick={handleGenerate}
              disabled={generating}
              className="bg-[var(--primary-color)] text-black px-4 py-2 rounded-md font-medium text-sm hover:bg-[var(--primary-light-color)] hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2 w-full sm:w-auto shadow-lg shadow-[var(--primary-color)]/10 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating ? (
                <>
                  <span className="animate-spin inline-block text-black">
                    ◌
                  </span>{" "}
                  Generating...
                </>
              ) : generateError ? (
                `Error: ${generateError}`
              ) : (
                <>
                  <span>Generate</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── FULLSCREEN VIDEO MODAL ── */}
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
