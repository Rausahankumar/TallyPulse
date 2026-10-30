"use strict";

// --------------------------------------------------
// Estimated cost of a turn's model usage: provider-reported TOKENS x PUBLISHED list prices. The provider's reply carries no
// charge, so this is an ESTIMATE (labelled `pricingVersion` on every record); it is never mixed with a provider-reported charge.
// A model whose price is not listed here gets null - a price is never guessed, so adding a model means adding its row.
//
// Source of the rows below: https://platform.claude.com/docs/en/about-claude/pricing (table "Model pricing", read 2026-10-29).
// USD per million tokens. `cacheWrite` is the 5-minute cache write (1.25x input) - the only cache lifetime this app requests
// (cache_control {type: "ephemeral"} without a ttl); `cacheRead` is 0.1x input.
// --------------------------------------------------

const PRICING_VERSION = "anthropic-list-prices-2026-10-29";
const PRICES = {
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5" (a dated snapshot id has the price of its family). */
const familyOf = (model) => (typeof model === "string" ? model.replace(/-\d{8}$/, "") : null);

const n = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const usd = (x) => Math.round(x * 1e6) / 1e6;

/**
 * @param {{model: string, inputTokens?: number, outputTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number}} u
 *        inputTokens is the provider's `input_tokens`, which EXCLUDES cache reads and cache writes (those are reported apart).
 * @returns {{usd: number, uncachedUsd: number, pricingVersion: string}|null} usd: what these tokens cost with the cache terms;
 *          uncachedUsd: what the same tokens would have cost with no prompt caching at all (so a cache's effect on the BILL, not
 *          on a token percentage, can be read off a record). null when the model's price is not listed.
 */
function estimateCost(u) {
  const family = u ? familyOf(u.model) : null;
  const p = family && Object.prototype.hasOwnProperty.call(PRICES, family) ? PRICES[family] : null; // own keys only: "constructor" is not a price
  if (!p) return null;
  const input = n(u.inputTokens), output = n(u.outputTokens), read = n(u.cacheReadTokens), write = n(u.cacheWriteTokens);
  return {
    usd: usd((input * p.input + output * p.output + write * p.cacheWrite + read * p.cacheRead) / 1e6),
    uncachedUsd: usd(((input + write + read) * p.input + output * p.output) / 1e6),
    pricingVersion: PRICING_VERSION,
  };
}

module.exports = { estimateCost, familyOf, PRICES, PRICING_VERSION };
