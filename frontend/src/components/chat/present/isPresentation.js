// A stored/live message.visualization that this renderer understands (presentation model v1). An analysis view must carry
// its steps and findings; anything else falls back to the text answer.
export const isPresentation = (v) =>
  !!v &&
  typeof v === "object" &&
  v.v === 1 &&
  typeof v.kind === "string" &&
  (v.kind !== "analysis" || (Array.isArray(v.steps) && !!v.findings && Array.isArray(v.gaps) && Array.isArray(v.recommendations)));

// A saved calculation record ("View calculation", backend calculation.js v1); an unknown version shows no button.
export const hasCalculation = (v) => !!(v && v.calculation && v.calculation.v === 1);
