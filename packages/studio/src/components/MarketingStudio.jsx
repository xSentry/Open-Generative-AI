"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { uploadFile, generateMarketingStudioAd } from "../muapi.js";
import { useServerGenerations } from "../useServerGenerations.js";

const SCROLLBAR_STYLE = `
  .custom-scrollbar-thin::-webkit-scrollbar {
    height: 4px;
  }
  .custom-scrollbar-thin::-webkit-scrollbar-track {
    background: transparent;
  }
  .custom-scrollbar-thin::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
  .custom-scrollbar-thin::-webkit-scrollbar-thumb:hover {
    background: oklch(0.35 0.05 192 / 0.3);
  }
`;

// ── Icons ────────────────────────────────────────────────────────────────────

const CheckSvg = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--primary-color)" strokeWidth="4">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const PlusSvg = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const CloseSvg = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6" y1="6" x2="18" y2="18" />
  </svg>
);

const ProductIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 8l-2-2H5L3 8v10a2 2 0 002 2h14a2 2 0 002-2V8z" />
    <path d="M3 10h18" />
    <path d="M16 6V4a2 2 0 00-2-2h-4a2 2 0 00-2 2v2" />
  </svg>
);

const AvatarIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const RefIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <polyline points="21 15 16 10 5 21" />
  </svg>
);

// ── Assets ───────────────────────────────────────────────────────────────────

