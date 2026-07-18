// Single source of model selection for every AI call in this service.
//
// All model calls route through the Vercel AI Gateway (AI_GATEWAY_API_KEY). The
// gateway supports a NATIVE fallback chain and a zero-data-retention filter via
// `providerOptions.gateway` (see @ai-sdk/gateway `GatewayProviderOptions`:
// `models` = fallback models in order, `zeroDataRetention` = restrict to ZDR
// providers). So resilience lives HERE, in one place, rather than as a
// hand-rolled try/catch at each call site.
//
// Why this file exists: `xai/grok-4.5` — the prior default duplicated at five
// sites — was refused by the gateway when ZDR was required ("No ZDR providers
// available for xai/grok-4.5"), taking the helper agent, the council
// synthesizer, and the daily reviewer down simultaneously, none of which had a
// fallback. Leading each call with the intended model and letting the gateway
// fall through to a ZDR-attested provider fixes that without changing intent.

// Primary model. grok-4.5 stays the intended default; QIG_HELPER_MODEL lets an
// operator repoint it (e.g. to an anthropic id) WITHOUT a redeploy if xai's ZDR
// availability stays out.
export const DEFAULT_MODEL = process.env.QIG_HELPER_MODEL || 'xai/grok-4.5';

// ZDR-attested fallbacks. Anthropic offers zero-data-retention agreements on the
// gateway, so these serve when the primary's provider has no ZDR route. Operator
// override via QIG_FALLBACK_MODELS (comma-separated).
const FALLBACK_MODELS = (
  process.env.QIG_FALLBACK_MODELS || 'anthropic/claude-sonnet-5,anthropic/claude-opus-4.8'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// QIG physics data is sensitive, and the gateway is already refusing non-ZDR
// providers, so require ZDR by default. QIG_REQUIRE_ZDR=false disables it as an
// escape hatch if a needed model has no ZDR provider.
const REQUIRE_ZDR = process.env.QIG_REQUIRE_ZDR !== 'false';

/**
 * Gateway provider options to spread onto any generateText/generateObject/
 * streamText call. Leads with `primary`, then the shared ZDR fallbacks, then any
 * call-specific `extraFallbacks`, de-duplicated in order. The gateway tries each
 * in turn and (when REQUIRE_ZDR) routes each only to a ZDR provider — so a
 * provider outage falls through instead of erroring.
 *
 *   const result = await generateText({ model: DEFAULT_MODEL, ...modelOptions(), ... });
 */
export function modelOptions(primary = DEFAULT_MODEL, extraFallbacks = []) {
  const models = [primary, ...FALLBACK_MODELS, ...extraFallbacks].filter(
    (m, i, a) => m && a.indexOf(m) === i,
  );
  return {
    providerOptions: {
      gateway: {
        models,
        ...(REQUIRE_ZDR ? { zeroDataRetention: true } : {}),
      },
    },
  };
}
