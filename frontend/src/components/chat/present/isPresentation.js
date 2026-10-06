// A stored/live message.visualization that this renderer understands (presentation model v1).
export const isPresentation = (v) => !!v && typeof v === "object" && v.v === 1 && typeof v.kind === "string";
