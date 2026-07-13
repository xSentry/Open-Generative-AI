"use client";

export const ModelGlyph = ({ className = "w-5 h-5" }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 3l7.5 4.25v8.5L12 20l-7.5-4.25v-8.5L12 3z" />
    <path d="M12 8v8M8.5 10.25l7 4M15.5 10.25l-7 4" />
  </svg>
);

function providerInitial(model) {
  const source =
    model?.provider === "replicate"
      ? model.replicate?.owner || model.provider_name || model.provider
      : model?.provider_name || model?.provider;
  return source?.trim()?.charAt(0)?.toUpperCase() || null;
}

export default function ModelProviderMark({
  model,
  glyphClassName = "w-5 h-5",
}) {
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
