import axios from "axios";

// Every real endpoint TallyPulse's backend exposes today lives under
// /api (see docs/TALLYPULSE_TECHNICAL_DOCUMENTATION.md §7). The Vite
// dev server proxies /api to the backend (vite.config.js), so this
// stays same-origin in development and can point anywhere in
// production via VITE_API_BASE_URL.
const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || "/api",
  headers: { "Content-Type": "application/json" },
  // The backend's own call to TallyPrime (odbcService.getCompanyInfo)
  // sets no timeout of its own, so if Tally is unreachable the request
  // can hang indefinitely. This is a frontend-only safety net — it
  // never changes backend behavior, it just stops the UI from spinning
  // forever with no feedback when that happens.
  timeout: 20000,
});

const TOKEN_STORAGE_KEY = "tp_token";

export function getStoredToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* localStorage unavailable — session just won't persist across reloads */
  }
}

client.interceptors.request.use((config) => {
  const token = getStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Normalizes every backend error response ({success:false, message})
// into a single Error shape callers can rely on, instead of digging
// through error.response.data at every call site.
export class ApiError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

client.interceptors.response.use(
  (response) => response,
  (error) => {
    // Cancelled by the caller (AbortController - e.g. the chat's Stop button): not a failure, never retried.
    if (axios.isCancel(error)) {
      return Promise.reject(new ApiError("The request was cancelled.", { code: "CANCELED" }));
    }
    if (error.code === "ECONNABORTED") {
      return Promise.reject(
        new ApiError(
          "The request timed out. If this was a Tally-related action, TallyPrime may be unreachable.",
          { code: "TIMEOUT" }
        )
      );
    }
    if (error.response) {
      const message =
        error.response.data?.message ||
        `Request failed with status ${error.response.status}`;
      return Promise.reject(
        new ApiError(message, { status: error.response.status })
      );
    }
    if (error.request) {
      return Promise.reject(
        new ApiError(
          "Could not reach the TallyPulse backend. Is the server running?",
          { code: "NETWORK_ERROR" }
        )
      );
    }
    return Promise.reject(new ApiError(error.message || "Unexpected error."));
  }
);

export default client;
