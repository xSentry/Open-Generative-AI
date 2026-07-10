"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import ModelProviderMark from "./ModelProviderMark.jsx";
import {
  createAgentSkill,
  deleteAgentSkill,
  deleteUserConversation,
  getTemplateAgents,
  getUserAgents,
  getUserConversations,
  getUserSkills,
  updateAgentSkill,
} from "../muapi.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
function timeAgo(dateStr) {
  if (!dateStr) return "";
  const utcStr =
    dateStr.endsWith("Z") || dateStr.includes("+") ? dateStr : dateStr + "Z";
  const diff = Math.floor((Date.now() - new Date(utcStr)) / 1000);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(utcStr).toLocaleDateString();
}

// ─── Agent Card (grid) ───────────────────────────────────────────────────────
function AgentCard({ agent, onClick, onEdit }) {
  return (
    <div className="group relative aspect-[4/5] rounded-xl cursor-pointer">
      <div
        onClick={() => onClick(agent)}
        className="absolute inset-0 rounded-xl overflow-hidden border border-white/5 bg-[#0a0a0a] transition-all group-hover:border-[var(--primary-color)]/30 group-hover:scale-[1.02] shadow-2xl"
      >
        {agent.icon_url ? (
          <img
            src={agent.icon_url}
            alt={agent.name}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-violet-500/10 to-fuchsia-500/10 flex items-center justify-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="1" className="opacity-20">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-4">
          <div className="text-[10px] font-bold text-[var(--primary-color)] uppercase tracking-wider mb-1 opacity-80">
            {agent.category || "AI Assistant"}
          </div>
          <h3 className="text-sm font-bold text-white truncate group-hover:text-[var(--primary-color)] transition-colors">
            {agent.name || "Unnamed Agent"}
          </h3>
          {agent.owner_username && (
            <p className="text-[9px] text-white/40 mt-1 uppercase tracking-tighter font-black">
              By {agent.owner_username}
            </p>
          )}
        </div>
      </div>
      
      {onEdit && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onEdit(agent);
          }}
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/60 border border-white/10 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-all hover:bg-[var(--primary-color)] hover:text-black hover:scale-110 z-10"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
      )}
    </div>
  );
}

// ─── Conversation Card (My Chats) ────────────────────────────────────────────
function ConversationCard({ conv, onClick, onDelete }) {
  const displayTitle = conv.title || "New Chat";
  const agentSlug = conv.agent_slug || conv.agent_id;
  return (
    <div
      onClick={() => onClick(agentSlug, conv.id)}
      className="group flex flex-col gap-3 bg-white/[0.03] border border-white/5 rounded-xl p-4 hover:border-[var(--primary-color)]/20 hover:bg-white/5 transition-all cursor-pointer"
    >
      <div className="flex items-center gap-3">
        <div className="relative w-10 h-10 rounded-xl overflow-hidden bg-white/5 border border-white/5 shrink-0">
          {conv.agent_icon_url ? (
            <img src={conv.agent_icon_url} alt={conv.agent_name || "Agent"} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-white/20">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-black text-[var(--primary-color)] uppercase tracking-wider truncate">
            {conv.agent_name || "Unknown Agent"}
          </p>
          <p className="text-sm font-bold text-white truncate" title={displayTitle}>
            {displayTitle}
          </p>
        </div>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDelete(conv);
          }}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-red-500/15 bg-red-500/5 text-red-300/70 opacity-0 transition-all hover:border-red-500/30 hover:bg-red-500/15 hover:text-red-200 group-hover:opacity-100"
          title="Delete chat"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
          </svg>
        </button>
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-white/5 mt-auto text-[10px] text-white/30 font-medium">
        <span>{timeAgo(conv.updated_at)}</span>
        {conv.message_count != null && <span>{conv.message_count} msgs</span>}
      </div>
    </div>
  );
}

