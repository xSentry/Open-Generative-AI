"use client";

import React, { useEffect } from "react";
import { WorkflowBuilder } from "workflow-builder";
import "reactflow/dist/style.css";
import "react-toastify/dist/ReactToastify.css";


const WorkflowUI = ({ workflowId, initialNodeSchemas, initialWorkflowData, onWorkflowSaved }) => {
  useEffect(() => {
    sessionStorage.setItem("fromWorkflowBuilder", "true");
  }, []);

  return (
    <div className="w-full h-full bg-black">
      <WorkflowBuilder 
        workflowId={workflowId}
        initialNodeSchemas={initialNodeSchemas} 
        initialWorkflowData={initialWorkflowData}
        onWorkflowSaved={onWorkflowSaved}
        costType="dollars" 
      />
    </div>
  );
};

export default WorkflowUI;
