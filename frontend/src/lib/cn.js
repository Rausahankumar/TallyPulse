import clsx from "clsx";

// Thin wrapper so every component imports one tiny helper instead of
// clsx directly — keeps the door open for tailwind-merge later without
// touching every call site.
export function cn(...args) {
  return clsx(...args);
}
