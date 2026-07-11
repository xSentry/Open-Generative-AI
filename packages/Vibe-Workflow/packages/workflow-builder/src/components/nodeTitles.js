const TYPE_LABELS = {
  textNode: "Text",
  imageNode: "Image",
  videoNode: "Video",
  audioNode: "Audio",
  apiNode: "Api",
  concatNode: "Prompt Concatenator",
  vidConcatNode: "Video Combiner",
  utilityNode: "Utility",
};

const CATEGORY_LABELS = {
  text: "Text",
  image: "Image",
  video: "Video",
  audio: "Audio",
  api: "Api",
  utility: "Utility",
};

export const getGeneratedNodeTitle = (nodeOrId, type, category) => {
  const id = typeof nodeOrId === "string" ? nodeOrId : nodeOrId?.id || "";
  const nodeType = typeof nodeOrId === "string" ? type : nodeOrId?.type;
  const nodeCategory = typeof nodeOrId === "string" ? category : nodeOrId?.category;
  const number = id.replace(/^\D+/g, "");
  const label = TYPE_LABELS[nodeType] || CATEGORY_LABELS[nodeCategory] || id.replace(/\d+$/, "") || "Node";
  return `${label}${number ? ` ${number}` : ""}`;
};

export const getNodeTitle = (nodeOrId, type, category, customTitle) => {
  const explicitTitle = typeof nodeOrId === "string" ? customTitle : nodeOrId?.data?.title || nodeOrId?.title;
  return explicitTitle?.trim() || getGeneratedNodeTitle(nodeOrId, type, category);
};
