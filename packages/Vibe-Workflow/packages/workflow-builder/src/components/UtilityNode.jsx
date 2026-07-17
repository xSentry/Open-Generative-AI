import React, { useEffect, useMemo, useRef, useState } from "react";
import { Handle, Position, useReactFlow, useStore, useUpdateNodeInternals } from "reactflow";
import { toast } from "react-hot-toast";
import axios from "axios";
import { FaToolbox } from "react-icons/fa6";
import { IoImageOutline, IoVideocamOutline } from "react-icons/io5";
import { AiOutlineAudio } from "react-icons/ai";
import { TfiText } from "react-icons/tfi";
import AudioPlayer from "./AudioPlayer";
import NodeOptionsMenu from "./NodeOptionsMenu";
import { getNodeTitle } from "./nodeTitles";
import QueuedState from "./QueuedState";
import GenerationTimeEstimate from "./GenerationTimeEstimate";

const COLOR_CLASS = {
  blue: {
    text: "text-blue-500",
    connected: "!bg-blue-500 !border-zinc-900 shadow-[0_0_15px_rgba(59,130,246,0.8)]",
    idle: "!bg-zinc-900 !border-blue-500/50 hover:!border-blue-500 shadow-sm",
  },
  green: {
    text: "text-emerald-500",
    connected: "!bg-emerald-500 !border-zinc-900 shadow-[0_0_15px_rgba(16,185,129,0.8)]",
    idle: "!bg-zinc-900 !border-emerald-500/50 hover:!border-emerald-500 shadow-sm",
  },
  orange: {
    text: "text-orange-500",
    connected: "!bg-orange-500 !border-zinc-900 shadow-[0_0_15px_rgba(249,115,22,0.8)]",
    idle: "!bg-zinc-900 !border-orange-500/50 hover:!border-orange-500 shadow-sm",
  },
  yellow: {
    text: "text-yellow-500",
    connected: "!bg-yellow-500 !border-zinc-900 shadow-[0_0_15px_rgba(234,179,8,0.8)]",
    idle: "!bg-zinc-900 !border-yellow-500/50 hover:!border-yellow-500 shadow-sm",
  },
};

function getUtilityProperties(modelId, nodeSchemas) {
  const schema = nodeSchemas?.categories?.utility?.models?.[modelId]?.input_schema;
  return schema?.schemas?.input_data?.properties || schema || {};
}

function outputTypeForModel(modelId, nodeSchemas) {
  return nodeSchemas?.categories?.utility?.models?.[modelId]?.workflow?.output_type || "text";
}

function outputLabelForModel(modelId, nodeSchemas) {
  return nodeSchemas?.categories?.utility?.models?.[modelId]?.workflow?.output_label || "Output";
}

function colorForField(fieldName, meta = {}) {
  const field = meta.field || fieldName;
  if (/audio/i.test(field)) return "yellow";
  if (/video/i.test(field)) return "orange";
  if (/image|swap|frame/i.test(field)) return "green";
  return "blue";
}

function colorForOutput(type) {
  if (type === "image_url") return "green";
  if (type === "video_url") return "orange";
  if (type === "audio_url") return "yellow";
  return "blue";
}

function labelForField(fieldName, meta = {}) {
  return meta.title || meta.name || fieldName.replace(/_/g, " ");
}

function handleLabel(value) {
  return String(value || "").replace(/_/g, " ").trim();
}

function outputPlaceholder(type) {
  if (type === "image_url") return { icon: <IoImageOutline size={34} />, label: "Image appears here..." };
  if (type === "video_url") return { icon: <IoVideocamOutline size={34} />, label: "Video appears here..." };
  if (type === "audio_url") return { icon: <AiOutlineAudio size={34} />, label: "Audio appears here..." };
  return { icon: <TfiText size={30} />, label: "Text appears here..." };
}

function outputValue(data = {}) {
  return data.viewingOutput || data.resultUrl || data.outputs?.[0]?.value || "";
}