function SkillCard({ skill, onEdit, onDelete }) {
  const type = skill.config?.type === "replicate_model" ? `${skill.config?.mode || "model"} tool` : "instruction";
  const policy = skill.config?.auto_call_policy === "never"
    ? "never auto-call"
    : skill.config?.auto_call_policy === "confirm"
      ? "ask before calling"
      : skill.config?.type === "replicate_model"
        ? "explicit auto-call"
        : null;
  return (
    <div className="group flex flex-col gap-4 rounded-lg border border-white/5 bg-white/[0.03] p-4 transition-all hover:border-[var(--primary-color)]/25 hover:bg-white/[0.05]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-[var(--primary-color)]">
            {type}
          </div>
          <h3 className="truncate text-sm font-bold text-white">{skill.name}</h3>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/40">{skill.description || "No description"}</p>
          {policy && (
            <p className="mt-2 text-[10px] font-bold uppercase tracking-wider text-white/30">{policy}</p>
          )}
        </div>
        <div className="flex shrink-0 gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onEdit(skill)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-black/30 text-white/60 hover:bg-[var(--primary-color)] hover:text-black"
            title="Edit skill"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onDelete(skill)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-red-500/20 bg-red-500/10 text-red-300 hover:bg-red-500/20"
            title="Delete skill"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
            </svg>
          </button>
        </div>
      </div>
      {skill.instructions && (
        <div className="rounded-md border border-white/5 bg-black/25 p-3 text-xs leading-5 text-white/45 line-clamp-3">
          {skill.instructions}
        </div>
      )}
    </div>
  );
}

const SkillCheckSvg = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--primary-color)" strokeWidth="4">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function SkillModelButton({ model, disabled, loading, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex min-h-[46px] w-full items-center justify-between gap-3 rounded-md border border-white/[0.08] bg-black/35 px-3 text-left text-sm text-white outline-none transition-colors hover:border-white/15 hover:bg-white/[0.04] disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-white/[0.06] text-[var(--primary-color)]">
          {model ? <ModelProviderMark model={model} glyphClassName="w-4 h-4" /> : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
              <path d="M12 3l7.5 4.25v8.5L12 20l-7.5-4.25v-8.5L12 3z" />
              <path d="M12 8v8M8.5 10.25l7 4M15.5 10.25l-7 4" />
            </svg>
          )}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-bold text-white">
            {model?.name || (loading ? "Loading models..." : "Use chat-selected model")}
          </span>
          <span className="mt-0.5 block truncate text-[10px] font-medium text-white/35">
            {model?.id || "Fallback to the selected tool model"}
          </span>
        </span>
      </span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="shrink-0 text-white/35">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

