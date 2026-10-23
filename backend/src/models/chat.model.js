const mongoose = require("mongoose");

// Chat history, scoped by tenant AND user (never just tenant - two users
// at the same company must not see each other's chats by default, and
// definitely never see another company's chats at all).
//
// Deliberately does NOT store raw query results or raw Tally/Mongo
// documents - only what's needed to redisplay the conversation
// (the assistant's deterministic answer, not the underlying dataset it was
// computed from): chat history is a display/audit log of what was SAID,
// not a second copy of the analytics data.
const chatMessageSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      required: true,
      enum: ["user", "assistant"],
    },

    text: {
      type: String,
      required: true,
    },

    // Present only on assistant messages that ran the query engine.
    // Minimal metadata for "View Details" / traceability - which tool and
    // what trust state it returned - NOT the full result payload.
    toolCalls: [
      {
        toolName: { type: String },
        state: { type: String }, // valid_data | zero_result | stale_data | ...
        _id: false,
      },
    ],

    // Structured presentation model built by the backend (presentation.js);
    // the frontend renders it, no figure is computed client-side.
    visualization: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    dataAsOf: {
      type: Date,
      default: null,
    },

    // The real freshness object (state/dataAsOf/lastRunStatus/lastError/
    // minutesSinceLastSync/message) the answer was computed under.
    // Stored so a reloaded conversation shows the SAME honest state it
    // showed live, never a re-derived/fabricated "fresh" default.
    freshness: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    warnings: {
      type: [String],
      default: [],
    },

    // Present only on answers from the Query Engine: the validated query plan that produced this answer plus the
    // measure the user asked for ({v, plan, basis} - built and re-read by followUp.js). It lets a follow-up such as
    // "and by customer?" keep the period, comparison and measure: the planner receives it as the previous structured
    // plan (the chat's text history is never sent). It holds no figures and no tenant fields, and is strictly
    // re-parsed before any reuse.
    queryContext: {
      type: mongoose.Schema.Types.Mixed,
      default: undefined,
    },
  },
  { timestamps: true, _id: false }
);

const chatSchema = new mongoose.Schema(
  {
    tenantId: {
      type: String,
      required: true,
      index: true,
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    title: {
      type: String,
      default: "New chat",
      trim: true,
    },

    messages: {
      type: [chatMessageSchema],
      default: [],
    },
  },
  { timestamps: true }
);

// Every chat list/lookup is by {tenantId, userId} together - never
// tenantId alone - so a query that forgets the user filter still can't
// cross into another tenant's data, and a query that forgets the tenant
// filter still can't cross into another user's chats within the SAME
// tenant.
chatSchema.index({ tenantId: 1, userId: 1, updatedAt: -1 });

module.exports = mongoose.model("Chat", chatSchema);
