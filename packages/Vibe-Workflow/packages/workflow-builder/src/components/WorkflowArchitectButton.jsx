"use client";

import React, { useEffect, useRef, useState } from "react";
import axios from "axios";
import {
  FaCheck,
  FaClipboard,
  FaPaperPlane,
  FaRobot,
  FaStar,
  FaTimes,
  FaTrashAlt,
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

const DEFAULT_ASSISTANT_MESSAGE =
  "Tell me what you want this workflow to do. I can draft the graph, choose suitable nodes, and prepare a proposal for you to review.";

const stageLabelOptions = {
  queued: ["Getting started", "Warming up", "Getting ready"],
  running: ["Reading your workflow", "Checking the canvas", "Looking over the graph"],
  compiling_fixture: ["Preparing a proposal", "Putting the proposal together", "Shaping the changes"],
  calling_model: ["Thinking through the workflow", "Exploring the idea", "Whipping up a plan"],
  plan_generation: ["Whipping up a plan", "Sketching the workflow", "Turning the idea into steps"],
  plan_validation: ["Checking the plan", "Reviewing the structure", "Making sure the plan holds up"],
  plan_repair: ["Refining the plan", "Tightening the workflow", "Smoothing out the plan"],
  repair_validation: ["Checking the refined plan", "Reviewing the updates", "Making sure the refinements work"],
  model_selection: ["Selecting the best models", "Matching models to each step", "Choosing the right building blocks"],
  hydration: ["Filling in node settings", "Preparing the node details", "Wiring up the configuration"],
  planning_workflow: ["Whipping up a plan", "Sketching the workflow", "Refining the idea"],
  selecting_nodes: ["Selecting the best models", "Choosing the right nodes", "Finding the right building blocks"],
  configuring_nodes: ["Preparing node settings", "Dialing in the nodes", "Filling in the details"],
  connecting_nodes: ["Wiring the workflow", "Connecting the steps", "Linking everything together"],
  validating_plan: ["Checking the plan", "Reviewing the structure", "Making sure the plan holds up"],
  hydrating_ir: ["Preparing node settings", "Filling in node details", "Dialing in the configuration"],
  normalizing_ir: ["Finalizing the proposal", "Polishing the plan", "Checking the final details"],
  completed: ["Proposal ready", "Ready for review", "Plan is ready"],
  failed: ["Something stopped", "Could not finish", "Needs another try"],
  working: ["Working on it", "Thinking it through", "Building the plan"],
};

const formatStageLabel = (stage) => {
  if (!stage) return "Working on it";
  return String(stage)
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
};

const latestProgressStage = (events = [], status) => {
  let latestStage = null;
  for (const event of events) {
    const stage = event.stage || event.event_type;
    if (stage) latestStage = stage;
  }
  if (!latestStage && status && !terminalJobStatuses.includes(status)) latestStage = status;
  return latestStage || "working";
};

const randomStageLabel = (stage) => {
  const options = stageLabelOptions[stage];
  if (!options?.length) return formatStageLabel(stage);
  return options[Math.floor(Math.random() * options.length)];
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
  const stage = latestProgressStage(events, status);
  const [step, setStep] = useState(() => randomStageLabel(stage));

  useEffect(() => {
    setStep(randomStageLabel(stage));
  }, [stage]);

  return (
    <div className="workflow-architect-message-in-left flex items-start gap-3">
      <AssistantMark compact />
      <div className="max-w-[82%]">
        <div className="mb-2">
          <span className="inline-flex animate-pulse items-center gap-2 rounded-full border border-blue-300/30 bg-blue-400/10 px-2.5 py-1 text-[10px] font-medium text-blue-100">
            {step}
          </span>
        </div>
        <div className="rounded-2xl rounded-tl-md border border-white/10 bg-[#151b24] px-4 py-3 text-sm text-gray-200 shadow-lg shadow-black/20">
          <span className="flex items-center gap-1.5" aria-label="Assistant is typing">
            <span className="h-2 w-2 animate-bounce rounded-full bg-blue-200 [animation-delay:-0.2s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-blue-200 [animation-delay:-0.1s]" />
            <span className="h-2 w-2 animate-bounce rounded-full bg-blue-200" />
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ message }) {
  const isUser = message.role === "user";
  const content = message.content_redacted || message.content || "";
  if (!content) return null;
  return (
    <div className={`${isUser ? "workflow-architect-message-in-right justify-end" : "workflow-architect-message-in-left"} flex items-start gap-3`}>
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

const isQueuedSystemMessage = (message = {}) =>
  message.role === "system" && message.metadata_redacted?.status === "queued";

const compactProposalSummary = (proposal = {}) => {
  const diff = proposal.diff || {};
  const metadata = list(diff.workflow_metadata_changes);
  const nodesAdded = list(diff.nodes_added);
  const edgesAdded = list(diff.edges_added);
  const pieces = [];
  if (nodesAdded.length) pieces.push(`${nodesAdded.length} node${nodesAdded.length === 1 ? "" : "s"}`);
  if (edgesAdded.length) pieces.push(`${edgesAdded.length} connection${edgesAdded.length === 1 ? "" : "s"}`);
  if (metadata.length) pieces.push("workflow details");
  return pieces.length ? `Adds ${pieces.join(", ")}.` : "No graph changes in this proposal.";
};

const compactNodeNames = (nodes = []) => {
  const names = list(nodes).map((node) => node.title || node.node_id || "Node").filter(Boolean);
  if (!names.length) return "";
  const visible = names.slice(0, 3).join(", ");
  return names.length > 3 ? `${visible}, +${names.length - 3} more` : visible;
};

function ProposalBubble({
  proposal,
  changeCount,
  diff,
  summaryWarnings,
  validationWarnings,
  validationErrors,
  applying,
  onApply,
  onReject,
  onCopy,
}) {
  if (!proposal) return null;
  const nodesAdded = list(diff.nodes_added);
  const edgesAdded = list(diff.edges_added);
  const issues = [...summaryWarnings, ...validationWarnings, ...validationErrors];
  const hasIssues = issues.length > 0;
  return (
    <div className="workflow-architect-message-in-left flex items-start gap-3">
      <AssistantMark compact />
      <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-white/10 bg-[#151b24] p-3 text-gray-100 shadow-lg shadow-black/20">
        <div className="px-1">
          <div className="text-sm font-semibold">{proposal.summary?.title || "Workflow proposal"}</div>
          <div className="mt-1 line-clamp-2 text-xs leading-relaxed text-gray-400">
            {proposal.summary?.message || "Review the proposed changes."}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-semibold text-gray-300">
            {changeCount} change{changeCount === 1 ? "" : "s"}
          </span>
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-semibold text-gray-300">
            {nodesAdded.length} node{nodesAdded.length === 1 ? "" : "s"}
          </span>
          <span className="rounded-full border border-white/10 bg-black/20 px-2.5 py-1 text-[10px] font-semibold text-gray-300">
            {edgesAdded.length} link{edgesAdded.length === 1 ? "" : "s"}
          </span>
          <span className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${proposal.validation?.valid === false ? "border-red-400/30 bg-red-500/10 text-red-200" : "border-emerald-400/30 bg-emerald-500/10 text-emerald-200"}`}>
            {proposal.validation?.valid === false ? "Needs review" : "Validated"}
          </span>
        </div>

        <div className="mt-3 rounded-md border border-white/10 bg-black/15 px-3 py-2">
          <div className="text-xs leading-relaxed text-gray-300">{compactProposalSummary(proposal)}</div>
          {nodesAdded.length > 0 && (
            <div className="mt-1 truncate text-[11px] text-gray-500">{compactNodeNames(nodesAdded)}</div>
          )}
        </div>

        {hasIssues && (
          <div className="mt-2 rounded-md border border-amber-300/20 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-amber-100">
            {issues[0].message || issues[0].code || issues[0]}
            {issues.length > 1 ? ` (+${issues.length - 1} more)` : ""}
          </div>
        )}

        <div className="mt-3 flex items-center gap-2">
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
  const [loading, setLoading] = useState(false);
  const [proposalVisible, setProposalVisible] = useState(false);
  const [applying, setApplying] = useState(false);
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
  }, [open, messages.length, assistantPending, proposalVisible, events.length]);

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
    const optimisticMessageId = `optimistic-${Date.now()}`;
    if (requestedWorkflow) {
      setMessages((currentMessages) => [
        ...currentMessages,
        {
          id: optimisticMessageId,
          role: "user",
          content_redacted: requestedWorkflow,
          created_at: new Date().toISOString(),
          metadata_redacted: { optimistic: true },
        },
      ]);
    }
    setRequest("");
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
      setProposalVisible(false);
      setEvents([]);
      await refreshJob(response.data.job.id);
      await refreshConversation(response.data.conversation?.id || response.data.job?.conversation_id || conversationId);
    } catch (error) {
      if (requestedWorkflow) {
        setMessages((currentMessages) => currentMessages.filter((message) => message.id !== optimisticMessageId));
        setRequest(requestedWorkflow);
      }
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
      setProposalVisible(false);
      setRequest("");
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
  const visibleMessages = messages.filter((message) => !isQueuedSystemMessage(message));
  const proposalMatchesMessage = (message) =>
    !!proposal && message.role === "assistant" && (message.proposal_id === proposal.id || message.job_id === proposal.job_id);
  const hasProposalAssistantMessage = proposal
    ? visibleMessages.some(proposalMatchesMessage)
    : false;

  useEffect(() => {
    if (!proposal?.id) {
      setProposalVisible(false);
      return undefined;
    }
    if (proposal.status !== "pending") {
      setProposalVisible(true);
      return undefined;
    }
    if (!hasProposalAssistantMessage) {
      setProposalVisible(false);
      return undefined;
    }
    setProposalVisible(false);
    const timer = setTimeout(() => setProposalVisible(true), 220);
    return () => clearTimeout(timer);
  }, [proposal?.id, proposal?.status, hasProposalAssistantMessage]);

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
        <div className="absolute right-0 bottom-16 flex h-[min(680px,calc(100dvh-9.5rem))] w-[520px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0b1018] text-white shadow-2xl shadow-black/50 sm:h-[min(760px,calc(100vh-6rem))]">
          <style jsx>{`
            @keyframes workflowArchitectMessageInLeft {
              from {
                opacity: 0;
                transform: translate3d(-10px, 8px, 0) scale(0.985);
              }
              to {
                opacity: 1;
                transform: translate3d(0, 0, 0) scale(1);
              }
            }

            @keyframes workflowArchitectMessageInRight {
              from {
                opacity: 0;
                transform: translate3d(10px, 8px, 0) scale(0.985);
              }
              to {
                opacity: 1;
                transform: translate3d(0, 0, 0) scale(1);
              }
            }

            :global(.workflow-architect-message-in-left) {
              animation: workflowArchitectMessageInLeft 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
              transform-origin: left bottom;
            }

            :global(.workflow-architect-message-in-right) {
              animation: workflowArchitectMessageInRight 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
              transform-origin: right bottom;
            }

            @media (prefers-reduced-motion: reduce) {
              :global(.workflow-architect-message-in-left),
              :global(.workflow-architect-message-in-right) {
                animation: none;
              }
            }
          `}</style>
          <div className="flex items-center justify-between gap-4 border-b border-white/10 bg-[#111822] px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <AssistantMark compact />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">Workflow Architect</div>
                <div className="truncate text-[11px] text-gray-400">
                  {assistantPending ? "Working on your workflow" : "Describe the workflow you want to build"}
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
            </div>
          </div>

          <div ref={transcriptRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            <div className="flex flex-col gap-4">
              <div className="workflow-architect-message-in-left flex items-start gap-3">
                <AssistantMark compact />
                <div className="max-w-[82%] rounded-2xl rounded-tl-md border border-white/10 bg-[#151b24] px-4 py-3 text-sm leading-relaxed text-gray-100 shadow-lg shadow-black/20">
                  {DEFAULT_ASSISTANT_MESSAGE}
                </div>
              </div>

              {visibleMessages.slice(-30).map((message) => (
                <React.Fragment key={message.id}>
                  <ChatMessage message={message} />
                  {proposal && proposalVisible && proposalMatchesMessage(message) && (
                    <ProposalBubble
                      proposal={proposal}
                      changeCount={changeCount}
                      diff={diff}
                      summaryWarnings={summaryWarnings}
                      validationWarnings={validationWarnings}
                      validationErrors={validationErrors}
                      applying={applying}
                      onApply={applyProposal}
                      onReject={rejectProposal}
                      onCopy={copyProposalSummary}
                    />
                  )}
                </React.Fragment>
              ))}

              {assistantPending && <ThinkingBubble events={events} status={job?.status} />}

              {proposal && proposalVisible && !hasProposalAssistantMessage && (
                <ProposalBubble
                  proposal={proposal}
                  changeCount={changeCount}
                  diff={diff}
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
          </div>
        </div>
      )}
    </div>
  );
}