function SkillModelDropdown({ models, selectedId, onSelect, onClose, loading }) {
  const [search, setSearch] = useState("");
  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? models.filter((model) => (
        model.name?.toLowerCase().includes(needle) ||
        model.id?.toLowerCase().includes(needle) ||
        model.replicate?.owner?.toLowerCase().includes(needle)
      ))
    : models;

  const renderItem = (model) => (
    <button
      key={model.id}
      type="button"
      onClick={() => {
        onSelect(model.id);
        onClose();
      }}
      className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-3.5 text-left transition-all hover:border-white/5 hover:bg-white/5 ${
        selectedId === model.id ? "border-white/5 bg-white/5" : "border-transparent"
      }`}
    >
      <span className="flex min-w-0 items-center gap-3.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-[var(--primary-color)]/10 text-[var(--primary-color)] shadow-inner">
          <ModelProviderMark model={model} glyphClassName="w-4 h-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-bold tracking-tight text-white">{model.name || model.id}</span>
          <span className="mt-0.5 block truncate text-[10px] text-white/35">{model.id}</span>
        </span>
      </span>
      {selectedId === model.id && <SkillCheckSvg />}
    </button>
  );

  return (
    <div className="absolute bottom-[calc(100%+8px)] right-0 z-[120] max-h-[460px] w-[min(92vw,560px)] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#08080a] p-3 shadow-2xl">
      <div className="mb-2 border-b border-white/5 px-1 pb-3">
        <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/5 px-4 py-2.5 transition-colors focus-within:border-[var(--primary-color)]/50">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-white/35">
            <circle cx="11" cy="11" r="8" />
            <path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search models..."
            autoFocus
            className="w-full border-none bg-transparent p-0 text-xs text-white outline-none placeholder:text-white/25 focus:ring-0"
          />
        </div>
      </div>
      <div className="flex max-h-[370px] flex-col gap-1.5 overflow-y-auto custom-scrollbar pr-1">
        <button
          type="button"
          onClick={() => {
            onSelect("");
            onClose();
          }}
          className={`flex w-full items-center justify-between gap-3 rounded-2xl border p-3.5 text-left transition-all hover:border-white/5 hover:bg-white/5 ${
            !selectedId ? "border-white/5 bg-white/5" : "border-transparent"
          }`}
        >
          <span>
            <span className="block text-xs font-bold text-white">Use chat-selected model</span>
            <span className="mt-0.5 block text-[10px] text-white/35">Do not pin a default model to this skill</span>
          </span>
          {!selectedId && <SkillCheckSvg />}
        </button>
        {loading ? (
          <div className="px-3 py-4 text-xs font-bold text-white/35">Loading models...</div>
        ) : filtered.length ? (
          filtered.map(renderItem)
        ) : (
          <div className="px-3 py-4 text-xs font-bold text-white/35">No models found</div>
        )}
      </div>
    </div>
  );
}

function SkillModal({ skill, onClose, onSave }) {
  const [form, setForm] = useState(() => ({
    name: skill?.name || "",
    description: skill?.description || "",
    instructions: skill?.instructions || "",
    type: skill?.config?.type || "instruction",
    mode: skill?.config?.mode || "t2i",
    defaultModel: skill?.config?.default_model || "",
    autoCallPolicy: skill?.config?.auto_call_policy || "explicit",
  }));
  const [modelsByMode, setModelsByMode] = useState(null);
  const [saving, setSaving] = useState(false);
  const [openModelMenu, setOpenModelMenu] = useState(false);
  const modelMenuRef = useRef(null);
  const modeModels = modelsByMode?.[form.mode] || [];
  const selectedDefaultModel = modeModels.find((model) => model.id === form.defaultModel) || null;

  useEffect(() => {
    let cancelled = false;
    async function loadModels() {
      try {
        const response = await fetch("/api/studio/models", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json();
        if (!cancelled) setModelsByMode(data.models || null);
      } catch {
        if (!cancelled) setModelsByMode(null);
      }
    }
    loadModels();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (form.type !== "replicate_model") return;
    if (!modelsByMode) return;
    if (!form.defaultModel) return;
    if (!modeModels.some((model) => model.id === form.defaultModel)) {
      setForm((prev) => ({ ...prev, defaultModel: "" }));
    }
  }, [form.type, form.defaultModel, modeModels, modelsByMode]);

  useEffect(() => {
    if (!openModelMenu) return;
    const close = (event) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(event.target)) {
        setOpenModelMenu(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [openModelMenu]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    const config = form.type === "replicate_model"
      ? {
          type: "replicate_model",
          toolcall: true,
          mode: form.mode || "t2i",
          default_model: form.defaultModel || undefined,
          intent: form.mode === "t2t" ? "chat" : "generate_media",
          requires_explicit_user_intent: true,
          allowed_intents: form.mode === "t2t" ? ["chat"] : ["generate_media"],
          blocked_intents: ["prompt_optimize", "prompt_critique", "chat"].filter((intent) => form.mode !== "t2t" || intent !== "chat"),
          auto_call_policy: form.autoCallPolicy || "explicit",
          requires_confirmation: form.autoCallPolicy === "confirm",
          disabled_auto_call: form.autoCallPolicy === "never",
        }
      : { type: "instruction", toolcall: false };
    try {
      await onSave({
        name: form.name,
        description: form.description,
        instructions: form.instructions,
        config,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <form onSubmit={submit} className="w-full max-w-2xl overflow-visible rounded-lg border border-white/[0.08] bg-[#0b0b0d] shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] px-5 py-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-[0.18em] text-[var(--primary-color)]">
              {skill ? "Edit Skill" : "Create Skill"}
            </h3>
            <p className="mt-1 text-xs text-white/35">Private skills are only available to your agents.</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-md p-2 text-white/45 hover:bg-white/[0.07] hover:text-white">
            x
          </button>
        </div>
        <div className="grid gap-4 p-5">
          <input
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Skill name"
            required
            className="rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[var(--primary-color)]"
          />
          <textarea
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Short description shown in the agent editor"
            className="min-h-20 rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[var(--primary-color)]"
          />
          <textarea
            value={form.instructions}
            onChange={(e) => setForm((prev) => ({ ...prev, instructions: e.target.value }))}
            placeholder="Skill instructions used by the agent runtime"
            className="min-h-28 rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[var(--primary-color)]"
          />
          <div className="grid gap-3 md:grid-cols-3">
            <select
              value={form.type}
              onChange={(e) => setForm((prev) => ({ ...prev, type: e.target.value }))}
              className="rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none focus:border-[var(--primary-color)]"
            >
              <option value="instruction">Instruction</option>
              <option value="replicate_model">Replicate Tool</option>
            </select>
            <select
              value={form.mode}
              disabled={form.type !== "replicate_model"}
              onChange={(e) => setForm((prev) => ({ ...prev, mode: e.target.value, defaultModel: "" }))}
              className="rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none disabled:opacity-40 focus:border-[var(--primary-color)]"
            >
              <option value="t2i">Text to Image</option>
              <option value="i2i">Image to Image</option>
              <option value="t2t">Text</option>
            </select>
            <div ref={modelMenuRef} className="relative">
              <SkillModelButton
                model={selectedDefaultModel}
                loading={!modelsByMode}
                disabled={form.type !== "replicate_model"}
                onClick={() => setOpenModelMenu((open) => !open)}
              />
              {openModelMenu && form.type === "replicate_model" && (
                <SkillModelDropdown
                  models={modeModels}
                  selectedId={form.defaultModel}
                  loading={!modelsByMode}
                  onClose={() => setOpenModelMenu(false)}
                  onSelect={(id) => setForm((prev) => ({ ...prev, defaultModel: id }))}
                />
              )}
            </div>
          </div>
          <select
            value={form.autoCallPolicy}
            disabled={form.type !== "replicate_model"}
            onChange={(e) => setForm((prev) => ({ ...prev, autoCallPolicy: e.target.value }))}
            className="rounded-md border border-white/[0.08] bg-black/35 px-4 py-3 text-sm text-white outline-none disabled:opacity-40 focus:border-[var(--primary-color)]"
          >
            <option value="explicit">Auto-call when explicit</option>
            <option value="confirm">Ask before tool call</option>
            <option value="never">Never auto-call</option>
          </select>
        </div>
        <div className="flex justify-end gap-3 border-t border-white/[0.08] bg-black/25 px-5 py-4">
          <button type="button" onClick={onClose} className="rounded-md px-4 py-2 text-xs font-bold text-white/45 hover:bg-white/[0.06] hover:text-white">Cancel</button>
          <button disabled={saving} className="rounded-md bg-[var(--primary-color)] px-5 py-2 text-xs font-black uppercase tracking-widest text-black hover:bg-[var(--primary-light-color)] disabled:opacity-50">
            {saving ? "Saving" : "Save Skill"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
const TABS = ["templates", "my-agents", "my-chats", "my-skills"];

export default function AgentStudio({ apiKey }) {
  const router = useRouter();

  const [activeMainTab, setActiveMainTab] = useState("templates");
  const [agents, setAgents] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [skills, setSkills] = useState([]);
  const [skillModal, setSkillModal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Navigate to the standalone /agents page — AiAgent handles its own routing there
  const handleSelectAgent = useCallback(
    (agent) => {
      const id = agent.agent_id || agent.id;
      router.push(`/agents/${id}`);
    },
    [router]
  );

  const handleEditAgent = useCallback(
    (agent) => {
      const id = agent.agent_id || agent.id;
      router.push(`/agents/edit/${id}`);
    },
    [router]
  );

  const handleCreateAgent = useCallback(() => {
    router.push("/agents/create");
  }, [router]);

  const handleCreateSkill = useCallback(() => {
    setSkillModal({ mode: "create", skill: null });
  }, []);

  const handleOpenConversation = useCallback(
    (agentSlug, convId) => {
      router.push(`/agents/${agentSlug}/${convId}`);
    },
    [router]
  );

  const handleDeleteConversation = useCallback(async (conversation) => {
    if (!window.confirm(`Delete chat "${conversation.title || "New Chat"}"?`)) return;
    await deleteUserConversation(apiKey, conversation.id);
    setConversations((current) => current.filter((item) => item.id !== conversation.id));
  }, [apiKey]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setAgents([]);
      setConversations([]);
      setSkills([]);
      try {
        if (activeMainTab === "templates") {
          const data = await getTemplateAgents(apiKey);
          if (!cancelled) setAgents(data);
        } else if (activeMainTab === "my-agents") {
          const data = await getUserAgents(apiKey);
          if (!cancelled) setAgents(data);
        } else if (activeMainTab === "my-chats") {
          const data = await getUserConversations(apiKey);
          if (!cancelled) setConversations(data);
        } else if (activeMainTab === "my-skills") {
          const data = await getUserSkills(apiKey);
          if (!cancelled) setSkills(data);
        }
      } catch (err) {
        console.error("AgentStudio load error:", err);
        if (!cancelled) setError(err.message || "Failed to load.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [apiKey, activeMainTab]);

  const reloadSkills = useCallback(async () => {
    const data = await getUserSkills(apiKey);
    setSkills(data);
  }, [apiKey]);

  const handleSaveSkill = useCallback(async (payload) => {
    if (skillModal?.skill?.id) {
      await updateAgentSkill(apiKey, skillModal.skill.id, payload);
    } else {
      await createAgentSkill(apiKey, payload);
    }
    setSkillModal(null);
    setActiveMainTab("my-skills");
    await reloadSkills();
  }, [apiKey, reloadSkills, skillModal]);

  const handleDeleteSkill = useCallback(async (skill) => {
    if (!window.confirm(`Delete skill "${skill.name}"? Agents using it will lose that skill.`)) return;
    await deleteAgentSkill(apiKey, skill.id);
    await reloadSkills();
  }, [apiKey, reloadSkills]);

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col bg-[#030303] text-white">
      {/* Header */}
      <div className="flex-shrink-0 h-16 border-b border-white/5 flex items-center justify-between px-8 bg-black/40">
        <div className="flex items-center gap-8 h-full">
          <h2 className="text-sm font-black uppercase tracking-[0.2em] text-[var(--primary-color)]">
            Agents
          </h2>
          <div className="flex gap-1 bg-white/5 p-1 rounded-xl">
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveMainTab(tab)}
                className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-lg transition-all ${
                  activeMainTab === tab
                    ? "bg-white text-black shadow-xl"
                    : "text-white/40 hover:text-white hover:bg-white/5"
                }`}
              >
                {tab.replace(/-/g, " ")}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCreateSkill}
            className="px-4 py-2 border border-white/10 bg-white/[0.03] text-white/65 text-[10px] font-black uppercase tracking-widest rounded-lg hover:bg-white/[0.07] hover:text-white transition-all active:scale-95 flex items-center gap-2"
          >
            <span className="text-sm">+</span>
            Skill
          </button>
          <button
            onClick={handleCreateAgent}
            className="px-6 py-2 bg-[var(--primary-color)] text-black text-[10px] font-black uppercase tracking-widest rounded-lg hover:bg-[var(--primary-light-color)] transition-all active:scale-95 flex items-center gap-2"
          >
            <span className="text-sm">+</span>
            Create
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-8">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <div className="w-10 h-10 border-2 border-white/5 border-t-[var(--primary-color)] rounded-full animate-spin" />
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center text-white/20 gap-4">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="text-xs font-bold uppercase tracking-widest">{error}</p>
            <button
              onClick={() => setActiveMainTab(activeMainTab)} // retrigger effect
              className="text-[10px] text-white/40 hover:text-white border border-white/10 px-4 py-2 rounded-lg transition-colors"
            >
              Retry
            </button>
          </div>
        ) : activeMainTab === "my-skills" ? (
          skills.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-white/10 gap-4">
              <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.5">
                <path d="M12 2v20M2 12h20" />
              </svg>
              <p className="text-[10px] font-black uppercase tracking-[0.3em]">No custom skills yet</p>
              <button
                onClick={handleCreateSkill}
                className="text-[10px] text-[var(--primary-color)] hover:text-white border border-[var(--primary-color)]/20 hover:border-white/20 px-4 py-2 rounded-lg transition-colors"
              >
                Create Skill
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 max-w-[1600px] mx-auto">
              {skills.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onEdit={(item) => setSkillModal({ mode: "edit", skill: item })}
                  onDelete={handleDeleteSkill}
                />
              ))}
            </div>
          )
        ) : activeMainTab === "my-chats" ? (
          // ── My Chats view ─────────────────────────────────────────────────
          conversations.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-white/10 gap-4">
              <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <p className="text-[10px] font-black uppercase tracking-[0.3em]">No chats yet</p>
              <button
                onClick={() => setActiveMainTab("templates")}
                className="text-[10px] text-[var(--primary-color)] hover:text-white border border-[var(--primary-color)]/20 hover:border-white/20 px-4 py-2 rounded-lg transition-colors"
              >
                Browse Templates
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 max-w-[1600px] mx-auto">
              {conversations.map((conv) => (
                <ConversationCard
                  key={conv.id}
                  conv={conv}
                  onClick={handleOpenConversation}
                  onDelete={handleDeleteConversation}
                />
              ))}
            </div>
          )
        ) : (
          // ── Agents grid (templates / my-agents) ───────────────────────────
          agents.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-white/10 gap-4">
              <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="0.5">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
              </svg>
              <p className="text-[10px] font-black uppercase tracking-[0.3em]">No agents found</p>
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,220px))] justify-center gap-6 max-w-[1600px] mx-auto">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.agent_id || agent.id}
                  agent={agent}
                  onClick={handleSelectAgent}
                />
              ))}
            </div>
          )
        )}
      </div>
      {skillModal && (
        <SkillModal
          skill={skillModal.skill}
          onClose={() => setSkillModal(null)}
          onSave={handleSaveSkill}
        />
      )}
    </div>
  );
}
