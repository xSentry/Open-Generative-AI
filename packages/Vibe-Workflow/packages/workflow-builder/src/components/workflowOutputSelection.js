export function selectOutput(outputs, selectedValue) {
  if (!Array.isArray(outputs) || outputs.length === 0) return [];
  if (selectedValue == null) return outputs;

  const selectedIndex = outputs.findIndex((output) => output?.value === selectedValue);
  if (selectedIndex === 0) return outputs;
  if (selectedIndex > 0) {
    return [outputs[selectedIndex], ...outputs.slice(0, selectedIndex), ...outputs.slice(selectedIndex + 1)];
  }

  // The value can come from a canvas-only edit (for example an input node).
  // Do not retain an unrelated storage key, because the worker would re-sign
  // that key and silently replace the selected value with another output.
  return [{ ...outputs[0], value: selectedValue, key: undefined }, ...outputs.slice(1)];
}

export function buildActiveUpstreamResults(nodes, targetNodeId) {
  return Object.fromEntries(
    (nodes || [])
      .filter((node) => node.id !== targetNodeId && Array.isArray(node.data?.outputs) && node.data.outputs.length > 0)
      .map((node) => [node.id, selectOutput(node.data.outputs, node.data?.resultUrl)])
  );
}

export function outputSelectionPatch(outputs, index) {
  const value = outputs?.[index]?.value;
  return value == null ? null : { resultUrl: value, viewingOutput: value };
}

export function resolveConnectedImageInputs(connectedValues, formValues = {}) {
  const values = [...new Set((connectedValues || []).filter((value) => value != null && value !== ""))];
  if (values.length === 1) return { imageUrl: values[0], imagesList: [] };
  if (values.length >= 2) return { imageUrl: null, imagesList: values };
  return {
    imageUrl: formValues.image_url ?? formValues.image ?? null,
    imagesList: formValues.images_list ?? formValues.images ?? formValues.image_urls ?? [],
  };
}
