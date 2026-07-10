import React, { useEffect, useMemo, useState } from "react";
import { Handle, Position, useReactFlow, useStore, useUpdateNodeInternals } from "reactflow";
import { toast } from "react-hot-toast";
import { FaToolbox } from "react-icons/fa6";
import NodeOptionsMenu from "./NodeOptionsMenu";

const COLOR_CLASS = {
  blue: {
    bg: "!bg-blue-500 !border-blue-500",
    text: "text-blue-500",
    shadow: "shadow-[0_0_20px_rgba(59,130,246,0.5)]",
  },
  green: {
    bg: "!bg-green-500 !border-green-500",
    text: "text-green-500",
    shadow: "shadow-[0_0_20px_rgba(34,197,94,0.5)]",
  },
  orange: {
    bg: "!bg-orange-500 !border-orange-500",
    text: "text-orange-500",
    shadow: "shadow-[0_0_20px_rgba(249,115,22,0.5)]",
  },
  yellow: {
    bg: "!bg-yellow-500 !border-yellow-500",
    text: "text-yellow-500",
    shadow: "shadow-[0_0_20px_rgba(234,179,8,0.5)]",
  },
};

function getUtilityProperties(modelId, nodeSchemas) {
  const schema = nodeSchemas?.categories?.utility?.models?.[modelId]?.input_schema;
  return schema?.schemas?.input_data?.properties || schema || {};
}

function outputTypeForModel(modelId, nodeSchemas) {
  return nodeSchemas?.categories?.utility?.models?.[modelId]?.workflow?.output_type || "text";
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

const UtilityNode = ({ id, data, selected }) => {
  const nodeSchemas = data.nodeSchemas || {};
  const selectedModel = data.selectedModel || {};
  const modelId = selectedModel.id;
  const properties = useMemo(() => getUtilityProperties(modelId, nodeSchemas), [modelId, nodeSchemas]);
  const outputType = outputTypeForModel(modelId, nodeSchemas);
  const outputColor = colorForOutput(outputType);
  const [formValues, setFormValues] = useState({});
  const [connectedInputs, setConnectedInputs] = useState({});
  const [connectedOutputs, setConnectedOutputs] = useState({});
  const { setNodes, setEdges } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useStore((state) => state.edges);

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
    if (!data?.onDataChange) return;
    if (JSON.stringify(data.formValues || {}) !== JSON.stringify(formValues)) {
      data.onDataChange(id, { formValues });
    }
  }, [formValues, data, id]);

  useEffect(() => {
    const nextInputs = {};
    Object.keys(properties).forEach((fieldName) => {
      nextInputs[fieldName] = edges.some((e) => e.target === id && e.targetHandle === fieldName);
    });
    setConnectedInputs(nextInputs);
    setConnectedOutputs({
      utilityOutput: edges.some((e) => e.source === id && e.sourceHandle === "utilityOutput"),
    });
  }, [edges, id, properties]);

  const handleDeleteNode = () => {
    if (window.confirm(`Are you sure you want to delete this ${id} node?`)) {
      setNodes((nds) => nds.filter((n) => n.id !== id));
      setEdges((eds) => eds.filter((e) => e.source !== id && e.target !== id));
      toast.success(`Deleted node ${id}`);
    }
  };

  const inputEntries = Object.entries(properties || {});

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
        Utility {id.replace(/^\D+/g, "")}
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
        <NodeOptionsMenu nodeId={id} onDuplicate={data.duplicateNode} onDelete={handleDeleteNode} />
      </div>
      <div className="relative flex flex-col gap-2 bg-zinc-900/30 rounded-xl border border-zinc-800/50 w-full h-full p-3">
        {inputEntries.length > 0 ? (
          inputEntries.map(([fieldName, meta], index) => (
            <div key={fieldName} className="flex items-center justify-between gap-3 text-xs text-zinc-300 py-1">
              <span className="truncate capitalize">{labelForField(fieldName, meta)}</span>
              <span className="text-[10px] text-zinc-500">{meta.type || "value"}</span>
              <Handle
                type="target"
                position={Position.Left}
                id={fieldName}
                style={{ top: 76 + index * 28, width: 12, height: 12 }}
                className={`!rounded-full !border-2 !left-[-7px] transition-all duration-200 ${
                  connectedInputs[fieldName]
                    ? `${COLOR_CLASS[colorForField(fieldName, meta)].bg} !border-white`
                    : `!bg-black ${COLOR_CLASS[colorForField(fieldName, meta)].bg} ${COLOR_CLASS[colorForField(fieldName, meta)].shadow}`
                } hover:!scale-125`}
                data-type={colorForField(fieldName, meta)}
              />
            </div>
          ))
        ) : (
          <div className="text-xs text-zinc-500 py-8 text-center">No inputs</div>
        )}
      </div>
      <Handle
        type="source"
        position={Position.Right}
        id="utilityOutput"
        style={{ top: 76, width: 12, height: 12 }}
        className={`!rounded-full !border-2 !right-[-7px] transition-all duration-200 ${
          connectedOutputs.utilityOutput
            ? `${COLOR_CLASS[outputColor].bg} !border-white`
            : `!bg-black ${COLOR_CLASS[outputColor].bg} ${COLOR_CLASS[outputColor].shadow}`
        } hover:!scale-125`}
        data-type={outputColor}
      />
      <p className={`absolute -right-9 top-[72px] text-xs ${COLOR_CLASS[outputColor].text} transition-opacity duration-200 ${
        data.activeHandleColor === outputColor ? "opacity-100" : "opacity-0 group-hover:opacity-100"
      }`}>
        Output
      </p>
    </div>
  );
};

export default UtilityNode;