const ASSETS = {
  avatar: [
    { id: "aa252283-8591-4d14-91a8-41ce54187992", name: "Priya", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Priya.webp" },
    { id: "ba6c9b18-f79c-4dab-9649-88a181d0a038", name: "Elena", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Elena.webp" },
    { id: "30e2cadd-987c-4a7a-81c3-094d4fb3a65e", name: "Kai", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Kai.webp" },
    { id: "fbed59e1-4b8d-4625-9140-ef2044e0be72", name: "Sora", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Sora.webp" },
    { id: "bcd9e6ee-c000-48e6-9f4b-a20fc2a674f7", name: "Minji", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Minji.webp" },
    { id: "1da384ed-3856-45e4-bf4c-a496c7aa95ff", name: "Margot", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Margot.webp" },
    { id: "b799c8f5-fb6e-4905-b33b-cdefac153ec3", name: "Niko", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Niko.webp" },
    { id: "b6971dd4-55fa-4e64-b318-392b16504284", name: "Jin", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/Jin.webp" }
  ],
  ugc: [
    { id: 1, name: "UGC", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/ugc.mp4" },
    { id: 2, name: "Tutorial", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/ugc_how_to.mp4" },
    { id: 3, name: "Unboxing", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/ugc_unboxing.mp4" },
    { id: 4, name: "Hyper Motion", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/hyper-motion-mini.mp4" },
    { id: 5, name: "Product Review", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/product_review.mp4" },
    { id: 6, name: "TV Spot", url: "https://d3adwkbyhxyrtq.cloudfront.net/web-app/tv-spot-mini.mp4" }
  ]
};

const OPTIONS = {
  ratio: ["9:16", "3:4", "4:3", "16:9", "1:1"],
  res: ["720p", "1080p"],
  duration: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
};

// A "no reference video" option so the base case (product + avatar + prompt)
// doesn't force a UGC template video onto the model (some cap length at 10s).
const FORMAT_NONE = { id: "none", name: "None", url: null };
const FORMAT_ITEMS = [FORMAT_NONE, ...ASSETS.ugc];

// ── Components ───────────────────────────────────────────────────────────────

function UploadSlot({ icon, url, progress, label, onUpload, onClear, multiple = false, images = [] }) {
  const inputRef = useRef(null);
  
  return (
    <div className="relative group/slot flex items-center">
      <div 
        onClick={() => inputRef.current?.click()}
        title={`Upload ${label}`}
        className={`relative w-10 h-10 rounded-full border transition-all flex items-center justify-center cursor-pointer ${
          url ? 'border-primary/40 bg-primary/5' : 'border-white/5 bg-white/5 hover:bg-white/10 hover:border-white/20'
        }`}
      >
        <input 
          ref={inputRef} 
          type="file" 
          accept="image/*"
          className="hidden" 
          multiple={multiple}
          onChange={(e) => onUpload(e)} 
        />
        
        {progress > 0 && progress < 100 ? (
          <div className="absolute inset-0 bg-black/60 rounded-full flex items-center justify-center z-10">
            <span className="text-[8px] font-black text-primary">{progress}%</span>
          </div>
        ) : url ? (
          <div className="w-full h-full rounded-full overflow-hidden border border-black/20">
            <img src={url} className="w-full h-full object-cover" alt={label} />
          </div>
        ) : (
          <div className="text-white/40 group-hover:text-primary transition-colors">
            {icon}
          </div>
        )}

        {/* Clear Button (Single) */}
        {url && !multiple && (
          <button 
            onClick={(e) => { e.stopPropagation(); onClear(); }}
            className="absolute -top-1 -right-1 w-4 h-4 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover/slot:opacity-100 transition-opacity shadow-lg"
          >
            <CloseSvg />
          </button>
        )}
      </div>      
    </div>
  );
}

function Dropdown({ isOpen, title, items, selectedId, onSelect, onClose, isVideo = false }) {
  const ref = useRef(null);
  
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      ref={ref}
      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded p-4 shadow-4xl border border-white/10 w-[420px] animate-fade-in-up"
    >
      <div className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-4 px-1">{title}</div>
      <div className="grid grid-cols-3 gap-3 max-h-[300px] overflow-y-auto custom-scrollbar pr-1">
        {items.map(item => (
          <div 
            key={item.id}
            onClick={() => onSelect(item)}
            className={`relative rounded overflow-hidden border-2 transition-all group cursor-pointer ${
              selectedId === item.id || selectedId === item.url ? 'border-primary shadow-glow' : 'border-white/5 hover:border-white/20'
            }`}
          >
            {isVideo ? (
              item.url ? (
                <video src={item.url} autoPlay loop muted className="w-full aspect-[3/4] object-cover group-hover:scale-105 transition-all duration-500" />
              ) : (
                <div className="w-full aspect-[3/4] flex flex-col items-center justify-center bg-white/[0.02] gap-1.5 text-white/40 group-hover:text-white/70 transition-colors">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="5" y1="5" x2="19" y2="19" /></svg>
                  <span className="text-[9px] font-black uppercase tracking-tight">None</span>
                </div>
              )
            ) : (
              <img src={item.url} className="w-full aspect-square object-cover group-hover:scale-105 transition-all duration-500" alt={item.name} />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent flex items-end p-2 opacity-0 group-hover:opacity-100 transition-opacity">
              <span className="text-[9px] font-black text-white uppercase tracking-tight">{item.name}</span>
            </div>
            {(selectedId === item.id || selectedId === item.url) && (
              <div className="absolute top-1.5 right-1.5 w-4 h-4 bg-primary rounded-full flex items-center justify-center shadow-lg">
                <CheckSvg />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function SimpleDropdown({ isOpen, title, options, selected, onSelect, onClose }) {
  const ref = useRef(null);
  
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div 
      ref={ref}
      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded p-1 max-h-[200px] overflow-y-auto custom-scrollbar shadow-3xl border border-white/10 min-w-[140px] animate-fade-in-up"
    >
      <div className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-2 px-3 pt-2">{title}</div>
      {options.map(opt => (
        <button
          key={opt}
          onClick={() => { onSelect(opt); onClose(); }}
          className={`w-full text-left px-4 py-2 rounded text-xs font-bold transition-all flex items-center justify-between ${
            selected === opt ? 'bg-primary text-black' : 'text-white/60 hover:bg-white/5 hover:text-white'
          }`}
        >
          <span>{opt}</span>
          {selected === opt && <CheckSvg />}
        </button>
      ))}
    </div>
  );
}

// ── Model dropdown (id/name/description, provider-aware) ─────────────────────

function ModelDropdown({ isOpen, models, selectedId, onSelect, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={ref}
      className="absolute bottom-[calc(100%+12px)] left-0 z-50 bg-[#0a0a0a] rounded p-1 max-h-[300px] overflow-y-auto custom-scrollbar shadow-3xl border border-white/10 w-[calc(100vw-3rem)] max-w-[260px] animate-fade-in-up"
    >
      <div className="text-[10px] font-black text-white/40 uppercase tracking-widest mb-2 px-3 pt-2">
        Model
      </div>
      {models.length === 0 && (
        <div className="px-3 py-2 text-xs text-white/30">No compatible models</div>
      )}
      {models.map((m) => (
        <button
          key={m.id}
          onClick={() => { onSelect(m.id); onClose(); }}
          className={`w-full text-left px-3 py-2 rounded text-xs transition-all ${
            selectedId === m.id ? "bg-primary/10 text-primary font-bold" : "text-white/70 hover:bg-white/5 hover:text-white"
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-bold">{m.name || m.id}</span>
            {selectedId === m.id && <CheckSvg />}
          </div>
          {m.description && (
            <div className="text-[10px] text-white/30 mt-0.5 line-clamp-2">{m.description}</div>
          )}
        </button>
      ))}
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function MarketingStudio({ apiKey, provider = "replicate", droppedFiles, onFilesHandled, modelsByMode }) {
  const PERSIST_KEY = "hg_marketing_studio_persistent";
  
  const [prompt, setPrompt] = useState("");
  const [productImage, setProductImage] = useState(null);
  const [avatarImage, setAvatarImage] = useState(null);
  const [additionalImages, setAdditionalImages] = useState([]);
  
  const [params, setParams] = useState({
    ratio: "9:16",
    format: FORMAT_NONE.name,
    videoUrl: null,
    res: "1080p",
    duration: 5
  });

  const [history, setHistory] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [dropdown, setDropdown] = useState(null); // 'model' | 'format' | 'avatar' | 'ratio' | 'res' | 'duration'
  const [uploadProgress, setUploadProgress] = useState({ product: 0, avatar: 0, additional: 0 });
  const [fullscreenUrl, setFullscreenUrl] = useState(null);

  const textareaRef = useRef(null);
  const appliedProviderDefaultRef = useRef(new Set());
  const suppressProviderDefaultRef = useRef(false);
  const hasRestoredConfigRef = useRef(false);
  const skipNextConfigSaveRef = useRef(false);

  // ── Provider-aware model selection + server-persisted generations ──────────
  const marketingModels = useMemo(
    () => (Array.isArray(modelsByMode?.marketing) ? modelsByMode.marketing : []),
    [modelsByMode],
  );
  const [selectedModelId, setSelectedModelId] = useState(null);
  const serverGen = useServerGenerations({
    mediaType: "video",
    mode: "marketing",
    onSucceeded: (card) => setFullscreenUrl(card.url),
  });
  const serverActive = serverGen.active;

  // Keep the selection valid as the provider/catalog changes.
  useEffect(() => {
    if (marketingModels.length === 0) {
      setSelectedModelId(null);
      return;
    }
    setSelectedModelId((prev) =>
      prev && marketingModels.some((m) => m.id === prev) ? prev : marketingModels[0].id,
    );
  }, [marketingModels]);

  useEffect(() => {
    if (!modelsByMode?.marketing?.length) return;
    if (suppressProviderDefaultRef.current) {
      suppressProviderDefaultRef.current = false;
      return;
    }
    const first = modelsByMode.marketing[0];
    const key = `marketing:${first.provider || "muapi"}:${first.id}`;
    if (appliedProviderDefaultRef.current.has(key)) return;
    appliedProviderDefaultRef.current.add(key);
    setSelectedModelId(first.id);
  }, [modelsByMode?.marketing]);
  const selectedModel = marketingModels.find((m) => m.id === selectedModelId) || null;

  // Derive control options from the selected model's input enums (Replicate and
  // MuAPI models differ), falling back to the static presets for the legacy path.
  const modelInputs = selectedModel?.inputs || null;
  const optionsFor = (key) => {
    if (!modelInputs) return OPTIONS[key];
    if (key === 'ratio') return modelInputs.aspect_ratio?.enum || OPTIONS.ratio;
    if (key === 'res') return modelInputs.resolution?.enum || OPTIONS.res;
    if (key === 'duration') {
      const d = modelInputs.duration;
      if (Array.isArray(d?.enum) && d.enum.length) return d.enum;
      if (d && (d.type === 'int' || d.type === 'number')) {
        // Keep the sensible presets, clamped to the model's [min,max] range.
        const min = Math.max(1, d.minValue ?? 1);
        const max = d.maxValue != null && d.maxValue > 0 ? d.maxValue : OPTIONS.duration[OPTIONS.duration.length - 1];
        const clamped = OPTIONS.duration.filter((v) => v >= min && v <= max);
        return clamped.length ? clamped : [d.default != null ? d.default : min];
      }
      return OPTIONS.duration;
    }
    return OPTIONS[key];
  };
  // A control is shown when the (catalog) model declares that input; on the
  // legacy path (no catalog model) all presets stay visible.
  const controlSupported = (key) => {
    if (!serverActive || !modelInputs) return true;
    if (key === 'ratio') return Boolean(modelInputs.aspect_ratio);
    if (key === 'res') return Boolean(modelInputs.resolution);
    if (key === 'duration') return Boolean(modelInputs.duration);
    return true;
  };
  const controlKeys = ['ratio', 'res', 'duration'].filter(controlSupported);

  // Coerce ratio/res/duration to values the active model actually accepts so we
  // never submit e.g. resolution "1080p" to a model whose enum is ["480p","720p"].
  useEffect(() => {
    if (!serverActive || !selectedModel) return;
    setParams((prev) => {
      const next = { ...prev };
      const coerce = (key, inputKey) => {
        const input = selectedModel.inputs?.[inputKey];
        if (!input) return;
        const opts = optionsFor(key);
        const match = opts.find((o) => String(o) === String(next[key]));
        if (match === undefined) {
          next[key] = input.default != null ? input.default : opts[0];
        } else if (match !== next[key]) {
          // Normalize the value's type to the exact enum entry ("5" vs 5).
          next[key] = match;
        }
      };
      coerce('ratio', 'aspect_ratio');
      coerce('res', 'resolution');
      coerce('duration', 'duration');
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModelId, serverActive]);

  // History source: server-persisted wins when active.
  const displayHistory = serverActive ? serverGen.items : history;

  // ── Persistence ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!modelsByMode) return;
    try {
      const stored = localStorage.getItem(PERSIST_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        const storedProvider = data.provider || "replicate";
        if (storedProvider !== provider) return;
        skipNextConfigSaveRef.current = true;
        if (data.selectedModelId) setSelectedModelId(data.selectedModelId);
        if (data.prompt) setPrompt(data.prompt);
        if (data.params || data.options) {
          const p = { ...(data.params || data.options) };
          // Migrate the previous forced default (UGC template as reference video)
          // to the new opt-in "None" so it isn't silently attached (some models
          // reject reference videos > 10s).
          if (p.videoUrl === ASSETS.ugc[0].url && p.format === ASSETS.ugc[0].name) {
            p.format = FORMAT_NONE.name;
            p.videoUrl = null;
          }
          setParams(p);
        }
        if (data.productImage) setProductImage(data.productImage);
        if (data.avatarImage) setAvatarImage(data.avatarImage);
        if (data.additionalImages) setAdditionalImages(data.additionalImages);
        if (data.uploads?.product_image) setProductImage(data.uploads.product_image);
        if (data.uploads?.avatar_image) setAvatarImage(data.uploads.avatar_image);
        if (data.uploads?.additional_images) setAdditionalImages(data.uploads.additional_images);
        suppressProviderDefaultRef.current = true;
      }
    } catch (err) { console.warn("Load failed", err); }
    finally { hasRestoredConfigRef.current = true; }
  }, [modelsByMode, provider]);

  useEffect(() => {
    if (!modelsByMode || !hasRestoredConfigRef.current) return;
    if (skipNextConfigSaveRef.current) {
      skipNextConfigSaveRef.current = false;
      return;
    }
    const timer = setTimeout(() => {
      const state = {
        version: 1,
        provider,
        selectedModelId,
        prompt,
        options: params,
        uploads: {
          product_image: productImage,
          avatar_image: avatarImage,
          additional_images: additionalImages,
        },
      };
      localStorage.setItem(PERSIST_KEY, JSON.stringify(state));
    }, 500);
    return () => clearTimeout(timer);
  }, [modelsByMode, provider, selectedModelId, prompt, params, productImage, avatarImage, additionalImages]);

  // ── Handlers ───────────────────────────────────────────────────────────────

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

  const handleUpload = async (e, target) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    
    if (target === 'additional') {
      const remaining = 6 - additionalImages.length;
      const toUpload = files.slice(0, remaining);
      for (const file of toUpload) {
        try {
          const url = await uploadFile(apiKey, file, (pct) => setUploadProgress(p => ({ ...p, additional: pct })));
          setAdditionalImages(prev => [...prev, url].slice(0, 6));
        } catch (err) { alert(err.message); }
      }
    } else {
      const file = files[0];
      try {
        const url = await uploadFile(apiKey, file, (pct) => setUploadProgress(p => ({ ...p, [target]: pct })));
        if (target === 'product') setProductImage(url);
        else setAvatarImage(url);
      } catch (err) { alert(err.message); }
    }
    setUploadProgress(p => ({ ...p, [target]: 0 }));
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return alert("Please enter an ad script.");
    if (!productImage) return alert("Please upload a product image.");
    if (serverActive && !selectedModelId) return alert("No marketing model available for the active provider.");

    setIsGenerating(true);
    try {
      const images_list = [productImage, avatarImage, ...additionalImages].filter(Boolean);
      const genParams = {
        prompt,
        aspect_ratio: params.ratio,
        duration: params.duration,
        resolution: params.res,
        images_list,
      };
      // Pass the reference/UGC video generically; models with a video input map
      // it (others ignore it).
      if (params.videoUrl) genParams.video_url = params.videoUrl;

      // ── Server-persisted async path (DB + S3 + loading card + SSE) ─────────
      if (serverActive) {
        await serverGen.generate({ mode: "marketing", model: selectedModelId, params: genParams });
        return;
      }

      // ── Legacy synchronous path (Electron / non-hosted) ────────────────────
      const result = await generateMarketingStudioAd(apiKey, {
        prompt,
        aspect_ratio: params.ratio,
        duration: params.duration,
        resolution: params.res,
        images_list,
        video_files: params.videoUrl ? [params.videoUrl] : [],
      });

      if (result?.url) {
        const entry = {
          id: Date.now(),
          url: result.url,
          prompt,
          format: params.format,
          timestamp: new Date().toISOString()
        };
        setHistory(prev => [entry, ...prev]);
        setFullscreenUrl(result.url);
      }
    } catch (err) {
      alert("Generation failed: " + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleTextareaInput = (e) => {
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 250) + "px";
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-app-bg relative p-4 md:p-6 overflow-hidden">
      <style>{SCROLLBAR_STYLE}</style>
      
      {/* ── MAIN CONTENT AREA ── */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-6 pb-40">
        {displayHistory.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 animate-fade-in-up">
            {displayHistory.map(entry => {
              const status = entry.status;
              const isLoading = status === "generating" || (!entry.url && status !== "failed" && status !== undefined);
              const isFailed = status === "failed";
              const badge = entry.format || selectedModel?.name || "AD";
              const ts = entry.timestamp || new Date().toISOString();
              return (
              <div key={entry.id} className="relative group rounded-lg overflow-hidden border border-white/10 bg-[#0a0a0a] shadow-xl hover:border-primary/50 transition-all duration-300 flex flex-col">
                {isLoading ? (
                  <div className="w-full aspect-video flex flex-col items-center justify-center bg-black/40 gap-3">
                    <div className="w-6 h-6 border-2 border-primary/20 border-t-primary rounded-full animate-spin" />
                    <span className="text-[10px] font-bold text-white/40 uppercase tracking-wider">Rendering…</span>
                  </div>
                ) : isFailed ? (
                  <div className="w-full aspect-video flex flex-col items-center justify-center bg-red-500/5 gap-2 px-4 text-center">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                    <span className="text-[11px] font-bold text-red-300">Generation failed</span>
                    {entry.error && <span className="text-[10px] text-white/30 line-clamp-2">{entry.error}</span>}
                  </div>
                ) : (
                  <video
                    src={entry.url}
                    className="w-full aspect-video object-cover cursor-pointer hover:opacity-80 transition-opacity"
                    onClick={() => setFullscreenUrl(entry.url)}
                    muted loop onMouseOver={e => e.target.play()} onMouseOut={e => { e.target.pause(); e.target.currentTime = 0; }}
                  />
                )}

                {/* Actions Overlay */}
                <div className="absolute top-2 right-2 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                   {entry.url && !isLoading && (
                   <button
                    onClick={(e) => { e.stopPropagation(); downloadFile(entry.url, `marketing-ad-${entry.id}.mp4`); }}
                    className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-primary hover:text-black transition-all border border-white/10"
                    title="Download"
                   >
                     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                       <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3" />
                     </svg>
                   </button>
                   )}
                   {serverActive && entry.id && !isLoading && (
                   <button
                    onClick={(e) => { e.stopPropagation(); serverGen.remove(entry.id); }}
                    className="p-2 bg-black/60 backdrop-blur-md rounded-full text-white hover:bg-red-500 hover:text-white transition-all border border-white/10"
                    title="Delete"
                   >
                     <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                       <polyline points="3 6 5 6 21 6" />
                       <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                     </svg>
                   </button>
                   )}
                </div>

                <div className="p-3 bg-black/80 backdrop-blur-sm border-t border-white/5 flex flex-col gap-1.5 flex-1">
                  <p className="text-white/60 text-[10px] line-clamp-2 leading-relaxed font-medium">{entry.prompt}</p>
                  <div className="flex items-center justify-between mt-auto">
                    <span className="text-[9px] font-black text-primary px-2 py-0.5 bg-primary/10 rounded border border-primary/20 uppercase tracking-tighter">
                      {isLoading ? "Rendering" : isFailed ? "Failed" : badge}
                    </span>
                    <span className="text-[9px] text-white/30 font-bold">{new Date(ts).toLocaleDateString()}</span>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center animate-fade-in-up transition-all duration-700">
             <div className="mb-12 relative group">
                <div className="absolute inset-0 bg-primary/10 blur-[120px] rounded-full opacity-30 group-hover:opacity-60 transition-opacity duration-1000" />
                <div className="relative w-24 h-24 md:w-32 md:h-32 bg-white/[0.02] rounded-[2rem] flex items-center justify-center border border-white/[0.05] overflow-hidden backdrop-blur-sm">
                  <div className="w-16 h-16 bg-primary/5 rounded-2xl flex items-center justify-center border border-primary/10 relative z-10 transition-transform duration-500 group-hover:scale-110 shadow-inner">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--primary-color)" strokeWidth="1.5">
                      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                      <line x1="8" y1="21" x2="16" y2="21" />
                      <line x1="12" y1="17" x2="12" y2="21" />
                    </svg>
                  </div>
                </div>
              </div>
              <h1 className="text-3xl sm:text-5xl md:text-6xl font-extrabold text-white tracking-tight mb-4 text-center px-4">
                <span className="text-white/40 font-medium uppercase tracking-widest">START CREATING WITH</span>
                <br />
                <span className="text-white uppercase tracking-tight">MARKETING STUDIO</span>
              </h1>
              <p className="text-white/40 text-sm md:text-base font-medium tracking-wide text-center max-w-lg leading-relaxed px-6">
                Describe your scene, upload your product, and watch high-converting AI video ads come to life.
              </p>
          </div>
        )}
      </div>

      {/* ── BOTTOM PROMPT BAR ── */}
      <div style={{ animationDelay: "0.2s" }} className="absolute bottom-4 w-full max-w-[95%] lg:max-w-4xl z-40 animate-fade-in-up">
        <div className="bg-[#0a0a0a]/80 backdrop-blur-3xl rounded-lg border border-white/10 p-4 flex flex-col gap-2 shadow-4xl">
          {additionalImages.length > 0 && (
            <div className="flex items-center gap-1.5">
              {additionalImages.map((img, idx) => (
                <div key={idx} className="relative group/img flex-shrink-0">
                  <img src={img} className="w-9 h-9 rounded-full object-cover border border-white/10" />
                  <button 
                    onClick={() => setAdditionalImages(prev => prev.filter((_, i) => i !== idx))}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-black/80 text-white rounded-full flex items-center justify-center opacity-0 group-hover/img:opacity-100 transition-opacity border border-white/10"
                  >
                    <CloseSvg />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* Top Row: Full-width Textarea */}
          <div className="w-full relative">
            <textarea
              ref={textareaRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onInput={handleTextareaInput}
              placeholder="Describe your ad script... Use @image1 for product, @image2 for avatar."
              rows={1}
              className="w-full bg-transparent border-none text-white text-sm placeholder:text-white/20 focus:outline-none resize-none pt-1 leading-relaxed min-h-[44px] max-h-[300px] custom-scrollbar font-medium"
            />
          </div>

          {/* Bottom Row: Uploads + Controls + Generate */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-3 border-t border-white/[0.05]">
            <div className="flex items-center gap-3 flex-wrap">
              
              {/* Asset Uploads Group */}
              <div className="flex items-center gap-1.5 pr-3 border-r border-white/10">
                <UploadSlot 
                  label="Product" 
                  icon={<ProductIcon />} 
                  url={productImage} 
                  progress={uploadProgress.product} 
                  onUpload={(e) => handleUpload(e, 'product')} 
                  onClear={() => setProductImage(null)} 
                />
                <UploadSlot 
                  label="Avatar" 
                  icon={<AvatarIcon />} 
                  url={avatarImage} 
                  progress={uploadProgress.avatar} 
                  onUpload={(e) => handleUpload(e, 'avatar')} 
                  onClear={() => setAvatarImage(null)} 
                />
                <UploadSlot 
                  label="References" 
                  icon={<RefIcon />} 
                  url={additionalImages[0]} 
                  progress={uploadProgress.additional} 
                  multiple 
                  images={additionalImages}
                  onUpload={(e) => handleUpload(e, 'additional')} 
                  onClear={(idx) => {
                    if (idx !== undefined) {
                      setAdditionalImages(prev => prev.filter((_, i) => i !== idx));
                    } else {
                      setAdditionalImages([]);
                    }
                  }} 
                />
              </div>

              {/* Model Select (provider-aware) */}
              {marketingModels.length > 0 && (
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setDropdown(dropdown === 'model' ? null : 'model'); }}
                    className={`flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.08] rounded border transition-all group whitespace-nowrap max-w-[200px] ${dropdown === 'model' ? 'border-primary/50' : 'border-white/5'}`}
                    title={selectedModel?.id || "Select a model"}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-40 shrink-0">
                      <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                    </svg>
                    <span className="text-sm font-bold text-white/70 group-hover:text-primary transition-colors truncate">
                      {selectedModel?.name || selectedModel?.id || "Model"}
                    </span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" className="opacity-20 group-hover:opacity-100 transition-opacity shrink-0"><path d="M6 9l6 6 6-6" /></svg>
                  </button>
                  <ModelDropdown
                    isOpen={dropdown === 'model'}
                    models={marketingModels}
                    selectedId={selectedModelId}
                    onSelect={setSelectedModelId}
                    onClose={() => setDropdown(null)}
                  />
                </div>
              )}

              {/* Format Button */}
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setDropdown(dropdown === 'format' ? null : 'format'); }}
                  className={`flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.08] rounded border transition-all group whitespace-nowrap ${dropdown === 'format' ? 'border-primary/50' : 'border-white/5'}`}
                >
                  <div className="w-4 h-4 bg-primary/10 rounded flex items-center justify-center border border-primary/20">
                    <span className="text-[8px] font-black text-primary uppercase">U</span>
                  </div>
                  <span className="text-sm font-bold text-white/70 group-hover:text-primary transition-colors">{params.format}</span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" className="opacity-20 group-hover:opacity-100 transition-opacity"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <Dropdown 
                  isOpen={dropdown === 'format'} 
                  title="Video Format Presets"
                  items={FORMAT_ITEMS}
                  selectedId={params.format}
                  onSelect={(item) => setParams({ ...params, format: item.name, videoUrl: item.url })}
                  onClose={() => setDropdown(null)}
                  isVideo
                />
              </div>

              {/* Avatar Preset Button */}
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setDropdown(dropdown === 'avatar' ? null : 'avatar'); }}
                  className={`flex items-center gap-2 px-3 py-2 bg-white/[0.03] hover:bg-white/[0.08] rounded border transition-all group whitespace-nowrap ${dropdown === 'avatar' ? 'border-primary/50' : 'border-white/5'}`}
                >
                  <div className="w-4 h-4 rounded-full overflow-hidden border border-white/20 shadow-inner">
                    <img src={avatarImage || ASSETS.avatar[0].url} className="w-full h-full object-cover" />
                  </div>
                  <span className="text-sm font-bold text-white/70 group-hover:text-primary transition-colors">
                    {ASSETS.avatar.find(a => a.url === avatarImage)?.name || "Select Avatar"}
                  </span>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" className="opacity-20 group-hover:opacity-100 transition-opacity"><path d="M6 9l6 6 6-6" /></svg>
                </button>
                <Dropdown 
                  isOpen={dropdown === 'avatar'} 
                  title="Avatar Presets"
                  items={ASSETS.avatar} 
                  selectedId={avatarImage}
                  onSelect={(item) => setAvatarImage(item.url)}
                  onClose={() => setDropdown(null)}
                />
              </div>

              {/* Simple Controls (options derived from the selected model) */}
              {controlKeys.map(key => (
                <div key={key} className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setDropdown(dropdown === key ? null : key); }}
                    className={`px-3 py-2 bg-white/[0.03] hover:bg-white/[0.08] rounded border transition-all text-sm font-bold ${dropdown === key ? 'border-primary/50 text-primary' : 'border-white/5 text-white/70'}`}
                  >
                    {key === 'duration' ? `${params[key]}s` : params[key]}
                  </button>
                  <SimpleDropdown 
                    isOpen={dropdown === key} 
                    title={key === 'res' ? 'Resolution' : key.toUpperCase()} 
                    options={optionsFor(key)}
                    selected={params[key]}
                    onSelect={(val) => setParams({ ...params, [key]: val })} 
                    onClose={() => setDropdown(null)} 
                  />
                </div>
              ))}
            </div>

            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="bg-primary text-black px-8 py-2.5 rounded font-bold text-base hover:bg-[var(--primary-light-color)] hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-3 shadow-glow disabled:opacity-50 disabled:grayscale z-10"
            >
              {isGenerating ? (
                <>
                  <div className="w-3 h-3 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                  Generating...
                </>
              ) : (
                <span>Launch</span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Fullscreen Preview */}
      {fullscreenUrl && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-sm animate-fade-in" onClick={() => setFullscreenUrl(null)}>
          <button className="absolute top-6 right-6 p-3 bg-white/10 hover:bg-white/20 rounded-full text-white border border-white/10 transition-colors shadow-2xl"><CloseSvg /></button>
          <video src={fullscreenUrl} controls autoPlay className="max-w-[95vw] max-h-[95vh] rounded-lg shadow-4xl animate-scale-up" onClick={e => e.stopPropagation()} />
        </div>
      )}
    </div>
  );
}
