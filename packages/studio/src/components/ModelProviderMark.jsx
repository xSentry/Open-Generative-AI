"use client";

const PROVIDER_LOGOS = {
  alibaba: "https://cdn.muapi.ai/models/alibaba.png",
  blackforest: "https://cdn.muapi.ai/models/blackforest.png",
  bytedance: "https://cdn.muapi.ai/models/bytedance.png",
  google: "https://cdn.muapi.ai/models/google.png",
  grok: "https://cdn.muapi.ai/models/grok.png",
  hidream: "https://cdn.muapi.ai/models/hidream.png",
  hunyuan: "https://cdn.muapi.ai/models/hunyuan.png",
  ideogram: "https://cdn.muapi.ai/models/ideogram.png",
  kling: "https://cdn.muapi.ai/models/kling.png",
  leonardoai: "https://cdn.muapi.ai/models/leonardoai.png",
  lightricks: "https://cdn.muapi.ai/models/lightricks.png",
  luma: "https://cdn.muapi.ai/models/luma.png",
  minimax: "https://cdn.muapi.ai/models/minimax.png",
  openai: "https://cdn.muapi.ai/models/openai.png",
  pixverse: "https://cdn.muapi.ai/models/pixverse.png",
  reve: "https://cdn.muapi.ai/models/reve.png",
  runway: "https://cdn.muapi.ai/models/runway.png",
  stability: "https://cdn.muapi.ai/models/stability.png",
  vidu: "https://cdn.muapi.ai/models/vidu.png",
};

const REPLICATE_OWNER_LOGO_KEYS = {
  "black-forest-labs": "blackforest",
  "ideogram-ai": "ideogram",
  "stability-ai": "stability",
  runwayml: "runway",
  xai: "grok",
};

const INVERT_LOGOS = new Set(["openai", "blackforest", "runway", "ideogram", "lightricks", "grok"]);

export const ModelGlyph = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7.5 4.25v8.5L12 20l-7.5-4.25v-8.5L12 3z" />
    <path d="M12 8v8M8.5 10.25l7 4M15.5 10.25l-7 4" />
  </svg>
);

function providerLogoKey(model) {
  if (!model) return null;
  if (model.provider === "replicate") {
    const owner = model.replicate?.owner?.toLowerCase();
    return REPLICATE_OWNER_LOGO_KEYS[owner] || owner;
  }
  return model.provider || "muapi";
}

function providerInitial(model) {
  if (model?.provider === "replicate" && !model.replicate?.owner) return null;
  const source =
    model?.provider === "replicate"
      ? model.replicate?.owner || model.provider_name || model.provider
      : model?.provider_name || model?.provider;
  return source?.trim()?.charAt(0)?.toUpperCase() || null;
}

export default function ModelProviderMark({
  model,
  glyphClassName = "w-5 h-5",
  imageClassName = "",
}) {
  const logoKey = providerLogoKey(model);
  const logo = PROVIDER_LOGOS[logoKey];

  if (logo) {
    return (
      <span className="w-full h-full flex items-center justify-center overflow-hidden p-[22%]">
        <img
          src={logo}
          alt={model?.replicate?.owner || model?.provider_name || model?.provider || "Model provider"}
          className={`${imageClassName} block max-w-full max-h-full object-contain ${INVERT_LOGOS.has(logoKey) ? "invert" : ""}`}
        />
      </span>
    );
  }

  const initial = providerInitial(model);
  if (initial) {
    return (
      <span className="w-full h-full flex items-center justify-center overflow-hidden">
        <span className="block text-current font-black leading-none uppercase text-[0.92em]">
          {initial}
        </span>
      </span>
    );
  }

  return (
    <span className="w-full h-full flex items-center justify-center overflow-hidden p-[22%]">
      <ModelGlyph className={glyphClassName} />
    </span>
  );
}