function formatTextOutput(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object" && value.error) return value.error;
  return JSON.stringify(value, null, 2);
}

function isEmptyValue(value) {
  return value == null || value === "" || (Array.isArray(value) && value.length === 0);
}

function initializeFormData(properties) {
  const initialData = {};
  Object.entries(properties || {}).forEach(([fieldName, fieldSchema]) => {
    if (fieldSchema.type === "array") initialData[fieldName] = fieldSchema.examples || [];
    else if (fieldSchema.default !== undefined) initialData[fieldName] = fieldSchema.default;
    else if (fieldSchema.examples?.length > 0) initialData[fieldName] = fieldSchema.examples[0];
    else if (fieldSchema.type === "boolean") initialData[fieldName] = false;
    else if (fieldSchema.type === "int" || fieldSchema.type === "number") initialData[fieldName] = 0;
    else initialData[fieldName] = "";
  });
  return initialData;
}

function isFieldVisible(meta = {}, formValues = {}) {
  const rule = meta.visibleWhen || meta.showWhen;
  if (!rule?.field) return true;
  const value = formValues[rule.field];
  if (Object.prototype.hasOwnProperty.call(rule, "equals")) return value === rule.equals;
  if (Array.isArray(rule.in)) return rule.in.includes(value);
  return Boolean(value);
}

