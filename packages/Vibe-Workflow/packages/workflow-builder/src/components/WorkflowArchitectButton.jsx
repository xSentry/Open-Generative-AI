"use client";

import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  FaCheck,
  FaClipboard,
  FaHistory,
  FaPaperPlane,
  FaRobot,
  FaStar,
  FaTimes,
  FaTrashAlt,
  FaUndo,
} from "react-icons/fa";
import { toast } from "react-hot-toast";
import { subscribeWorkflowArchitectJobs } from "./workflowStream";

const formatChangeCount = (diff = {}) =>
  Object.values(diff).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);

const list = (value) => (Array.isArray(value) ? value : []);

const formatNode = (node = {}) => {
  const model = node.model_id ? ` - ${node.model_id}` : "";
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

function AssistantMark({ compact = false }) {
  return (
    <div className={`${compact ? "h-8 w-8" : "h-12 w-12"} relative shrink-0 rounded-full bg-gradient-to-br from-sky-400 via-blue-500 to-violet-500 p-[1px] shadow-lg shadow-blue-950/40`}>
      <div className="flex h-full w-full items-center justify-center rounded-full bg-[#0b1018] text-white">
        <FaRobot size={compact ? 15 : 20} />
      </div>
      {!compact && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white text-blue-600 shadow">
          <FaStar size={8} />
        </span>
      )}
    </div>
  );
}

