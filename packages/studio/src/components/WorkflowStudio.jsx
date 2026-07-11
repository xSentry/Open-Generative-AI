"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  getTemplateWorkflows,
  getUserWorkflows,
  getPublishedWorkflows,
  createWorkflow,
  updateWorkflowName,
  deleteWorkflow,
  setWorkflowTemplate,
  cloneWorkflow,
  getWorkflowInputs,
  executeWorkflow,
  getAllNodeSchemas,
  getWorkflowData,
} from "../muapi.js";
import dynamic from "next/dynamic";

const WorkflowUI = dynamic(() => import("./WorkflowUI"), {
  ssr: false,
  loading: () => (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 border-4 border-white/5 border-t-[var(--primary-color)] rounded-full animate-spin" />
        <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">
          Loading Builder...
        </div>
      </div>
    </div>
  ),
});

function WorkflowCard({ workflow, onClick, activeTab, onRename, onDelete, onToggleTemplate, onClone }) {
  const [showOptions, setShowOptions] = useState(false);
  const isShared = activeTab === 'templates' || activeTab === 'published';
  // A published template you own stays in My Workflows but is frozen: you can
  // rename or delete it, but not open it in the editor.
  const isLockedTemplate = activeTab === 'my-workflows' && workflow.is_template;

  return (
    <div
      onClick={() => { if (!isLockedTemplate) onClick(workflow); }}
      className={`group relative aspect-[3/4] rounded-lg overflow-hidden border border-white/5 bg-[#0a0a0a] transition-all hover:border-[var(--primary-color)]/30 shadow-2xl ${
        isLockedTemplate ? 'cursor-default' : 'cursor-pointer hover:scale-[1.02]'
      }`}
    >
      {workflow.thumbnail ? (
        <img
          src={workflow.thumbnail}
          alt={workflow.name}
          className="absolute inset-0 w-full h-full object-cover transition-transform duration-700 group-hover:scale-110"
        />
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-blue-500/10 to-purple-500/10 flex items-center justify-center">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="opacity-20"
          >
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        </div>
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
      
      {/* Options Dropdown for My Workflows */}
      {activeTab === 'my-workflows' && (
        <div 
          className="absolute top-2 right-2 z-30"
          onClick={(e) => { e.stopPropagation(); }}
        >
          <button
            onClick={() => setShowOptions(!showOptions)}
            onBlur={() => setTimeout(() => setShowOptions(false), 200)}
            className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-md border border-white/10 flex items-center justify-center text-white/60 hover:text-white transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          
          {showOptions && (
            <div className="absolute top-10 right-0 w-32 bg-[#111] border border-white/10 rounded-lg shadow-2xl py-1 animate-in fade-in zoom-in duration-200">
              <button
                onClick={() => onRename(workflow)}
                className="w-full px-4 py-2 text-left text-[11px] font-bold text-white/70 hover:text-[var(--primary-color)] hover:bg-white/5 transition-colors flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
                  <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
                </svg>
                Rename
              </button>
              {!workflow.is_template && (
                <button
                  onClick={() => onToggleTemplate?.(workflow)}
                  className="w-full px-4 py-2 text-left text-[11px] font-bold text-white/70 hover:text-[var(--primary-color)] hover:bg-white/5 transition-colors flex items-center gap-2"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21.4 8 14 2 9.4h7.6L12 2z" />
                  </svg>
                  Publish as Template
                </button>
              )}
              <button
                onClick={() => onDelete(workflow.id)}
                className="w-full px-4 py-2 text-left text-[11px] font-bold text-red-500 hover:bg-red-500/10 transition-colors flex items-center gap-2"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
                </svg>
                Delete
              </button>
            </div>
          )}
        </div>
      )}

      {/* "Template" badge on your own published templates */}
      {activeTab === 'my-workflows' && workflow.is_template && (
        <div className="absolute top-2 left-2 z-20 flex items-center gap-1 bg-[var(--primary-color)]/20 backdrop-blur-md px-2 py-1 rounded-full border border-[var(--primary-color)]/30">
          <span className="text-[9px] font-black text-[var(--primary-color)] uppercase tracking-widest">Template</span>
        </div>
      )}

      {/* Community Profile Info */}
      {activeTab === 'published' && workflow.user_name && (
        <div className="absolute top-2 left-2 z-20 flex items-center gap-2 bg-black/40 backdrop-blur-md px-2 py-1 rounded-full border border-white/10">
          <img src={workflow.user_profile || "/user_profile.png"} alt="profile" className="w-4 h-4 rounded-full" />
          <span className="text-[9px] font-black text-white/80 uppercase tracking-widest">{workflow.user_name}</span>
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 p-4">
        <div className="text-[10px] font-bold text-[var(--primary-color)] uppercase tracking-wider mb-1 opacity-80">
          {workflow.category || "General"}
        </div>
        <h3 className="text-sm font-bold text-white truncate group-hover:text-[var(--primary-color)] transition-colors">
          {workflow.name || "Untitled Flow"}
        </h3>

        {/* Clone-to-own action on shared (template / community) lists */}
        {isShared && (
          <button
            onClick={(e) => { e.stopPropagation(); onClone?.(workflow); }}
            className="mt-3 w-full px-3 py-2 bg-[var(--primary-color)] text-black text-[10px] font-black uppercase tracking-widest rounded-md opacity-0 group-hover:opacity-100 transition-all hover:bg-white flex items-center justify-center gap-1.5"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
            Use Template
          </button>
        )}
      </div>
    </div>
  );
}

function savedMarkedOutputs(workflowDef) {
  const nodes = workflowDef?.data?.nodes || workflowDef?.nodes || [];
  const outputs = [];
  for (const node of nodes) {
    if (node?.input_params?.make_output !== true) continue;
    const nodeOutputs = node?.output_params?.outputs;
    if (Array.isArray(nodeOutputs)) {
      outputs.push(...nodeOutputs.map((output) => ({
        ...output,
        node_id: node.id,
        node_name: workflowNodeLabel(node),
      })));
    }
  }
  return outputs;
}

function markedWorkflowOutputNodes(workflowDef) {
  const nodes = workflowDef?.data?.nodes || workflowDef?.nodes || [];
  return nodes
    .filter((node) => node?.input_params?.make_output === true)
    .map((node) => ({
      node_id: node.id,
      node_name: workflowNodeLabel(node),
      category: node.category || String(node.type || "").replace(/Node$/, ""),
    }));
}

function workflowNodeLabel(node = {}) {
  const explicit =
    node.title ||
    node.input_params?.title ||
    node.input_params?.label ||
    node.label ||
    node.name;
  if (explicit) return explicit;

  const base = {
    text: "Text",
    image: "Image",
    video: "Video",
    audio: "Audio",
    api: "API",
    utility: "Utility",
  }[node.category] || "Node";
  const index = String(node.id || "").replace(/^\D+/g, "");
  return index ? `${base} ${index}` : base;
}

function outputKindLabel(type) {
  if (type === "image_url") return "Image";
  if (type === "video_url") return "Video";
  if (type === "audio_url") return "Audio";
  if (!type) return "Output";
  return "Text";
}

function expectedOutputTypeForNode(node = {}) {
  if (node.category === "image") return "image_url";
  if (node.category === "video") return "video_url";
  if (node.category === "audio") return "audio_url";
  return null;
}

function latestNodeRun(result, nodeId) {
  const history = result?.nodes?.[nodeId];
  return Array.isArray(history) && history.length > 0 ? history[history.length - 1] : null;
}

function outputCardStatus({ output, nodeRun, isExecuting, resultStatus, hasError }) {
  const status = String(nodeRun?.status || "").toLowerCase();
  if (status === "failed" || status === "error" || nodeRun?.error) return "error";
  if (output) return "ready";
  if (isExecuting || status === "processing" || status === "queued" || status === "running") return "generating";
  if (hasError) return "error";
  if (["failed", "error"].includes(String(resultStatus || "").toLowerCase())) return "error";
  return "empty";
}

function buildOutputCards(markedNodes, outputs, result, isExecuting, hasError = false) {
  const cards = [];
  const usedOutputs = new Set();

  for (const node of markedNodes) {
    const nodeOutputs = outputs
      .map((output, index) => ({ output, index }))
      .filter(({ output }) => output?.node_id === node.node_id);
    const nodeRun = latestNodeRun(result, node.node_id);

    if (nodeOutputs.length === 0) {
      cards.push({
        key: node.node_id,
        node,
        output: null,
        status: outputCardStatus({ nodeRun, isExecuting, resultStatus: result?.status, hasError }),
        error: nodeRun?.error || null,
        type: expectedOutputTypeForNode(node),
      });
      continue;
    }

    for (const { output, index } of nodeOutputs) {
      usedOutputs.add(index);
      cards.push({
        key: `${node.node_id}:${output.id || index}`,
        node,
        output,
        status: outputCardStatus({ output, nodeRun, isExecuting, resultStatus: result?.status, hasError }),
        error: nodeRun?.error || null,
        type: output.type,
      });
    }
  }

  outputs.forEach((output, index) => {
    if (usedOutputs.has(index)) return;
    cards.push({
      key: output.id || output.node_id || `output-${index}`,
      node: {
        node_id: output.node_id || null,
        node_name: output.node_name || `Output ${index + 1}`,
      },
      output,
      status: "ready",
      error: null,
      type: output.type,
    });
  });

  return cards;
}

function workflowInputKind(key, prop = {}) {
  const field = `${prop.field || ""} ${key}`.toLowerCase();
  if (field.includes("image")) return "Image";
  if (field.includes("video")) return "Video";
  if (field.includes("audio")) return "Audio";
  if (field.includes("prompt") || field.includes("text")) return "Text";
  return prop.type === "string" ? "Text" : "Value";
}

function workflowInputPlaceholder(key, prop = {}) {
  if (prop.description) return prop.description;
  const kind = workflowInputKind(key, prop);
  if (kind === "Image") return "Paste an image URL...";
  if (kind === "Video") return "Paste a video URL...";
  if (kind === "Audio") return "Paste an audio URL...";
  return `Enter ${prop.title || key}...`;
}

function normalizeWorkflowTab(tab) {
  return tab === "builder" || tab === "playground" ? tab : null;
}

function WorkflowOutputCard({ card }) {
  const out = card.output;
  const status = card.status;
  const isGenerating = status === "generating";
  const isError = status === "error";
  const isEmpty = status === "empty";
  const canOpen = typeof out?.value === "string" && /^https?:\/\//.test(out.value);

  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-center justify-between gap-3 min-w-0">
        <div className="text-[10px] font-black text-white/55 uppercase tracking-widest truncate">
          {card.node.node_name || card.node.node_id || "Output"}
        </div>
        <div className="shrink-0 text-[9px] font-black text-white/25 uppercase tracking-wider">
          {outputKindLabel(card.type)}
        </div>
      </div>
      <div
        className={`group relative bg-white/5 border rounded-lg overflow-hidden transition-all shadow-xl ${
          isError
            ? "border-red-500/25"
            : isGenerating
              ? "border-[var(--primary-color)]/35"
              : "border-white/10 hover:border-[var(--primary-color)]/35"
        }`}
      >
        {out?.type === "image_url" ? (
          <img
            src={out.value}
            className="w-full aspect-[4/3] object-cover"
            alt={card.node.node_name || "Output"}
          />
        ) : out?.type === "video_url" ? (
          <video
            src={out.value}
            controls
            className="w-full aspect-[4/3] object-cover bg-black"
          />
        ) : out?.type === "audio_url" ? (
          <div className="p-4 min-h-[120px] flex items-center bg-black/20">
            <audio src={out.value} controls className="w-full" />
          </div>
        ) : out ? (
          <div className="p-4 min-h-[140px] max-h-[220px] overflow-auto text-sm leading-relaxed text-white/70 whitespace-pre-wrap break-words">
            {typeof out.value === "string" ? out.value : JSON.stringify(out.value, null, 2)}
          </div>
        ) : (
          <div className="aspect-[4/3] min-h-[140px] flex items-center justify-center bg-black/20">
            <div className="flex flex-col items-center gap-3 text-center px-5">
              {isGenerating ? (
                <div className="w-8 h-8 border-2 border-white/10 border-t-[var(--primary-color)] rounded-full animate-spin" />
              ) : isError ? (
                <div className="w-8 h-8 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 8v5" />
                    <path d="M12 16h.01" />
                  </svg>
                </div>
              ) : (
                <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/20">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                  </svg>
                </div>
              )}
              <div>
                <p className={`text-xs font-black uppercase tracking-widest ${
                  isError ? "text-red-400" : isGenerating ? "text-[var(--primary-color)]" : "text-white/35"
                }`}>
                  {isError ? "Error" : isGenerating ? "Generating" : isEmpty ? "No Output" : "Waiting"}
                </p>
                {card.error && (
                  <p className="text-[11px] text-red-300/60 mt-2 leading-relaxed line-clamp-3">
                    {card.error}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {canOpen && (
          <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/85 to-transparent translate-y-full group-hover:translate-y-0 transition-transform">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[9px] font-black text-[var(--primary-color)] uppercase tracking-widest truncate">
                {out.id}
              </span>
              <a
                href={out.value}
                target="_blank"
                rel="noreferrer"
                className="w-8 h-8 rounded-md bg-white/10 flex items-center justify-center hover:bg-[var(--primary-color)] hover:text-black transition-colors shrink-0"
                title="Open output"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6M15 3h6v6M10 14L21 3" />
                </svg>
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function WorkflowStudio({ apiKey, provider = 'replicate', isHeaderVisible = true, onToggleHeader }) {
  const params = useParams();
  const router = useRouter();
  const slug = params?.slug || [];
  const idFromParams = params?.id;     // exists on /workflow/[id]/[tab] route
  const tabFromParams = params?.tab;   // exists on /workflow/[id]/[tab] route
  
  // Robustly extract ID and Tab from either route structure
  const getWorkflowInfo = useCallback(() => {
    // Priority 1: Dedicated /workflow/[id]/[tab] route  
    if (idFromParams) {
      return { id: idFromParams, tab: tabFromParams || null };
    }
    // Priority 2: Catch-all /studio/[[...slug]] route
    const wfIndex = slug.findIndex(s => s === 'workflows' || s === 'workflow');
    if (wfIndex === -1) return { id: null, tab: null };
    return {
      id: slug[wfIndex + 1] || null,
      tab: slug[wfIndex + 2] || null
    };
  }, [slug, idFromParams, tabFromParams]);

  const { id: urlWorkflowId, tab: urlTab } = getWorkflowInfo();

  const [workflows, setWorkflows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedWorkflow, setSelectedWorkflow] = useState(null);
  const [activeSubTab, setActiveSubTab] = useState("playground"); // 'playground' | 'builder'
  const [activeMainTab, setActiveMainTab] = useState("templates"); // 'templates' | 'my-workflows' | 'published'
  const [renamingWorkflow, setRenamingWorkflow] = useState(null);
  const [newWorkflowName, setNewWorkflowName] = useState("");
  const [isDeletingId, setIsDeletingId] = useState(null);
  const [inputSchema, setInputSchema] = useState(null);
  const [nodeSchemas, setNodeSchemas] = useState(null);
  const [workflowDef, setWorkflowDef] = useState(null);
  const [formData, setFormData] = useState({});
  const [isExecuting, setIsExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  
  const openWorkflowTab = useCallback(
    (tab) => {
      const nextTab = normalizeWorkflowTab(tab) || "playground";
      setActiveSubTab(nextTab);
      if (selectedWorkflow?.id) {
        router.push(`/workflow/${selectedWorkflow.id}/${nextTab}`);
      }
    },
    [router, selectedWorkflow?.id],
  );

  const handleWorkflowSaved = useCallback((saved) => {
    const savedId = saved?.workflow_id || saved?.id || selectedWorkflow?.id;
    const savedName = saved?.name;
    if (!savedId) return;

    if (savedName) {
      setSelectedWorkflow((prev) =>
        prev?.id === savedId ? { ...prev, name: savedName } : prev,
      );
      setWorkflows((prev) =>
        prev.map((wf) => (wf.id === savedId ? { ...wf, name: savedName } : wf)),
      );
      setWorkflowDef((prev) =>
        prev ? { ...prev, name: savedName } : prev,
      );
    }
  }, [selectedWorkflow?.id]);

  // Handlers defined early so they can be used in effects
  const handleSelectWorkflow = useCallback(
    async (wf, fromUrl = false) => {
      setSelectedWorkflow(wf);
      setResult(null);
      setError(null);
      
      const targetTab = normalizeWorkflowTab(urlTab) || "playground";
      setActiveSubTab(targetTab);

      if (!fromUrl) {
        // Always route to /workflow/[id] so the builder library's useParams().id resolves correctly
        router.push(`/workflow/${wf.id}/${targetTab}`);
      }
    },
    [router, urlTab],
  );

  useEffect(() => {
    const nextTab = normalizeWorkflowTab(urlTab);
    if (urlWorkflowId && nextTab && activeSubTab !== nextTab) {
      setActiveSubTab(nextTab);
    }
  }, [urlWorkflowId, urlTab, activeSubTab]);

  // Dedicated data fetching effect for the active workflow
  useEffect(() => {
    // NOTE: don't gate on `apiKey`. In the self-hosted setup the provider key is
    // resolved server-side from the session, so the client has no apiKey and the
    // builder must still load (otherwise it hangs on "Loading Builder...").
    if (!selectedWorkflow?.id) return;

    async function loadWorkflowDetails() {
      try {
        setLoading(true);
        const wfId = selectedWorkflow.id;
        
        // Fetch everything in parallel with allSettled so one failure doesn't block the others
        const results = await Promise.allSettled([
          getWorkflowInputs(apiKey, wfId),
          getAllNodeSchemas(apiKey, wfId),
          getWorkflowData(apiKey, wfId)
        ]);

        // Process Input Schema
        if (results[0].status === 'fulfilled') {
          const response = results[0].value;
          const schema = response.input_data || response;
          setInputSchema(schema);

          const initial = {};
          Object.entries(schema.properties || {}).forEach(([key, prop]) => {
            initial[key] =
              prop.default ||
              (Array.isArray(prop.examples) ? prop.examples[0] : prop.examples) ||
              "";
          });
          setFormData(initial);
        } else {
          console.warn("Input schema not available for this workflow:", results[0].reason);
          setInputSchema(null);
          setFormData({});
        }

        // Process Builder State
        const nodes = results[1].status === 'fulfilled' ? results[1].value : [];
        const def = results[2].status === 'fulfilled' ? results[2].value : { nodes: [], edges: [] };

        setNodeSchemas(nodes);
        setWorkflowDef(def);

        if (results[1].status === 'rejected' || results[2].status === 'rejected') {
          console.error("Builder components failed to load:", results[1].reason, results[2].reason);
          if (!nodes.length && !def.nodes?.length) {
             setError("Failed to load full builder data. Some features may be disabled.");
          }
        }
      } catch (err) {
        console.error("Critical error loading pulse details:", err);
        setError("Critical error loading builder: " + err.message);
        setNodeSchemas([]);
        setWorkflowDef({ nodes: [], edges: [] });
      } finally {
        setLoading(false);
      }
    }

    loadWorkflowDetails();
  }, [selectedWorkflow?.id, apiKey]);

  const handleCreateWorkflow = useCallback(
    async (fromUrl = false) => {
      try {
        setLoading(true);
        if (!fromUrl) {
          const payload = {
            workflow_id: null,
            name: "Untitled Workflow",
            edges: [],
            data: { nodes: [] },
          };
          const response = await createWorkflow(apiKey, payload);
          // Route to /workflow/[id] so useParams().id works in the builder library
          router.push(`/workflow/${response.workflow_id}/builder`);
          return;
        }

        // Initialize state for the new flow
        setSelectedWorkflow({ id: null, name: "Untitled Workflow" });
        setNodeSchemas([]);
        setWorkflowDef({ nodes: [], edges: [] });
        setActiveSubTab("builder");
      } catch (err) {
        setError("Failed to initialize workflow: " + err.message);
      } finally {
        setLoading(false);
      }
    },
    [apiKey, router],
  );

  const handleDeleteWorkflow = async (wfId) => {
    if (!confirm("Are you sure you want to delete this workflow?")) return;
    setIsDeletingId(wfId);
    try {
      await deleteWorkflow(apiKey, wfId);
      setWorkflows((prev) => prev.filter((w) => w.id !== wfId));
    } catch (err) {
      console.error("Delete failed:", err);
      alert("Failed to delete workflow");
    } finally {
      setIsDeletingId(null);
    }
  };

  const handleRenameWorkflow = async (e) => {
    e?.preventDefault();
    if (!renamingWorkflow || !newWorkflowName.trim()) return;

    const wfId = renamingWorkflow.id;
    try {
      await updateWorkflowName(apiKey, wfId, newWorkflowName);
      setWorkflows((prev) =>
        prev.map((w) => (w.id === wfId ? { ...w, name: newWorkflowName } : w)),
      );
      if (selectedWorkflow?.id === wfId) {
        setSelectedWorkflow({ ...selectedWorkflow, name: newWorkflowName });
      }
      setRenamingWorkflow(null);
    } catch (err) {
      console.error("Rename failed:", err);
      alert("Failed to rename workflow");
    }
  };

  // Toggle one of your own workflows as a provider-wide template so every user
  // sees it under Templates (and can clone it).
  const handleToggleTemplate = async (wf) => {
    const next = !wf.is_template;
    try {
      await setWorkflowTemplate(apiKey, wf.id, next);
      setWorkflows((prev) =>
        prev.map((w) => (w.id === wf.id ? { ...w, is_template: next } : w)),
      );
    } catch (err) {
      console.error("Template toggle failed:", err);
      alert("Failed to update template status");
    }
  };

  // Clone a template / community workflow into a new private workflow and open
  // it in the builder.
  const handleCloneWorkflow = async (wf) => {
    try {
      const res = await cloneWorkflow(apiKey, wf.id);
      if (res?.workflow_id) {
        router.push(`/workflow/${res.workflow_id}/builder`);
      }
    } catch (err) {
      console.error("Clone failed:", err);
      alert("Failed to use this template");
    }
  };

  // KEY FIX: If the user is on /studio/workflows/[id], redirect to /workflow/[id]
  // so the builder library's useParams().id resolves correctly, preventing duplicate creation.
  useEffect(() => {
    if (typeof window !== 'undefined' && urlWorkflowId && urlWorkflowId !== 'new') {
      const path = window.location.pathname;
      if (path.startsWith('/studio/workflows/')) {
        const tab = urlTab || 'builder';
        router.replace(`/workflow/${urlWorkflowId}/${tab}`);
      }
    }
  }, [urlWorkflowId, urlTab, router]);

  // 1. Sync state with URL on mount or URL change
  useEffect(() => {
    if (loading) return;

    if (urlWorkflowId) {
      if (urlWorkflowId === "new") {
        if (!selectedWorkflow || selectedWorkflow.id !== null) {
          handleCreateWorkflow(true);
        }
      } else {
        const found = workflows.find((wf) => wf.id === urlWorkflowId);
        if (found) {
          if (!selectedWorkflow || selectedWorkflow.id !== urlWorkflowId) {
            handleSelectWorkflow(found, true);
          }
        } else if (
          !selectedWorkflow ||
          selectedWorkflow.id !== urlWorkflowId
        ) {
          // Fallback for deep-linking: attempt to open even if not in the current tab's list
          // handleSelectWorkflow fetches official name/data anyway
          handleSelectWorkflow(
            { id: urlWorkflowId, name: "Loading..." },
            true,
          );
        }
      }
    } else if (selectedWorkflow) {
      setSelectedWorkflow(null);
    }
  }, [
    urlWorkflowId,
    workflows,
    loading,
    selectedWorkflow,
    handleCreateWorkflow,
    handleSelectWorkflow,
  ]);

  // Handle reload on exit to clear builder CSS
  useEffect(() => {
    const fromBuilder = sessionStorage.getItem("fromWorkflowBuilder");
    if (fromBuilder && !urlWorkflowId) {
      sessionStorage.removeItem("fromWorkflowBuilder");
      window.location.reload();
    }
  }, [urlWorkflowId]);

  // The Community tab is MuAPI-only; if the provider isn't MuAPI, never sit on it.
  useEffect(() => {
    if (provider !== 'muapi' && activeMainTab === 'published') {
      setActiveMainTab('templates');
    }
  }, [provider, activeMainTab]);

  useEffect(() => {
    async function loadWorkflows() {
      try {
        setLoading(true);
        let data = [];
        if (activeMainTab === "templates") {
          data = await getTemplateWorkflows(apiKey);
        } else if (activeMainTab === "my-workflows") {
          data = await getUserWorkflows(apiKey);
        } else if (activeMainTab === "published") {
          data = await getPublishedWorkflows(apiKey);
        }
        setWorkflows(data);
      } catch (err) {
        console.error("Failed to load workflows:", err);
        setError("Failed to load workflows list.");
      } finally {
        setLoading(false);
      }
    }
    loadWorkflows();
  }, [apiKey, activeMainTab]);

  const handleRun = async (e) => {
    e.preventDefault();
    if (isExecuting) return;

    setIsExecuting(true);
    setError(null);
    setResult(null);

    try {
      const inputs = {};
      Object.entries(formData).forEach(([key, value]) => {
        if (!value) return;
        if (key.startsWith("text")) inputs[key] = { prompt: value };
        else if (key.startsWith("image")) inputs[key] = { image_url: value };
        else if (key.startsWith("video")) inputs[key] = { video_url: value };
        else inputs[key] = value;
      });

      const data = await executeWorkflow(apiKey, selectedWorkflow.id, inputs, {
        onUpdate: (update) => setResult(update),
      });
      setResult(data);
    } catch (err) {
      console.error("Execution failed:", err);
      setError(err.message || "Execution failed");
    } finally {
      setIsExecuting(false);
    }
  };

  if (loading && !selectedWorkflow) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="animate-spin text-[var(--primary-color)] text-3xl">◌</div>
      </div>
    );
  }

  if (selectedWorkflow) {
    const markedOutputNodes = markedWorkflowOutputNodes(workflowDef);
    const restoredOutputs = savedMarkedOutputs(workflowDef);
    const visibleResult = result || (!isExecuting && restoredOutputs.length > 0
      ? { status: 'completed', outputs: restoredOutputs, restored: true }
      : null);
    const outputCards = buildOutputCards(
      markedOutputNodes,
      visibleResult?.outputs || [],
      visibleResult,
      isExecuting,
      !!error,
    );
    const showOutputCards = outputCards.length > 0;
    const outputPanelTitle = visibleResult?.restored ? "Saved Outputs" : "Workflow Outputs";
    const outputPanelState = error
      ? "ERROR"
      : isExecuting
        ? "GENERATING"
        : visibleResult?.restored
          ? "READY"
          : visibleResult
            ? "COMPLETED"
            : "READY";
    const outputPanelStateClass = error
      ? "bg-red-500/10 text-red-400 border-red-500/20"
      : isExecuting
        ? "bg-[var(--primary-color)]/10 text-[var(--primary-color)] border-[var(--primary-color)]/20"
        : "bg-green-500/10 text-green-500 border-green-500/20";
    const inputEntries = Object.entries(inputSchema?.properties || {});

    return (
      <div className="h-full flex flex-col bg-[#030303] text-white">
        {/* Immersive Sub-header / Floating Toggle */}
        {isHeaderVisible ? (
          <div className="flex-shrink-0 h-14 border-b border-white/5 flex items-center justify-between px-6 bg-black/40 z-30">
            <div className="flex items-center gap-8 h-full">
              <button
                onClick={() => router.push("/studio/workflows")}
                className="flex items-center gap-2 text-xs font-bold text-white/50 hover:text-white transition-colors"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                All Workflows
              </button>

              <div className="h-4 w-[1px] bg-white/10" />

              <div className="flex h-full">
                <div className="flex bg-white/5 p-1 rounded-lg my-auto">
                  <button
                    onClick={() => openWorkflowTab("playground")}
                    type="button"
                    className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-md transition-all ${
                      activeSubTab === "playground"
                        ? "bg-[var(--primary-color)] text-black shadow-[var(--shadow-glow)]"
                        : "text-white/40 hover:text-white"
                    }`}
                  >
                    Playground
                  </button>
                  <button
                    onClick={() => openWorkflowTab("builder")}
                    type="button"
                    className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest rounded-md transition-all ${
                      activeSubTab === "builder"
                        ? "bg-[var(--primary-color)] text-black shadow-[var(--shadow-glow)]"
                        : "text-white/40 hover:text-white"
                    }`}
                  >
                    Full Workflow
                  </button>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <span className="text-[11px] font-black text-[var(--primary-color)] uppercase tracking-widest">
                {selectedWorkflow.name}
              </span>
              <button
                onClick={() => onToggleHeader?.(false)}
                className="p-1.5 bg-white/5 hover:bg-white/10 rounded-md transition-colors text-white/40 hover:text-white"
                title="Enter Zen Mode"
                type="button"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                </svg>
              </button>
            </div>
          </div>
        ) : (
          /* Floating Immersive Mode Controller */
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-4 px-4 py-2 bg-black/60 backdrop-blur-xl border border-white/10 rounded-full shadow-2xl animate-fade-in-down">
            <button
               onClick={() => router.push("/studio/workflows")}
               className="p-1.5 text-white/40 hover:text-white transition-colors"
               title="Back to All Workflows"
               type="button"
            >
               <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            </button>
            
            <div className="h-4 w-[1px] bg-white/10" />
            
            <div className="flex bg-white/5 p-1 rounded-lg">
               <button
                 onClick={() => openWorkflowTab("playground")}
                 type="button"
                 className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded-md transition-all ${
                   activeSubTab === "playground" ? "bg-[var(--primary-color)] text-black" : "text-white/40"
                 }`}
               >
                 Play
               </button>
               <button
                 onClick={() => openWorkflowTab("builder")}
                 type="button"
                 className={`px-3 py-1 text-[9px] font-black uppercase tracking-widest rounded-md transition-all ${
                   activeSubTab === "builder" ? "bg-[var(--primary-color)] text-black" : "text-white/40"
                 }`}
               >
                 Builder
               </button>
            </div>

            <div className="h-4 w-[1px] bg-white/10" />

            <button
              onClick={() => onToggleHeader?.(true)}
              className="px-3 py-1 bg-white/10 hover:bg-white/20 text-[9px] font-black text-white uppercase tracking-widest rounded-lg transition-colors flex items-center gap-2"
              type="button"
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M4 14h6v6M20 10h-6V4M10 20l-7-7M14 4l7 7"/></svg>
              Exit Zen
            </button>
          </div>
        )}

        <div className="flex-1 overflow-hidden flex flex-col lg:flex-row">
          {activeSubTab === "playground" ? (
            <>
              {/* Controls Panel */}
              <div className="w-full lg:w-[400px] border-r border-white/5 flex flex-col bg-black/20">
                <form onSubmit={handleRun} className="min-h-0 flex-1 flex flex-col">
                  <div className="p-5 border-b border-white/5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h3 className="text-xs font-black text-white/55 uppercase tracking-widest">
                          Inputs
                        </h3>
                      </div>
                      <div className="shrink-0 px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-black text-white/35 uppercase tracking-wider">
                        {inputEntries.length}
                      </div>
                    </div>
                  </div>

                  <div className="p-5 overflow-y-auto flex-1 custom-scrollbar">
                    {inputEntries.length === 0 ? (
                      <div className="min-h-[260px] flex items-center justify-center">
                        <div className="text-center max-w-[260px] opacity-60">
                          <div className="mx-auto w-12 h-12 rounded-xl bg-white/5 border border-white/10 flex items-center justify-center text-white/25 mb-4">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                              <path d="M12 20v-6M6 20V10M18 20V4" />
                            </svg>
                          </div>
                          <p className="text-sm font-semibold text-white/60">No inputs available</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        {inputEntries.map(([key, prop]) => {
                          const kind = workflowInputKind(key, prop);
                          const value = formData[key] || "";
                          return (
                            <div key={key} className="rounded-xl border border-white/10 bg-white/[0.03] p-3 hover:border-white/15 transition-colors">
                              <div className="flex items-center justify-between gap-3 mb-2">
                                <label className="min-w-0 text-[11px] font-black text-white/75 uppercase tracking-wider truncate">
                                  {prop.title || key}
                                </label>
                                <div className="flex items-center gap-2 shrink-0">
                                  <span className="text-[9px] font-black text-white/25 uppercase tracking-wider">{kind}</span>
                                  {value && (
                                    <button
                                      type="button"
                                      onClick={() => setFormData({ ...formData, [key]: "" })}
                                      className="text-[10px] font-bold text-white/25 hover:text-red-400 transition-colors"
                                    >
                                      Clear
                                    </button>
                                  )}
                                </div>
                              </div>
                              {prop.enum ? (
                                <select
                                  value={value}
                                  onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
                                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--primary-color)]/50 transition-colors"
                                >
                                  {prop.enum.map((opt) => (
                                    <option key={opt} value={opt} className="bg-black">
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              ) : prop.type === "string" && kind === "Text" ? (
                                <textarea
                                  value={value}
                                  onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
                                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--primary-color)]/50 transition-colors min-h-[92px] resize-y placeholder:text-white/20"
                                  placeholder={workflowInputPlaceholder(key, prop)}
                                />
                              ) : (
                                <input
                                  type="text"
                                  value={value}
                                  onChange={(e) => setFormData({ ...formData, [key]: e.target.value })}
                                  className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-[var(--primary-color)]/50 transition-colors placeholder:text-white/20"
                                  placeholder={workflowInputPlaceholder(key, prop)}
                                />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="p-5 border-t border-white/5 bg-black/30">
                    <button
                      type="submit"
                      disabled={isExecuting || !selectedWorkflow.id}
                      className="w-full py-3.5 bg-[var(--primary-color)] text-black text-xs font-black uppercase tracking-[0.18em] rounded-xl hover:bg-white transition-all active:scale-[0.98] disabled:opacity-50 disabled:grayscale shadow-[var(--shadow-glow)] flex items-center justify-center gap-3"
                    >
                      {isExecuting ? (
                        <>
                          <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                          <span>Running...</span>
                        </>
                      ) : (
                        <>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M5 3l14 9-14 9V3z" />
                          </svg>
                          <span>Run Workflow</span>
                        </>
                      )}
                    </button>
                    {!selectedWorkflow.id && (
                      <p className="text-[10px] text-white/30 text-center mt-3">
                        Save your workflow first to enable execution.
                      </p>
                    )}
                  </div>
                </form>
              </div>

              {/* Preview Panel */}
              <div className="flex-1 overflow-y-auto p-5 lg:p-8 bg-[#050505] min-h-[500px]">
                {error && (
                  <div className="w-full max-w-2xl p-5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-4 animate-shake">
                    <div className="w-10 h-10 bg-red-500/20 rounded-lg flex items-center justify-center text-red-500 shrink-0">
                      <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                    </div>
                    <div>
                      <span className="text-[10px] font-black text-red-500 uppercase tracking-widest block mb-1">
                        Execution Error
                      </span>
                      <p className="text-white/60 text-sm leading-relaxed">
                        {error}
                      </p>
                    </div>
                  </div>
                )}

                {!showOutputCards && !isExecuting && !visibleResult && !error && (
                  <div className="h-full min-h-[420px] flex items-center justify-center">
                    <div className="flex flex-col items-center gap-5 opacity-50 max-w-sm text-center">
                    <div className="w-16 h-16 bg-white/5 rounded-2xl flex items-center justify-center text-white/20">
                      <svg
                        width="34"
                        height="34"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm text-white/60 font-semibold">No outputs to show yet</p>
                      <p className="text-xs text-white/35 mt-2 leading-relaxed">
                        Waiting for workflow results.
                      </p>
                    </div>
                    </div>
                  </div>
                )}

                {isExecuting && !showOutputCards && (
                  <div className="h-full min-h-[420px] flex flex-col items-center justify-center gap-6 animate-fade-in">
                    <div className="relative">
                      <div className="w-24 h-24 border-[3px] border-white/5 border-t-[var(--primary-color)] rounded-full animate-spin shadow-[var(--shadow-glow)]" />
                      <div className="absolute inset-0 flex items-center justify-center text-[var(--primary-color)]">
                        <svg
                          width="32"
                          height="32"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2.5"
                          className="animate-pulse"
                        >
                          <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                        </svg>
                      </div>
                    </div>
                    <div className="text-center space-y-2">
                      <div className="text-[10px] font-black text-[var(--primary-color)] uppercase tracking-[0.3em] animate-pulse">
                        Running Pipeline
                      </div>
                      <div className="text-[13px] text-white/40 font-medium">
                        Processing nodes and generating assets...
                      </div>
                    </div>
                  </div>
                )}

                {showOutputCards && (
                  <div className="w-full space-y-5 animate-fade-in-up">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 pb-4">
                      <div>
                        <h3 className="text-xs font-black text-white/50 uppercase tracking-widest">
                          {outputPanelTitle}
                        </h3>
                        <p className="text-xs text-white/25 mt-1">
                          {outputCards.length} output node{outputCards.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-bold border ${outputPanelStateClass}`}>
                        <div className={`w-1.5 h-1.5 rounded-full ${isExecuting ? "bg-[var(--primary-color)] animate-pulse" : error ? "bg-red-400" : "bg-green-500"}`} />
                        {outputPanelState}
                      </div>
                    </div>

                    <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,280px))] gap-4 items-start justify-start">
                      {outputCards.map((card) => (
                        <WorkflowOutputCard key={card.key} card={card} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 relative bg-[#050505]">
              {nodeSchemas && workflowDef ? (
                <WorkflowUI
                  workflowId={selectedWorkflow?.id}
                  initialNodeSchemas={nodeSchemas}
                  initialWorkflowData={{
                    ...workflowDef,
                    // Inject ID to prevent builder from assuming this is a new unsaved flow
                    workflow_id: selectedWorkflow?.id
                  }}
                  onWorkflowSaved={handleWorkflowSaved}
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="flex flex-col items-center gap-4">
                    <div className="w-12 h-12 border-4 border-white/5 border-t-[var(--primary-color)] rounded-full animate-spin" />
                    <div className="text-[10px] font-black text-white/20 uppercase tracking-widest">
                      Loading Builder...
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Render main workflow list
  return (
    <div className="h-full w-full flex flex-col p-8 overflow-y-auto custom-scrollbar">
      <div className="max-w-7xl mx-auto w-full">
        <div className="flex flex-col gap-6 mb-12">
          <div className="flex items-end justify-between">
            <div>
              <h1 className="text-3xl font-bold text-white mb-2 tracking-tight">
                Workflows
              </h1>
              <p className="text-white/40 text-sm font-medium">
                Create and manage your asynchronous AI processing pipelines
              </p>
            </div>
            <button
              onClick={() => handleCreateWorkflow()}
              className="px-6 py-3 bg-[var(--primary-color)] text-black text-xs font-black uppercase tracking-widest rounded-lg hover:bg-white transition-all transform hover:scale-105 active:scale-95 shadow-[var(--shadow-glow)] flex items-center gap-2"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="12" y1="5" x2="12" y2="19"></line>
                <line x1="5" y1="12" x2="19" y2="12"></line>
              </svg>
              Create Workflow
            </button>
          </div>

          <div className="flex items-center gap-2 border-b border-white/5">
            <button
              onClick={() => setActiveMainTab("templates")}
              className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] transition-all border-b-2 ${
                activeMainTab === "templates"
                  ? "text-[var(--primary-color)] border-[var(--primary-color)]"
                  : "text-white/30 border-transparent hover:text-white"
              }`}
            >
              Templates
            </button>
            <button
              onClick={() => setActiveMainTab("my-workflows")}
              className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] transition-all border-b-2 ${
                activeMainTab === "my-workflows"
                  ? "text-[var(--primary-color)] border-[var(--primary-color)]"
                  : "text-white/30 border-transparent hover:text-white"
              }`}
            >
              My Workflows
            </button>
            {/* Community (published) sharing is a MuAPI-only feature. */}
            {provider === 'muapi' && (
              <button
                onClick={() => setActiveMainTab("published")}
                className={`px-6 py-4 text-xs font-black uppercase tracking-[0.2em] transition-all border-b-2 ${
                  activeMainTab === "published"
                    ? "text-[var(--primary-color)] border-[var(--primary-color)]"
                    : "text-white/30 border-transparent hover:text-white"
                }`}
              >
                Community
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <div className="py-20 flex items-center justify-center">
            <div className="w-10 h-10 border-4 border-white/5 border-t-[var(--primary-color)] rounded-full animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-6">
            {workflows.map((wf, idx) => (
              <WorkflowCard
                key={wf.id ?? wf.workflow_id ?? idx}
                workflow={wf}
                onClick={handleSelectWorkflow}
                activeTab={activeMainTab}
                onRename={(wf) => {
                   setRenamingWorkflow(wf);
                   setNewWorkflowName(wf.name);
                }}
                onDelete={handleDeleteWorkflow}
                onToggleTemplate={handleToggleTemplate}
                onClone={handleCloneWorkflow}
              />
            ))}
            {!loading && workflows.length === 0 && (
              <div className="col-span-full py-24 text-center border-2 border-dashed border-white/5 rounded-2xl bg-white/[0.02]">
                <div className="text-white/20 text-sm font-medium italic">
                  {activeMainTab === "templates"
                    ? "No templates yet. Open one of your workflows' menu and choose \u201CPublish as Template\u201D to share it here."
                    : "No workflows found in this section."}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Rename Modal */}
      {renamingWorkflow && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setRenamingWorkflow(null)} />
          <form 
            onSubmit={handleRenameWorkflow}
            className="relative w-full max-w-sm bg-[#0a0a0a] border border-white/10 rounded-2xl p-8 shadow-2xl animate-in fade-in zoom-in duration-300"
          >
            <h3 className="text-xl font-bold text-white mb-2">Rename Workflow</h3>
            <p className="text-white/40 text-sm mb-6">Enter a new descriptive name for your pipeline.</p>
            
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-[var(--primary-color)] uppercase tracking-widest">Workflow Name</label>
                <input
                  autoFocus
                  type="text"
                  value={newWorkflowName}
                  onChange={(e) => setNewWorkflowName(e.target.value)}
                  placeholder="e.g. Cinematic Video Flow"
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[var(--primary-color)]/50 transition-colors"
                />
              </div>
              
              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setRenamingWorkflow(null)}
                  className="flex-1 px-4 py-3 text-xs font-black text-white/40 uppercase tracking-widest hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 bg-[var(--primary-color)] text-black px-4 py-3 rounded-xl text-xs font-black uppercase tracking-widest hover:bg-white transition-all transform hover:scale-105 active:scale-95"
                >
                  Save Name
                </button>
              </div>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
