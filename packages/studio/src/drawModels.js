// Draw-to-edit needs a model that accepts both the user's instruction and the
// merged canvas image. Keep this provider-catalog filtering outside React so it
// remains easy to verify as catalogs evolve.

function imageInputNames(model) {
  const names = new Set();
  if (model?.imageField) names.add(model.imageField);
  for (const [name, input] of Object.entries(model?.inputs || {})) {
    if (input?.mediaKind === "image" || input?.field === "images_list") {
      names.add(name);
    }
  }
  return names;
}

export function supportsDrawToEdit(model) {
  const imageInputs = imageInputNames(model);
  if (!model?.inputs?.prompt || imageInputs.size === 0) return false;

  // Draw only supplies a prompt and a canvas image. Models requiring some
  // additional value cannot be run correctly from this compact UI.
  return (model.required || []).every(
    (name) => name === "prompt" || imageInputs.has(name),
  );
}

export function getDrawModels(modelsByMode) {
  return (modelsByMode?.i2i || []).filter(supportsDrawToEdit);
}

export function getDrawAspectRatios(model) {
  const values = model?.inputs?.aspect_ratio?.enum;
  return Array.isArray(values) ? values : [];
}

export function getDefaultDrawAspectRatio(model, fallback = "1:1") {
  return model?.inputs?.aspect_ratio?.default || getDrawAspectRatios(model)[0] || fallback;
}
