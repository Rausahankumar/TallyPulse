const { TOOL_HANDLERS } = require("./tools");

// --------------------------------------------------
// The single choke point through which a Claude tool_use request
// becomes an actual analytics call. This is what "Claude cannot execute
// MongoDB queries / choose arbitrary collections / bypass authorization"
// actually means in code: Claude's output is a tool NAME (a string) and
// tool ARGUMENTS (a plain object) - both untrusted. This function is the
// only place that turns those into a real function call, and it only
// ever dispatches to the fixed TOOL_HANDLERS map built in tools.js -
// there is no path from a tool_use block to arbitrary code execution or
// a raw database query.
//
// `context` (tenantId/companyGuid) is supplied by the caller (the chat
// controller), which must have derived it via
// resolveAuthorizedCompany() - never accepted from the tool call itself.
// --------------------------------------------------

async function executeToolCall({ toolName, toolInput, context }) {
  if (!context || !context.tenantId) {
    return {
      isError: true,
      error: "No authorized company context - refusing to execute any tool.",
    };
  }

  const handler = TOOL_HANDLERS[toolName];

  if (!handler) {
    return {
      isError: true,
      error: `Unsupported tool: "${toolName}". This is not one of the approved analytics tools.`,
    };
  }

  try {
    const result = await handler(toolInput, context);
    return { isError: false, result };
  } catch (error) {
    // zod validation errors and analytics errors both land here -
    // reported as a tool error, never thrown up into a crash, and never
    // silently swallowed into a fabricated success.
    const message =
      error && error.issues
        ? `Invalid arguments: ${error.issues.map((i) => i.message).join("; ")}`
        : error && error.message
          ? error.message
          : "Unknown tool execution error.";

    return { isError: true, error: message };
  }
}

module.exports = {
  executeToolCall,
};