function ThinkingBubble({ events = [], status }) {
  const latest = events[events.length - 1]?.stage || events[events.length - 1]?.event_type || status || "thinking";
  return (
    <div className="flex items-start gap-3">
      <AssistantMark compact />
      <div className="max-w-[82%] rounded-2xl rounded-tl-md border border-white/10 bg-[#151b24] px-4 py-3 text-sm text-gray-200 shadow-lg shadow-black/20">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-300 [animation-delay:-0.2s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-300 [animation-delay:-0.1s]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-blue-300" />
          </span>
          <span>Architect is thinking</span>
        </div>
        <div className="mt-1 text-xs capitalize text-gray-500">{latest}</div>
      </div>
    </div>
  );
}

function ChatMessage({ message }) {
  const isUser = message.role === "user";
  const content = message.content_redacted || message.content || "";
  if (!content) return null;
  return (
    <div className={`flex items-start gap-3 ${isUser ? "justify-end" : ""}`}>
      {!isUser && <AssistantMark compact />}
      <div
        className={`max-w-[82%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-lg shadow-black/15 ${
          isUser
            ? "rounded-tr-md bg-blue-600 text-white"
            : "rounded-tl-md border border-white/10 bg-[#151b24] text-gray-100"
        }`}
      >
        {content}
        <div className={`mt-1 text-[10px] ${isUser ? "text-blue-100/70" : "text-gray-500"}`}>
          {formatTime(message.created_at)}
        </div>
      </div>
    </div>
  );
}

function PreviewSection({ title, items, format = (item) => item, empty = null }) {
  if (!items?.length && !empty) return null;
  return (
    <div className="border-t border-white/10 pt-3">
      <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">{title}</div>
      {items?.length ? (
        <div className="mt-2 flex flex-col gap-1.5">
          {items.map((item, index) => (
            <div key={`${title}-${index}`} className="break-words text-xs leading-relaxed text-gray-300">
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

function ProposalBubble({
  proposal,
  changeCount,
  diff,
  assumptions,
  summaryWarnings,
  validationWarnings,
  validationErrors,
  applying,
  onApply,
  onReject,
  onCopy,
}) {
  if (!proposal) return null;
  return (
    <div className="flex items-start gap-3">
      <AssistantMark compact />
      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-white/10 bg-[#151b24] p-3 text-gray-100 shadow-lg shadow-black/20">
        <div className="px-1 pb-2">
          <div className="text-sm font-semibold">{proposal.summary?.title || "Workflow proposal"}</div>
          <div className="mt-1 text-xs leading-relaxed text-gray-400">
            {proposal.summary?.message || "Review the proposed changes."}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Changes</div>
            <div className="mt-1 text-sm font-semibold text-gray-100">{changeCount}</div>
          </div>
          <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Revision</div>
            <div className="mt-1 text-sm font-semibold text-gray-100">{proposal.base_revision ?? "New"}</div>
          </div>
          <div className="rounded-md border border-white/10 bg-black/20 px-3 py-2">
            <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-gray-500">Check</div>
            <div className={proposal.validation?.valid === false ? "mt-1 text-sm font-semibold text-red-300" : "mt-1 text-sm font-semibold text-emerald-300"}>
              {proposal.validation?.valid === false ? "Invalid" : "Valid"}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-3">
          <PreviewSection title="Workflow" items={list(diff.workflow_metadata_changes)} format={formatMetadata} />
          <PreviewSection title="Nodes Added" items={list(diff.nodes_added)} format={formatNode} empty="None" />
          <PreviewSection title="Connections" items={list(diff.edges_added)} format={formatEdge} empty="None" />
          <PreviewSection title="Assumptions" items={assumptions} />
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
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            suppressHydrationWarning={true}
            onClick={onApply}
            disabled={applying || proposal.status !== "pending" || proposal.validation?.valid === false}
            className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-white transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FaCheck size={12} />
            {applying ? "Applying" : "Accept"}
          </button>
          <button
            type="button"
            suppressHydrationWarning={true}
            onClick={onReject}
            disabled={proposal.status !== "pending"}
            className="flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm font-semibold text-gray-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FaTimes size={12} />
            Reject
          </button>
          <button
            type="button"
            suppressHydrationWarning={true}
            onClick={onCopy}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/5 text-gray-300 transition hover:bg-white/10"
            title="Copy summary"
          >
            <FaClipboard size={12} />
          </button>
        </div>
        {proposal.status !== "pending" && (
          <div className="mt-3 text-[10px] font-bold uppercase tracking-[0.18em] text-gray-500">Status: {proposal.status}</div>
        )}
      </div>
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
  const [resettingChat, setResettingChat] = useState(false);
  const transcriptRef = useRef(null);
  const assistantPending = !!job && !terminalJobStatuses.includes(job.status);

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
    if (!job?.id || terminalJobStatuses.includes(job.status)) return undefined;
    let cancelled = false;
    const unsubscribe = subscribeWorkflowArchitectJobs((event) => {
      if (event.jobId !== job.id) return;
      refreshJob(job.id).then((nextJob) => {
        if (!cancelled && terminalJobStatuses.includes(nextJob?.status)) {
          refreshConversation(nextJob.conversation_id).catch(() => {});
        }
      }).catch(() => {
        if (!cancelled) toast.error("Failed to refresh Architect job.");
      });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (open) refreshConversation().catch(() => {});
  }, [open, workflowId]);

  useEffect(() => {
    if (!open || !transcriptRef.current) return;
    transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [open, messages.length, assistantPending, proposal?.id, events.length]);

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
      setRequest("");
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

  const resetChat = async () => {
    if (assistantPending) {
      toast.error("Wait for the current Architect request to finish before resetting chat.");
      return;
    }
    const hasChat = conversationId || messages.length > 0 || proposal || job;
    if (!hasChat) return;
    if (!window.confirm("Reset this Architect chat? Existing messages will be hidden and the next request will start a new chat.")) return;
    setResettingChat(true);
    try {
      if (conversationId) {
        await axios.delete(`/api/workflow-architect/conversations/${conversationId}`);
      }
      setConversationId(null);
      setMessages([]);
      setJob(null);
      setEvents([]);
      setProposal(null);
      setRequest("");
      if (workflowId) {
        const historyResponse = await axios.get(`/api/workflow-architect/history?workflow_id=${workflowId}&limit=8`);
        setHistory(historyResponse.data.history || []);
      }
      toast.success("Architect chat reset.");
    } catch (error) {
      toast.error(error.response?.data?.error?.message || error.response?.data?.error || "Failed to reset Architect chat.");
    } finally {
      setResettingChat(false);
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
        className="group relative flex h-14 w-14 items-center justify-center rounded-full border border-white/20 bg-[#0b1018] text-white shadow-2xl shadow-black/40 transition hover:-translate-y-0.5 hover:border-blue-300/60 disabled:cursor-not-allowed disabled:opacity-50"
        title="Workflow Architect"
      >
        <span className="absolute inset-0 rounded-full bg-gradient-to-br from-sky-400 via-blue-500 to-violet-500 opacity-90 transition group-hover:opacity-100" />
        <span className="absolute inset-[3px] rounded-full bg-[#0b1018]" />
        <span className="relative">
          <FaRobot size={21} />
        </span>
        {assistantPending && <span className="absolute right-1 top-1 h-3 w-3 rounded-full border-2 border-[#0b1018] bg-emerald-400" />}
      </button>

      {open && (
        <div className="absolute right-0 bottom-16 flex h-[min(760px,calc(100vh-6rem))] w-[520px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b1018] text-white shadow-2xl shadow-black/50">
          <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-[#111822] px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <AssistantMark compact />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">Workflow Architect</div>
                <div className="truncate text-[11px] text-gray-400">
                  {assistantPending ? "Thinking through your workflow" : "Ask for a workflow plan, explanation, or validation"}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={resetChat}
                disabled={resettingChat || assistantPending || (!conversationId && messages.length === 0 && !proposal && !job)}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/5 text-gray-300 transition hover:border-red-400/40 hover:bg-red-500/10 hover:text-red-200 disabled:cursor-not-allowed disabled:opacity-40"
                title="Reset chat"
              >
                {resettingChat ? <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <FaTrashAlt size={12} />}
              </button>
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={revertWorkflow}
                disabled={reverting || !workflowId || workflowRevision <= 1}
                className="flex h-8 w-8 items-center justify-center rounded-md border border-white/10 bg-white/5 text-gray-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                title="Revert last revision"
              >
                <FaUndo size={12} className={reverting ? "animate-spin" : ""} />
              </button>
            </div>
          </div>

          <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-4">
              {messages.length === 0 && !proposal && !assistantPending && (
                <div className="flex items-start gap-3">
                  <AssistantMark compact />
                  <div className="max-w-[82%] rounded-2xl rounded-tl-md border border-white/10 bg-[#151b24] px-4 py-3 text-sm leading-relaxed text-gray-100 shadow-lg shadow-black/20">
                    Tell me what you want this workflow to do. I can create a proposal, explain the current graph, or validate it before you apply changes.
                  </div>
                </div>
              )}

              {messages.slice(-30).map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}

              {assistantPending && <ThinkingBubble events={events} status={job?.status} />}

              {proposal && (
                <ProposalBubble
                  proposal={proposal}
                  changeCount={changeCount}
                  diff={diff}
                  assumptions={assumptions}
                  summaryWarnings={summaryWarnings}
                  validationWarnings={validationWarnings}
                  validationErrors={validationErrors}
                  applying={applying}
                  onApply={applyProposal}
                  onReject={rejectProposal}
                  onCopy={copyProposalSummary}
                />
              )}
            </div>
          </div>

          <div className="border-t border-white/10 bg-[#111822] p-3">
            <div className="mb-2 flex flex-wrap gap-2">
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={() => submitArchitectRequest("explain", request || "Explain current workflow")}
                disabled={loading || !workflowId}
                className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Explain
              </button>
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={() => submitArchitectRequest("validate", request || "Validate current workflow")}
                disabled={loading || !workflowId}
                className="rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Validate
              </button>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  suppressHydrationWarning={true}
                  onClick={() => setRequest(suggestion)}
                  className="rounded-md border border-white/10 px-3 py-1.5 text-xs text-gray-300 transition hover:bg-white/10"
                >
                  {suggestion}
                </button>
              ))}
            </div>

            <div className="flex items-end gap-2 rounded-xl border border-white/10 bg-[#0b1018] p-2 focus-within:border-blue-400/60">
              <textarea
                value={request}
                onChange={(event) => setRequest(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    createWorkflowProposal();
                  }
                }}
                placeholder="Message Workflow Architect..."
                rows={1}
                className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white placeholder-gray-500 outline-none"
              />
              <button
                type="button"
                suppressHydrationWarning={true}
                onClick={createWorkflowProposal}
                disabled={loading || !workflowId || !request.trim()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-blue-500 text-white transition hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-400"
                title="Send"
              >
                {loading ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" /> : <FaPaperPlane size={13} />}
              </button>
            </div>

            {history.length > 0 && (
              <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-1">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-500">
                  <FaHistory size={12} />
                </div>
                {history.slice(0, 5).map((item) => (
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
                    className="max-w-44 shrink-0 truncate rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-left text-[11px] text-gray-300 transition hover:bg-white/10"
                    title={item.proposal?.summary?.title || item.job.operation}
                  >
                    {item.proposal?.summary?.title || item.job.operation}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
