"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { FaCheck, FaClipboard, FaHistory, FaMagic, FaTimes, FaUndo } from "react-icons/fa";
import { toast } from "react-hot-toast";

const formatChangeCount = (diff = {}) =>
  Object.values(diff).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);

const list = (value) => (Array.isArray(value) ? value : []);

const formatNode = (node = {}) => {
  const model = node.model_id ? ` · ${node.model_id}` : "";
  return `${node.title || node.node_id || "Node"}${model}`;
};

const formatEdge = (edge = {}) => {
  const source = edge.source ? `${edge.source.node_id || edge.source.nodeId}.${edge.source.port}` : "source";
  const target = edge.target ? `${edge.target.node_id || edge.target.nodeId}.${edge.target.port}` : "target";
  return `${source} -> ${target}`;
};

const formatMetadata = (metadata = {}) => {
  const entries = Object.entries(metadata).filter(([, value]) => value != null && value !== "");
  return entries.length ? entries.map(([key, value]) => `${key}: ${value}`).join(", ") : "Metadata update";
};

const proposalTextSummary = (proposal = {}) => {
  const diff = proposal.diff || {};
  const lines = [
    proposal.summary?.title || "Workflow proposal",
    proposal.summary?.message || "Review the proposed changes.",
    `Base revision: ${proposal.base_revision ?? "new"}`,
    `Status: ${proposal.status || "pending"}`,
  ];
  for (const metadata of list(diff.workflow_metadata_changes)) lines.push(`Metadata: ${formatMetadata(metadata)}`);
  for (const node of list(diff.nodes_added)) lines.push(`Add node: ${formatNode(node)}`);
  for (const edge of list(diff.edges_added)) lines.push(`Connect: ${formatEdge(edge)}`);
  for (const warning of list(proposal.validation?.warnings)) lines.push(`Warning: ${warning.message || warning.code || warning}`);
  for (const error of list(proposal.validation?.errors)) lines.push(`Error: ${error.message || error.code || error}`);
  return lines.join("\n");
};

const terminalJobStatuses = ["completed", "failed", "cancelled", "expired", "superseded"];

const formatTime = (value) => {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};

const followUpSuggestions = (proposal, workflowRevision) => {
  if (proposal?.status === "pending") {
    return ["Explain this proposal", "Validate current workflow"];
  }
  if (workflowRevision > 1) {
    return ["Validate current workflow", "Explain current workflow"];
  }
  return ["Explain current workflow", "Validate current workflow"];
};

