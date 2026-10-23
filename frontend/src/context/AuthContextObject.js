import { createContext } from "react";

// Split out of AuthContext.jsx/useAuth.js so each of those files exports
// only one kind of thing (a component / a hook) - Vite's Fast Refresh
// only hot-reloads a module cleanly when it doesn't mix component and
// non-component exports.
export const AuthContext = createContext(null);
