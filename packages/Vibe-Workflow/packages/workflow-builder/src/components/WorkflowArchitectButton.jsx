"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { FaCheck, FaClipboard, FaMagic, FaTimes, FaUndo } from "react-icons/fa";
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
    return jobResponse.data.job;
  };

  useEffect(() => {
    if (!job?.id || ["completed", "failed", "cancelled", "expired", "superseded"].includes(job.status)) return undefined;
    let cancelled = false;
    const timer = setInterval(() => {
      refreshJob(job.id).catch(() => {
        if (!cancelled) toast.error("Failed to refresh Architect job.");
      });
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [job?.id, job?.status]);

  const createWorkflowProposal = async () => {
    const requestedWorkflow = request.trim();
    if (!requestedWorkflow) {
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
        operation: "create",
        request_text: requestedWorkflow,
        idempotency_key: `architect-create-${workflowId}-${workflowRevision}-${Date.now()}`,
      });
      setJob(response.data.job);
      setProposal(null);
      setEvents([]);
      await refreshJob(response.data.job.id);
    } catch (error) {
      toast.error(error.response?.data?.error?.message || error.response?.data?.error || "Failed to create proposal.");
    } finally {
      setLoading(false);
    }
  };

  const rejectProposal = async () => {
    if (!proposal?.id) return;
    try {
      const response = await axios.post(`/api/workflow-architect/proposals/${proposal.id}/reject`, {});
      setProposal(response.data.proposal);
      if (job?.id) refreshJob(job.id).catch(() => {});
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
            <div className="text-[11px] text-gray-400">Create a workflow from an empty canvas</div>
          </div>
          <div className="p-4 flex flex-col gap-3">
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