function PreviewSection({ title, items, format = (item) => item, empty = null }) {
  if (!items?.length && !empty) return null;
  return (
    <div className="border-t border-gray-800 pt-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{title}</div>
      {items?.length ? (
        <div className="mt-1 flex flex-col gap-1">
          {items.map((item, index) => (
            <div key={`${title}-${index}`} className="text-xs text-gray-300 break-words">
              {format(item)}
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-1 text-xs text-gray-500">{empty}</div>
      )}
    </div>
  );
}

export default function WorkflowArchitectButton({
  workflowId,
  workflowRevision,
  disabled,
  onApplied,
}) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState("");
  const [job, setJob] = useState(null);
  const [events, setEvents] = useState([]);
  const [proposal, setProposal] = useState(null);
  const [conversationId, setConversationId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [reverting, setReverting] = useState(false);

  const refreshJob = async (jobId) => {
    const [jobResponse, eventsResponse] = await Promise.all([
      axios.get(`/api/workflow-architect/jobs/${jobId}`),
      axios.get(`/api/workflow-architect/jobs/${jobId}/events`),
    ]);
    setJob(jobResponse.data.job);
    setProposal(jobResponse.data.proposal || null);
    setEvents(eventsResponse.data.events || []);
    if (jobResponse.data.job?.conversation_id) {
      setConversationId(jobResponse.data.job.conversation_id);
    }
    return jobResponse.data.job;
  };

  const refreshConversation = async (nextConversationId = conversationId) => {
    if (!workflowId) return;
    try {
      const historyResponse = await axios.get(`/api/workflow-architect/history?workflow_id=${workflowId}&limit=8`);
      setHistory(historyResponse.data.history || []);
      let activeConversationId = nextConversationId;
      if (!activeConversationId) {
        const conversationResponse = await axios.get(`/api/workflow-architect/conversations?workflow_id=${workflowId}&limit=1`);
        activeConversationId = conversationResponse.data.conversations?.[0]?.id || null;
        if (activeConversationId) setConversationId(activeConversationId);
      }
      if (activeConversationId) {
        const messagesResponse = await axios.get(`/api/workflow-architect/conversations/${activeConversationId}?limit=30`);
        setMessages(messagesResponse.data.messages || []);
      }
    } catch {
      // History is helpful, but proposal creation/review should keep working if it fails.
    }
  };

  useEffect(() => {
    if (!job?.id || terminalJobStatuses.includes(job.status)) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      refreshJob(job.id).catch(() => {
        if (!cancelled) toast.error("Failed to refresh Architect job.");
      }).then((nextJob) => {
        if (!cancelled && terminalJobStatuses.includes(nextJob?.status)) refreshConversation(nextJob.conversation_id).catch(() => {});
      });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (open) refreshConversation().catch(() => {});
  }, [open, workflowId]);

  const submitArchitectRequest = async (operation = "create", explicitText = null) => {
    const requestedWorkflow = (explicitText ?? request).trim();
    if (operation === "create" && !requestedWorkflow) {
      toast.error("Describe the workflow to create.");
      return;
    }
    if (!workflowId) {
      toast.error("Save the workflow before creating a proposal.");
      return;
    }
    setLoading(true);
    try {
      const response = await axios.post("/api/workflow-architect/jobs", {
        workflow_id: workflowId,
        base_revision: workflowRevision,
        operation,
        request_text: requestedWorkflow,
        conversation_id: conversationId,
        idempotency_key: `architect-${operation}-${workflowId}-${workflowRevision}-${Date.now()}`,
      });
      setConversationId(response.data.conversation?.id || response.data.job?.conversation_id || conversationId);
      setJob(response.data.job);
      setProposal(null);
      setEvents([]);
      await refreshJob(response.data.job.id);
      await refreshConversation(response.data.conversation?.id || response.data.job?.conversation_id || conversationId);
    } catch (error) {
      toast.error(error.response?.data?.error?.message || error.response?.data?.error || "Failed to create proposal.");
    } finally {
      setLoading(false);
    }
  };

  const createWorkflowProposal = () => submitArchitectRequest("create");

  const rejectProposal = async () => {
    if (!proposal?.id) return;
    try {
      const response = await axios.post(`/api/workflow-architect/proposals/${proposal.id}/reject`, {});
      setProposal(response.data.proposal);
      if (job?.id) refreshJob(job.id).catch(() => {});
      refreshConversation().catch(() => {});
    } catch (error) {
      toast.error(error.response?.data?.error?.message || "Failed to reject proposal.");
    }
  };

  const applyProposal = async () => {
    if (!proposal?.id) return;
    setApplying(true);
    try {
      const response = await axios.post(`/api/workflow-architect/proposals/${proposal.id}/apply`, {
        expected_workflow_revision: workflowRevision,
        idempotency_key: `apply-${proposal.id}`,
      });
      setProposal(response.data.proposal);
      onApplied?.(response.data.workflow);
      refreshConversation().catch(() => {});
      toast.success("Proposal applied.");
    } catch (error) {
      const err = error.response?.data?.error;
      toast.error(err?.message || err || "Failed to apply proposal.");
    } finally {
      setApplying(false);
    }
  };

  const copyProposalSummary = async () => {
    if (!proposal) return;
    try {
      await navigator.clipboard.writeText(proposalTextSummary(proposal));
      toast.success("Proposal summary copied.");
    } catch {
      toast.error("Failed to copy proposal summary.");
    }
  };

  const revertWorkflow = async () => {
    if (!workflowId || workflowRevision <= 1) return;
    setReverting(true);
    try {
      const response = await axios.post(`/api/workflow/${workflowId}/revert`, {
        expected_revision: workflowRevision,
      });
      onApplied?.(response.data);
      toast.success("Workflow reverted.");
    } catch (error) {
      const err = error.response?.data?.error;
      toast.error(err?.message || err || "Failed to revert workflow.");
    } finally {
      setReverting(false);
    }
  };

  const changeCount = formatChangeCount(proposal?.diff);
  const diff = proposal?.diff || {};
  const validationWarnings = list(proposal?.validation?.warnings);
  const validationErrors = list(proposal?.validation?.errors);
  const summaryWarnings = list(proposal?.summary?.warnings);
  const assumptions = list(proposal?.summary?.assumptions);
  const suggestions = followUpSuggestions(proposal, workflowRevision);

  return (
    <div className="fixed right-4 bottom-4 z-30">
      <button
        type="button"
        suppressHydrationWarning={true}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className="h-12 w-12 rounded-full bg-white text-black border border-gray-300 shadow-xl flex items-center justify-center hover:bg-blue-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition"
        title="Workflow Architect"
      >
        <FaMagic size={18} />
      </button>

      {open && (
        <div className="absolute right-0 bottom-14 w-[440px] max-w-[calc(100vw-2rem)] bg-[#151618] border border-gray-700 rounded-lg shadow-2xl overflow-hidden text-white">
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-sm font-semibold">Workflow Architect</div>
            <div className="text-[11px] text-gray-400">Plan, explain, validate, and review proposed workflow changes</div>
          </div>
          <div className="p-4 flex flex-col gap-3">
            {messages.length > 0 && (
              <div className="max-h-36 overflow-auto rounded-md border border-gray-800 bg-[#0f1115] p-2 flex flex-col gap-2">
                {messages.slice(-6).map((message) => (
                  <div key={message.id} className="text-xs">
                    <span className="text-[10px] uppercase tracking-wide text-gray-500">
                      {message.role} {formatTime(message.created_at)}
                    </span>
                    <div className={message.role === "user" ? "text-gray-200" : "text-gray-400"}>
                      {message.content_redacted}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Describe the workflow to create"
              rows={3}
              className="w-full resize-none rounded-md bg-[#0f1115] border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500"
            />
            <button
              type="button"
              suppressHydrationWarning={true}
              onClick={createWorkflowProposal}
              disabled={loading || !workflowId}
              className="flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <FaMagic size={14} />
              {loading ? "Preparing..." : "Create Proposal"}
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={() => submitArchitectRequest("explain", request || "Explain current workflow")}
                disabled={loading || !workflowId}
                className="rounded-md border border-gray-700 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Explain
              </button>
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={() => submitArchitectRequest("validate", request || "Validate current workflow")}
                disabled={loading || !workflowId}
                className="rounded-md border border-gray-700 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-gray-800 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Validate
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  suppressHydrationWarning={true}
                  onClick={() => setRequest(suggestion)}
                  className="rounded-md border border-gray-800 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
                >
                  {suggestion}
                </button>
              ))}
            </div>

            {job && (
              <div className="rounded-md border border-gray-700 bg-[#0f1115] p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs font-semibold text-gray-200">Job status</div>
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">{job.status}</div>
                </div>
                <div className="mt-2 flex flex-col gap-1">
                  {(events.length ? events : [{ sequence: 0, stage: job.status }]).map((event) => (
                    <div key={`${event.sequence}-${event.stage}`} className="text-[11px] text-gray-400">
                      {event.stage || event.event_type}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {proposal && (
              <div className="rounded-md border border-gray-700 bg-[#0f1115] p-3 flex flex-col gap-3">
                <div>
                  <div className="text-sm font-semibold">{proposal.summary?.title || "Proposal"}</div>
                  <div className="text-xs text-gray-400">{proposal.summary?.message || "Review the proposed changes."}</div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <div className="rounded-md border border-gray-800 bg-[#151618] px-2 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">Changes</div>
                    <div className="text-sm font-semibold text-gray-100">{changeCount}</div>
                  </div>
                  <div className="rounded-md border border-gray-800 bg-[#151618] px-2 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">Revision</div>
                    <div className="text-sm font-semibold text-gray-100">{proposal.base_revision ?? "New"}</div>
                  </div>
                  <div className="rounded-md border border-gray-800 bg-[#151618] px-2 py-2">
                    <div className="text-[10px] uppercase tracking-wide text-gray-500">Validation</div>
                    <div className={proposal.validation?.valid === false ? "text-sm font-semibold text-red-300" : "text-sm font-semibold text-green-300"}>
                      {proposal.validation?.valid === false ? "Invalid" : "Valid"}
                    </div>
                  </div>
                </div>

                <PreviewSection
                  title="Workflow"
                  items={list(diff.workflow_metadata_changes)}
                  format={formatMetadata}
                />
                <PreviewSection
                  title="Nodes Added"
                  items={list(diff.nodes_added)}
                  format={formatNode}
                  empty="None"
                />
                <PreviewSection
                  title="Connections"
                  items={list(diff.edges_added)}
                  format={formatEdge}
                  empty="None"
                />
                <PreviewSection
                  title="Assumptions"
                  items={assumptions}
                />
                <PreviewSection
                  title="Warnings"
                  items={[...summaryWarnings, ...validationWarnings]}
                  format={(item) => item.message || item.code || item}
                />
                <PreviewSection
                  title="Errors"
                  items={validationErrors}
                  format={(item) => item.message || item.code || item}
                />

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    suppressHydrationWarning={true}
                    onClick={applyProposal}
                    disabled={applying || proposal.status !== "pending" || proposal.validation?.valid === false}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-green-600 px-3 py-2 text-sm font-semibold hover:bg-green-500 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <FaCheck size={13} />
                    {applying ? "Applying..." : "Accept"}
                  </button>
                  <button
                    type="button"
                    suppressHydrationWarning={true}
                    onClick={rejectProposal}
                    disabled={proposal.status !== "pending"}
                    className="flex flex-1 items-center justify-center gap-2 rounded-md bg-gray-700 px-3 py-2 text-sm font-semibold hover:bg-gray-600 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <FaTimes size={13} />
                    Reject
                  </button>
                </div>
                <button
                  type="button"
                  suppressHydrationWarning={true}
                  onClick={copyProposalSummary}
                  className="flex items-center justify-center gap-2 rounded-md border border-gray-700 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-gray-800"
                >
                  <FaClipboard size={12} />
                  Copy Summary
                </button>
                {proposal.status !== "pending" && (
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Status: {proposal.status}</div>
                )}
              </div>
            )}

            {history.length > 0 && (
              <div className="rounded-md border border-gray-700 bg-[#0f1115] p-3">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-gray-200">
                  <FaHistory size={12} />
                  Request history
                </div>
                <div className="max-h-32 overflow-auto flex flex-col gap-2">
                  {history.map((item) => (
                    <button
                      key={item.job.id}
                      type="button"
                      suppressHydrationWarning={true}
                      onClick={() => {
                        setJob(item.job);
                        if (item.job.conversation_id) setConversationId(item.job.conversation_id);
                        if (item.proposal?.id) {
                          axios.get(`/api/workflow-architect/proposals/${item.proposal.id}`).then((response) => {
                            setProposal(response.data.proposal);
                          }).catch(() => {});
                        }
                      }}
                      className="text-left rounded-md border border-gray-800 px-2 py-2 hover:bg-gray-800"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-gray-200">{item.proposal?.summary?.title || item.job.operation}</span>
                        <span className="text-[10px] uppercase tracking-wide text-gray-500">{item.proposal?.status || item.job.status}</span>
                      </div>
                      <div className="text-[11px] text-gray-500">{formatTime(item.job.created_at)}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              suppressHydrationWarning={true}
              onClick={revertWorkflow}
              disabled={reverting || !workflowId || workflowRevision <= 1}
              className="flex items-center justify-center gap-2 rounded-md border border-gray-700 px-3 py-2 text-xs font-semibold text-gray-200 hover:bg-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FaUndo size={12} />
              {reverting ? "Reverting..." : "Revert Last Revision"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
