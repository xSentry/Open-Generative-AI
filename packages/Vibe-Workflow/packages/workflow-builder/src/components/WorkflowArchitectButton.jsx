"use client";

import React, { useEffect, useState } from "react";
import axios from "axios";
import { FaCheck, FaMagic, FaTimes } from "react-icons/fa";
import { toast } from "react-hot-toast";

const formatChangeCount = (diff = {}) =>
  Object.values(diff).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);

const metadataPatch = ({ baseRevision, name }) => ({
  version: "workflow-patch/v1",
  baseRevision,
  preconditions: baseRevision != null
    ? [{ type: "workflow_revision_equals", revision: baseRevision }]
    : [],
  operations: [
    {
      op: "set_workflow_metadata",
      metadata: { name },
    },
  ],
});

export default function WorkflowArchitectButton({
  workflowId,
  workflowRevision,
  workflowName,
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

  const createFixtureProposal = async () => {
    const requestedName = request.trim() || `${workflowName || "Untitled"} proposal`;
    if (!workflowId) {
      toast.error("Save the workflow before creating a proposal.");
      return;
    }
    setLoading(true);
    try {
      const response = await axios.post("/api/workflow-architect/jobs", {
        workflow_id: workflowId,
        base_revision: workflowRevision,
        operation: "edit",
        idempotency_key: `fixture-${workflowId}-${workflowRevision}-${Date.now()}`,
        fixture_proposal: {
          patch: metadataPatch({ baseRevision: workflowRevision, name: requestedName }),
          summary: {
            title: "Fixture proposal",
            message: `Rename this workflow to "${requestedName}".`,
            assumptions: ["Phase 1 fixture proposal; no LLM call was made."],
            warnings: [],
          },
        },
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
        <div className="absolute right-0 bottom-14 w-[340px] max-w-[calc(100vw-2rem)] bg-[#151618] border border-gray-700 rounded-lg shadow-2xl overflow-hidden text-white">
          <div className="px-4 py-3 border-b border-gray-800">
            <div className="text-sm font-semibold">Workflow Architect</div>
            <div className="text-[11px] text-gray-400">Phase 1 fixture proposal</div>
          </div>
          <div className="p-4 flex flex-col gap-3">
            <textarea
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="Type a workflow name to propose"
              rows={3}
              className="w-full resize-none rounded-md bg-[#0f1115] border border-gray-700 px-3 py-2 text-sm text-white placeholder-gray-500 outline-none focus:border-blue-500"
            />
            <button
              type="button"
              suppressHydrationWarning={true}
              onClick={createFixtureProposal}
              disabled={loading || !workflowId}
              className="flex items-center justify-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <FaMagic size={14} />
              {loading ? "Preparing..." : "Prepare Proposal"}
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
                <div className="text-xs text-gray-300">
                  {formatChangeCount(proposal.diff)} proposed change{formatChangeCount(proposal.diff) === 1 ? "" : "s"}
                </div>
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
                {proposal.status !== "pending" && (
                  <div className="text-[11px] uppercase tracking-wide text-gray-500">Status: {proposal.status}</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
