"use client"

import React from "react";
import { ReactFlowProvider } from "reactflow";
import NodeFlow from "./components/NodeFlow";

export default function Home({ workflowId, provider = "muapi", providerFeatures, initialNodeSchemas, initialWorkflowData, onWorkflowSaved }) {
  return (
    <div className="flex flex-col items-center justify-center h-screen w-full">
      <ReactFlowProvider>
        <NodeFlow 
          workflowId={workflowId}
          provider={provider}
          providerFeatures={providerFeatures}
          initialNodeSchemas={initialNodeSchemas} 
          initialWorkflowData={initialWorkflowData} 
          onWorkflowSaved={onWorkflowSaved}
        />
      </ReactFlowProvider>
    </div>
  );
}
