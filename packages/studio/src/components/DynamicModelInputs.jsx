"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { uploadFile } from "../muapi.js";

const ACCEPT = { image: "image/*", video: "video/*", audio: "audio/*" };
const LIMIT_MB = { image: 20, video: 100, audio: 50 };

function mediaKindFor(name, schema) {
  if (schema?.mediaKind) return schema.mediaKind;
  if (schema?.field === "images_list" || schema?.field === "image") return "image";
  if (schema?.field === "videos_list" || schema?.field === "video") return "video";
  if (schema?.field === "audios_list" || schema?.field === "audio") return "audio";
  const hint = `${name} ${schema?.title || ""}`.toLowerCase();
  if (/image|frame/.test(hint)) return "image";
  if (/video/.test(hint)) return "video";
  if (/audio|sound|voice/.test(hint)) return "audio";
  return null;
}

function isEmpty(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function humanize(name) {
  return String(name).replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function FieldHeader({ name, schema, required, htmlFor }) {
  return (
    <div className="min-w-0">
      <label htmlFor={htmlFor} className="flex items-center gap-1.5 text-xs font-semibold text-white/90">
        {schema.title || humanize(name)}
        {required && <span className="text-primary" title="Required">*</span>}
      </label>
      {schema.description && (
        <p className="mt-1 text-[11px] leading-4 text-zinc-500">{schema.description}</p>
      )}
    </div>
  );
}

function FieldShell({ children, className = "" }) {
  return <div className={`min-w-0 rounded-xl border border-white/[0.08] bg-zinc-900/80 p-3 ${className}`}>{children}</div>;
}

function MediaIcon({ kind }) {
  if (kind === "audio") {
    return <path d="M9 18V5l10-2v13M9 9l10-2M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm10-2a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />;
  }
  if (kind === "video") {
    return <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>;
  }
  return <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>;
}

function MediaInput({ name, schema, value, onChange, apiKey, required }) {
  const inputRef = useRef(null);
  const dragDepthRef = useRef(0);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const kind = mediaKindFor(name, schema);
  const multiple = schema.type === "array";
  const values = multiple ? (Array.isArray(value) ? value : []) : value ? [value] : [];
  const maxItems = multiple ? Number(schema.maxItems) || 10 : 1;

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const matchingFiles = files.filter((file) => file.type?.startsWith(`${kind}/`));
    if (!matchingFiles.length) {
      alert(`This field accepts ${kind} files only.`);
      return;
    }
    const available = Math.max(0, maxItems - values.length);
    const selected = matchingFiles.slice(0, available);
    setUploading(true);
    const urls = [];
    try {
      for (const file of selected) {
        const limit = LIMIT_MB[kind] || 20;
        if (file.size > limit * 1024 * 1024) {
          alert(`${file.name} exceeds the ${limit}MB limit.`);
          continue;
        }
        urls.push(await uploadFile(apiKey, file, setProgress));
      }
      if (urls.length) onChange(multiple ? [...values, ...urls] : urls[0]);
    } catch (error) {
      alert(`Upload failed: ${error.message}`);
    } finally {
      setUploading(false);
      setProgress(0);
    }
  };

  const handleFiles = async (event) => {
    await uploadFiles(event.target.files);
    event.target.value = "";
  };

  const removeAt = (index) => onChange(multiple ? values.filter((_, itemIndex) => itemIndex !== index) : "");

  return (
    <FieldShell className={required && values.length === 0 ? "border-amber-400/25" : ""}>
      <FieldHeader name={name} schema={schema} required={required} />
      {values.length > 0 && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          {values.map((url, index) => (
            <div key={`${url}-${index}`} className="group relative aspect-[4/3] overflow-hidden rounded-lg border border-white/10 bg-black">
              {kind === "image" && <img src={url} alt={`${schema.title || kind} ${index + 1}`} className="h-full w-full object-cover" />}
              {kind === "video" && <video src={url} muted className="h-full w-full object-cover" />}
              {kind === "audio" && (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-[10px] font-semibold text-primary">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><MediaIcon kind="audio" /></svg>
                  Audio {index + 1}
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAt(index)}
                className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/85 text-sm text-white opacity-100 transition-colors hover:bg-red-500 sm:opacity-0 sm:group-hover:opacity-100"
                aria-label={`Remove ${kind} ${index + 1}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {values.length < maxItems && (
        <button
          type="button"
          data-file-dropzone={kind}
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
          onDragEnter={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!event.dataTransfer.types?.includes("Files")) return;
            dragDepthRef.current += 1;
            setDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = 0;
            setDragging(false);
            uploadFiles(event.dataTransfer.files);
          }}
          className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-[11px] font-semibold transition-colors disabled:cursor-wait disabled:opacity-60 ${dragging ? "border-primary bg-primary/10 text-primary" : "border-white/15 bg-black/30 text-zinc-400 hover:border-primary/50 hover:text-white"}`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><MediaIcon kind={kind} /></svg>
          {uploading ? `Uploading ${progress}%` : `${values.length ? "Add another" : "Choose or drop"} ${kind}`}
          {multiple && <span className="text-zinc-600">{values.length}/{maxItems}</span>}
        </button>
      )}
      <input ref={inputRef} type="file" accept={ACCEPT[kind]} multiple={multiple} className="hidden" onChange={handleFiles} />
    </FieldShell>
  );
}

export function createDefaultModelParams(model, previous = {}) {
  const next = {};
  for (const [name, schema] of Object.entries(model?.inputs || {})) {
    if (previous[name] !== undefined) next[name] = previous[name];
    else if (schema.default !== undefined) next[name] = schema.default;
    else if (schema.type === "array") next[name] = [];
    else if (schema.type === "boolean") next[name] = false;
    else next[name] = "";
  }
  return next;
}

export function useDynamicModelParams(model) {
  const [values, setValues] = useState({});
  useEffect(() => {
    if (!model) return;
    setValues((previous) => createDefaultModelParams(model, previous));
  }, [model]);
  return [values, setValues];
}

export function compactModelParams(values = {}) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => !isEmpty(value)));
}

export function findMissingRequiredInput(model, values = {}) {
  const compact = compactModelParams(values);
  return (model?.required || []).find((name) => compact[name] === undefined) || null;
}

export function mergeModelMediaParams(model, values = {}, media = {}) {
  const next = { ...values };
  const assign = (field, single, list) => {
    if (!field || !isEmpty(next[field])) return;
    const schema = model?.inputs?.[field];
    if (schema?.type === "array") {
      const items = Array.isArray(list) && list.length ? list : single ? [single] : [];
      if (items.length) next[field] = items;
    } else {
      const item = single || (Array.isArray(list) ? list[0] : null);
      if (item) next[field] = item;
    }
  };
  assign(model?.imageField, media.image, media.images);
  assign(model?.swapField, media.swap, media.swaps);
  assign(model?.videoField, media.video, media.videos);
  assign(model?.audioField, media.audio, media.audios);
  return next;
}

export function hasModelMediaValue(model, values = {}, kind) {
  return Object.entries(model?.inputs || {}).some(([name, schema]) => {
    if (mediaKindFor(name, schema) !== kind) return false;
    return !isEmpty(values[name]);
  });
}

function DynamicField({ name, schema, value, onChange, apiKey, required }) {
  const inputId = `model-input-${name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const mediaKind = mediaKindFor(name, schema);

  if (mediaKind && (schema.format === "uri" || schema.field || schema.mediaKind)) {
    return <MediaInput name={name} schema={schema} value={value} onChange={onChange} apiKey={apiKey} required={required} />;
  }

  if (schema.type === "boolean") {
    return (
      <FieldShell className="flex items-center justify-between gap-4">
        <FieldHeader name={name} schema={schema} required={required} htmlFor={inputId} />
        <button
          id={inputId}
          type="button"
          role="switch"
          aria-checked={Boolean(value)}
          aria-label={`${schema.title || humanize(name)}: ${value ? "on" : "off"}`}
          onClick={() => onChange(!value)}
          className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border border-white/10 shadow-inner transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900"
          style={{ backgroundColor: value ? "var(--color-primary)" : "#3f3f46" }}
        >
          <span
            className="block h-5 w-5 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.45)] transition-transform duration-200"
            style={{ transform: value ? "translateX(20px)" : "translateX(1px)" }}
          />
        </button>
      </FieldShell>
    );
  }

  if (Array.isArray(schema.enum)) {
    const useSegments = schema.enum.length <= 5 && schema.enum.every((option) => String(option).length <= 14);
    return (
      <FieldShell>
        <FieldHeader name={name} schema={schema} required={required} htmlFor={inputId} />
        {useSegments ? (
          <div className="mt-3 grid gap-1 rounded-lg border border-white/[0.08] bg-black/40 p-1" style={{ gridTemplateColumns: `repeat(${schema.enum.length}, minmax(0, 1fr))` }}>
            {schema.enum.map((option) => {
              const selected = String(value) === String(option);
              return (
                <button
                  key={String(option)}
                  type="button"
                  onClick={() => onChange(option)}
                  className={`min-w-0 truncate rounded-md px-2 py-2 text-[11px] font-semibold transition-colors ${selected ? "bg-zinc-700 text-white shadow" : "text-zinc-500 hover:bg-white/5 hover:text-zinc-300"}`}
                  title={String(option)}
                >
                  {String(option)}
                </button>
              );
            })}
          </div>
        ) : (
          <select
            id={inputId}
            value={value ?? ""}
            onChange={(event) => onChange(schema.enum.find((option) => String(option) === event.target.value))}
            className="mt-3 w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2.5 text-xs text-white shadow-none outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
            style={{ colorScheme: "dark" }}
          >
            {schema.enum.map((option) => <option key={String(option)} value={String(option)} className="bg-zinc-950 text-white">{String(option)}</option>)}
          </select>
        )}
      </FieldShell>
    );
  }

  if (schema.type === "array") {
    return (
      <FieldShell>
        <FieldHeader name={name} schema={schema} required={required} htmlFor={inputId} />
        <textarea
          id={inputId}
          value={(value || []).join("\n")}
          onChange={(event) => onChange(event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))}
          placeholder="One value per line"
          className="mt-3 min-h-24 w-full resize-y rounded-lg border border-white/10 bg-zinc-950 px-3 py-2.5 text-xs leading-5 text-white placeholder:text-zinc-700 outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
        />
      </FieldShell>
    );
  }

  const numeric = ["int", "integer", "float", "number"].includes(schema.type);
  const bounded = numeric && schema.minValue !== undefined && schema.maxValue !== undefined;
  if (name === "prompt" || schema.multiline) {
    return (
      <FieldShell>
        <FieldHeader name={name} schema={schema} required={required} htmlFor={inputId} />
        <textarea
          id={inputId}
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          placeholder={schema.placeholder || `Enter ${schema.title || humanize(name)}`}
          className="mt-3 min-h-28 w-full resize-y rounded-lg border border-white/10 bg-zinc-950 px-3 py-2.5 text-xs leading-5 text-white placeholder:text-zinc-700 outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
        />
      </FieldShell>
    );
  }

  return (
    <FieldShell>
      <div className="flex items-start justify-between gap-4">
        <FieldHeader name={name} schema={schema} required={required} htmlFor={inputId} />
        {bounded && <span className="shrink-0 rounded-md bg-black/40 px-2 py-1 text-[11px] font-semibold tabular-nums text-white">{value ?? schema.minValue}</span>}
      </div>
      {bounded ? (
        <input
          id={inputId}
          type="range"
          min={schema.minValue}
          max={schema.maxValue}
          step={schema.step || (schema.type === "float" ? "any" : 1)}
          value={value ?? schema.minValue}
          onChange={(event) => onChange(Number(event.target.value))}
          className="mt-4 w-full accent-[var(--primary-color)]"
        />
      ) : (
        <input
          id={inputId}
          type={numeric ? "number" : "text"}
          min={schema.minValue}
          max={schema.maxValue}
          step={schema.step || (schema.type === "float" ? "any" : 1)}
          value={value ?? ""}
          onChange={(event) => onChange(numeric && event.target.value !== "" ? Number(event.target.value) : event.target.value)}
          placeholder={schema.placeholder || `Enter ${schema.title || humanize(name)}`}
          className="mt-3 w-full rounded-lg border border-white/10 bg-zinc-950 px-3 py-2.5 text-xs text-white placeholder:text-zinc-700 outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/10"
        />
      )}
    </FieldShell>
  );
}

export default function DynamicModelInputs({ model, values, onChange, apiKey, exclude = [], layout = "grid" }) {
  if (!model) return null;
  const excluded = new Set(exclude);
  const required = new Set(model.required || []);
  const fields = Object.entries(model.inputs || {}).filter(([name]) => !excluded.has(name));
  if (!fields.length) return null;
  const setValue = (name, value) => onChange({ ...values, [name]: value });
  const orderedFields = [...fields].sort(([nameA, schemaA], [nameB, schemaB]) => {
    const priority = (name, schema) => (required.has(name) ? 0 : mediaKindFor(name, schema) ? 1 : 2);
    return priority(nameA, schemaA) - priority(nameB, schemaB);
  });

  return (
    <div className={layout === "stack" ? "flex flex-col gap-2.5" : "grid grid-cols-2 gap-2.5"}>
      {orderedFields.map(([name, schema]) => (
        <DynamicField key={name} name={name} schema={schema} value={values[name]} onChange={(value) => setValue(name, value)} apiKey={apiKey} required={required.has(name)} />
      ))}
    </div>
  );
}

function valueSummary(name, schema, value) {
  if (isEmpty(value) || value === false) return null;
  const label = schema.title || humanize(name);
  if (Array.isArray(value)) return `${label} ${value.length}`;
  if (mediaKindFor(name, schema)) return label;
  if (value === true) return label;
  const display = String(value);
  return `${label} ${display.length > 12 ? `${display.slice(0, 12)}…` : display}`;
}

export function DynamicModelInputsPanel({ model, values, onChange, apiKey, exclude = [], title = "Inputs", placement: _placement = "overlay" }) {
  const [open, setOpen] = useState(false);
  const excludedKey = exclude.join("|");
  const fields = useMemo(
    () => Object.entries(model?.inputs || {}).filter(([name]) => !exclude.includes(name)),
    [model, excludedKey],
  );
  const required = useMemo(() => new Set(model?.required || []), [model]);
  const missing = fields.filter(([name]) => required.has(name) && isEmpty(values[name]));
  const defaults = useMemo(() => createDefaultModelParams(model), [model]);
  const changedCount = fields.filter(([name]) => !isEmpty(values[name]) && JSON.stringify(values[name]) !== JSON.stringify(defaults[name])).length;
  const summaries = fields.map(([name, schema]) => valueSummary(name, schema, values[name])).filter(Boolean).slice(0, 2);

  useEffect(() => setOpen(false), [model?.id]);
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  if (!model || fields.length === 0) return null;

  const resetValues = () => {
    const next = { ...values };
    for (const [name, schema] of fields) {
      if (schema.default !== undefined) next[name] = schema.default;
      else if (schema.type === "array") next[name] = [];
      else if (schema.type === "boolean") next[name] = false;
      else next[name] = "";
    }
    onChange(next);
  };

  return (
    <div className={`w-full overflow-hidden rounded-xl border bg-[#0b0b0e] transition-colors ${open ? "border-white/15 shadow-[0_12px_36px_rgba(0,0,0,0.45)]" : missing.length ? "border-amber-400/25" : "border-white/[0.08]"}`}>
      <div className="flex min-w-0 items-center gap-2 bg-[#111114] px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-white/[0.05]"
        >
          <svg className={missing.length ? "shrink-0 text-amber-300" : "shrink-0 text-zinc-500 group-hover:text-zinc-300"} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" /><path d="M1 14h6M9 8h6M17 16h6" /></svg>
          <span className="shrink-0 text-[11px] font-semibold text-zinc-200">{title}</span>
          {missing.length > 0 ? (
            <span className="truncate text-[10px] font-medium text-amber-300/90">{missing.length} required</span>
          ) : summaries.length > 0 ? (
            <span className="hidden max-w-52 truncate text-[10px] text-zinc-500 sm:block">{summaries.join(" · ")}</span>
          ) : (
            <span className="text-[10px] text-zinc-600">{fields.length}</span>
          )}
          {changedCount > 0 && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" title={`${changedCount} changed`} />}
          <svg className={`ml-auto shrink-0 text-zinc-600 transition-transform group-hover:text-zinc-400 ${open ? "rotate-180" : ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        {open && (
          <button type="button" onClick={resetValues} disabled={changedCount === 0} className="shrink-0 rounded-md px-2 py-1.5 text-[10px] font-semibold text-zinc-500 transition-colors hover:bg-white/5 hover:text-white disabled:cursor-default disabled:opacity-30">Reset</button>
        )}
      </div>

      {open && (
        <section
          className="flex min-h-0 flex-col overflow-hidden border-t border-white/[0.08] bg-[#0b0b0e]"
          style={{ maxHeight: "50dvh" }}
          aria-label={`${model.name || model.id} inputs`}
        >
          <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] px-3.5 py-2.5">
            <p className="min-w-0 truncate text-[11px] font-medium text-zinc-400">
              {model.name || model.id} <span className="text-zinc-700">·</span> {fields.length} {fields.length === 1 ? "input" : "inputs"}
            </p>
            {missing.length > 0 && (
              <span className="shrink-0 rounded-md bg-amber-400/10 px-2 py-1 text-[10px] font-semibold text-amber-300">{missing.length} required</span>
            )}
          </div>
          <div className="custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
            <DynamicModelInputs model={model} values={values} onChange={onChange} apiKey={apiKey} exclude={exclude} />
          </div>
        </section>
      )}
    </div>
  );
}