const UtilityNode = ({ id, data, selected }) => {
  const nodeSchemas = data.nodeSchemas || {};
  const selectedModel = data.selectedModel || {};
  const modelId = selectedModel.id;
  const properties = useMemo(() => getUtilityProperties(modelId, nodeSchemas), [modelId, nodeSchemas]);
  const outputType = outputTypeForModel(modelId, nodeSchemas);
  const outputLabel = outputLabelForModel(modelId, nodeSchemas);
  const outputColor = colorForOutput(outputType);
  const [formValues, setFormValues] = useState({});
  const [connectedInputs, setConnectedInputs] = useState({});
  const [connectedOutputs, setConnectedOutputs] = useState({});
  const { setNodes, setEdges } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useStore((state) => state.edges);
  const lastAutoRunSignature = useRef(null);

  const deleteNodeRuns = async (runs = []) => {
    const ids = runs.map((run) => run?.node_run_id).filter(Boolean);
    await Promise.all(ids.map((nodeRunId) => axios.delete(`/api/workflow/node-run/${nodeRunId}`)));
  };

  useEffect(() => {
    const defaults = initializeFormData(properties);
    const validKeys = Object.keys(properties);
    const filtered = Object.entries(data.formValues || {}).reduce((acc, [key, value]) => {
      if (validKeys.includes(key) || key === "make_output" || key === "make_input") acc[key] = value;
      return acc;
    }, {});
    setFormValues({ ...defaults, ...filtered });
  }, [properties, data.formValues]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [formValues, id, updateNodeInternals]);

  useEffect(() => {
    const nextInputs = {};
    Object.entries(properties).forEach(([fieldName, meta]) => {
      if (meta.connectable === false) return;
      if (!isFieldVisible(meta, formValues)) return;
      nextInputs[fieldName] = edges.some((e) => e.target === id && e.targetHandle === fieldName);
    });
    setConnectedInputs(nextInputs);
    setConnectedOutputs({
      utilityOutput: edges.some((e) => e.source === id && e.sourceHandle === "utilityOutput"),
    });
  }, [edges, id, properties]);

  const handleDeleteNode = async () => {
    if (window.confirm(`Are you sure you want to delete this ${id} node?`)) {
      try {
        await deleteNodeRuns(data.outputHistory || []);
        setNodes((nds) => nds.filter((n) => n.id !== id));
        setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
        toast.success(`Deleted node ${id}`);
      } catch (error) {
        toast.error(error.response?.data?.detail || error.response?.data?.error || "Failed to delete node outputs");
        console.error(error);
      }
    }
  };

  const inputEntries = Object.entries(properties || {})
    .filter(([, meta]) => meta.connectable !== false && isFieldVisible(meta, formValues));
  const requiredInputEntries = inputEntries.filter(([, meta]) => meta.required === true);
  const visibleConfigEntries = Object.entries(properties || {})
    .filter(([, meta]) => isFieldVisible(meta, formValues));
  const currentOutput = outputValue(data);
  const outputHistory = data.outputHistory || [];
  const currentOutputRun = outputHistory[outputHistory.length - 1];
  const placeholder = outputPlaceholder(outputType);

  const handleDeleteOutput = async () => {
    if (!currentOutputRun?.node_run_id) return;
    try {
      await deleteNodeRuns([currentOutputRun]);
      data.onDataChange?.(id, {
        outputs: [],
        resultUrl: null,
        viewingOutput: null,
        outputHistory: [],
        errorMsg: null,
      });
      toast.success("Deleted output");
    } catch (error) {
      toast.error(error.response?.data?.detail || error.response?.data?.error || "Failed to delete output");
      console.error(error);
    }
  };

  useEffect(() => {
    if (!data?.runNodeFromFlow || !data?.onDataChange || requiredInputEntries.length === 0) return;
    const connectionsHydrated = requiredInputEntries.every(([fieldName]) =>
      Object.prototype.hasOwnProperty.call(connectedInputs, fieldName)
    );
    if (!connectionsHydrated) return;

    const signature = JSON.stringify(
      visibleConfigEntries.map(([fieldName]) => [fieldName, formValues[fieldName] ?? null])
    );
    const hasAllRequiredInputs = requiredInputEntries.every(([fieldName]) =>
      connectedInputs[fieldName] && !isEmptyValue(formValues[fieldName])
    );

    if (!hasAllRequiredInputs) {
      lastAutoRunSignature.current = null;
      if (currentOutput || data.errorMsg || data.isLoading) {
        data.onDataChange(id, {
          outputs: [],
          resultUrl: null,
          viewingOutput: null,
          errorMsg: null,
          isLoading: false,
        });
      }
      return;
    }

    if (currentOutput && lastAutoRunSignature.current === null) {
      lastAutoRunSignature.current = signature;
      return;
    }

    if (signature === lastAutoRunSignature.current || data.isLoading) return;
    lastAutoRunSignature.current = signature;
    data.runNodeFromFlow(id);
  }, [
    connectedInputs,
    currentOutput,
    data,
    formValues,
    id,
    inputEntries,
    requiredInputEntries,
    visibleConfigEntries,
  ]);

  return (
    <div
      style={{ minHeight: 220 }}
      className={`nowheel group flex flex-col flex-1 w-80 rounded-2xl border-2 relative transition-all duration-300 ease-in-out ${
        selected
          ? "border-blue-600 shadow-[0_0_25px_rgba(37,99,235,0.3)] scale-[1.02] ring-1 ring-blue-500/20"
          : "border-zinc-800 hover:border-zinc-700 shadow-lg"
      } bg-[#0c0d0f]/95 backdrop-blur-sm`}
    >
      <h3 className="absolute -top-5 left-0 text-zinc-400 text-[10px] font-medium tracking-wider uppercase">
        {getNodeTitle(id, "utilityNode", "utility", data.title)}
      </h3>
      <div className="flex items-center justify-between bg-gradient-to-r from-[#151618] to-[#1c1e21] rounded-t-2xl border-b border-zinc-800 py-2 px-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className={`p-1.5 rounded-lg ${selected ? "bg-blue-600 text-white" : "bg-zinc-800 text-zinc-400"} transition-colors`}>
            <FaToolbox size={14} />
          </div>
          <h3 className="text-xs font-bold text-zinc-100 truncate">
            {selectedModel.name || selectedModel.id || "Utility Node"}
          </h3>
        </div>
        <NodeOptionsMenu
          nodeId={id}
          onDuplicate={data.duplicateNode}
          onRename={data.renameNode}
          currentTitle={getNodeTitle(id, "utilityNode", "utility", data.title)}
          onDelete={handleDeleteNode}
          downloadUrl={currentOutput}
          onDeleteOutput={handleDeleteOutput}
        />
      </div>
      <div className="relative flex items-center justify-center w-full h-full min-h-[180px] overflow-hidden rounded-b-2xl bg-zinc-950">
        {data.isQueued ? (
          <QueuedState tone={outputColor} className="rounded-b-2xl" />
        ) : data.isLoading ? (
          <div className="flex flex-col items-center justify-center gap-1.5 text-zinc-400">
            <div className="w-6 h-6 border-2 border-white/20 border-t-white rounded-full animate-spin" />
            <span className="text-xs">Generating...</span>
            <GenerationTimeEstimate
              estimate={data.runtimeEstimate}
              createdAt={data.generationCreatedAt}
            />
          </div>
        ) : data.errorMsg ? (
          <div className="w-full text-xs text-red-300 bg-red-950/30 border border-red-500/20 rounded-lg p-3 line-clamp-5">
            {data.errorMsg}
          </div>
        ) : currentOutput ? (
          outputType === "image_url" ? (
            <img src={currentOutput} alt="Utility output" className="absolute inset-0 w-full h-full object-cover" />
          ) : outputType === "video_url" ? (
            <video src={currentOutput} className="absolute inset-0 w-full h-full object-cover" controls />
          ) : outputType === "audio_url" ? (
            <div className="w-full px-3">
              <AudioPlayer src={currentOutput} />
            </div>
          ) : (
            <div className="absolute inset-0 overflow-hidden bg-black/30 p-3 text-xs text-zinc-200 whitespace-pre-wrap">
              {formatTextOutput(currentOutput)}
            </div>
          )
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 text-zinc-500">
            <div className={`${COLOR_CLASS[outputColor].text}`}>{placeholder.icon}</div>
            <span className="text-xs">{placeholder.label}</span>
          </div>
        )}
      </div>
      {inputEntries.map(([fieldName, meta], index) => (
        <React.Fragment key={fieldName}>
          <p
            style={{ top: 76 + index * 28 }}
            className={`absolute -left-12 text-[10px] font-bold tracking-tight ${COLOR_CLASS[colorForField(fieldName, meta)].text} transition-all duration-300 ${
              data.activeHandleColor === colorForField(fieldName, meta)
                ? "opacity-100 translate-x-0"
                : "opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0"
            }`}
          >
            {handleLabel(labelForField(fieldName, meta))}
          </p>
          <Handle
            type="target"
            position={Position.Left}
            id={fieldName}
            style={{ top: 76 + index * 28, width: 14, height: 14 }}
            className={`!rounded-full !border-[3px] !left-[-8px] transition-all ${
              connectedInputs[fieldName]
                ? COLOR_CLASS[colorForField(fieldName, meta)].connected
                : COLOR_CLASS[colorForField(fieldName, meta)].idle
            }`}
            data-type={colorForField(fieldName, meta)}
          />
        </React.Fragment>
      ))}
      <Handle
        type="source"
        position={Position.Right}
        id="utilityOutput"
        style={{ top: 76, width: 14, height: 14 }}
        className={`!rounded-full !border-[3px] !right-[-8px] transition-all ${
          connectedOutputs.utilityOutput
            ? COLOR_CLASS[outputColor].connected
            : COLOR_CLASS[outputColor].idle
        }`}
        data-type={outputColor}
      />
      <p className={`absolute -right-11 top-[76px] text-[10px] font-bold tracking-tight ${COLOR_CLASS[outputColor].text} transition-all duration-300 ${
        data.activeHandleColor === outputColor
          ? "opacity-100 translate-x-0"
          : "opacity-0 translate-x-1 group-hover:opacity-100 group-hover:translate-x-0"
      }`}>
        {handleLabel(outputLabel)}
      </p>
    </div>
  );
};

export default UtilityNode;
