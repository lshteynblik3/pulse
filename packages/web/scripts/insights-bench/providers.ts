/**
 * insights-bench — the provider seam.
 *
 * ONE function shape per provider: generate(model, system, user) => GenResult
 * (text plus the provider's own reported token usage, which we use for the cost
 * tiebreaker — no separate token-count call needed). Swapping/adding a provider
 * is one entry in PROVIDERS.
 *
 * Two providers this bench:
 *  - Anthropic via the official @anthropic-ai/sdk (the playbook's intended
 *    provider). The system prompt carries cache_control: ephemeral so the frozen
 *    prefix prompt-caches across runs — mirroring the real Phase 5 design.
 *  - Gemini via raw fetch (we don't add its SDK for a throwaway harness).
 *
 * generate() RETURNS text on any successful HTTP response, and THROWS only on
 * transport problems (HTTP error, timeout, network). run.ts treats every throw
 * as a transport-error: excluded from the JSON-quality pass rate, retried with
 * backoff. A rate-limit is never scored as a JSON failure.
 *
 * NOTE: this bench uses the synchronous Messages API for fast iteration. The
 * real Phase 5 worker will use the BATCH API (50% off, latency-insensitive) —
 * out of scope here.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface GenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface GenResult {
  text: string;
  usage: GenUsage;
}

/** Thrown for transport-layer failures (HTTP non-2xx). Timeouts/network errors
 *  surface as ordinary thrown errors; run.ts treats both as transport. */
export class TransportError extends Error {
  constructor(
    public status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Per-MTok USD pricing for the cost tiebreaker. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ProviderConfig {
  key: 'anthropic' | 'gemini';
  label: string;
  model: string;
  envVar: string;
  pricing: Pricing;
  generate: (model: string, system: string, user: string) => Promise<GenResult>;
}

const MAX_OUTPUT_TOKENS = 1024;
const REQUEST_TIMEOUT_MS = 60_000;

// ---- Model IDs (non-legacy as of June 2026; adjust here if your account differs) ----
export const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
// Primary; if your account doesn't expose it the Gemini provider falls back to
// the bare alias below on a 404 (one time, logged). Never the dated
// `-preview-09-2025` string.
export const GEMINI_PRIMARY_MODEL = 'gemini-3.1-flash-lite';
export const GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash-lite';

// ---- Anthropic (official SDK) ----
// Constructed LAZILY: `new Anthropic()` throws when ANTHROPIC_API_KEY is unset,
// so building it at module load would crash a Gemini-only run. maxRetries: 0 so
// OUR backoff loop in run.ts is the single source of retry behavior.
let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  }
  return anthropicClient;
}

async function anthropicGenerate(model: string, system: string, user: string): Promise<GenResult> {
  try {
    const resp = await getAnthropic().messages.create({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
    });
    const text = resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      usage: {
        inputTokens: resp.usage.input_tokens,
        outputTokens: resp.usage.output_tokens,
        cacheReadTokens: resp.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: resp.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    // Any SDK error here is transport-level for our purposes (we don't send
    // malformed requests). Re-throw as TransportError so run.ts classifies it.
    const status = err instanceof Anthropic.APIError ? (err.status ?? null) : null;
    throw new TransportError(status, err instanceof Error ? err.message : String(err));
  }
}

// ---- Gemini (raw fetch) with one-time primary->fallback model resolution ----
let geminiResolved: string | null = null;
let geminiFallbackWarned = false;

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

async function geminiFetch(model: string, system: string, user: string, key: string): Promise<Response> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.7 },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function geminiGenerate(model: string, system: string, user: string): Promise<GenResult> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new TransportError(null, 'GEMINI_API_KEY not set');

  // Once resolved, stick to that model. Otherwise try primary then fallback.
  const candidates = geminiResolved ? [geminiResolved] : [model, GEMINI_FALLBACK_MODEL];

  for (let i = 0; i < candidates.length; i++) {
    const m = candidates[i];
    const res = await geminiFetch(m, system, user, key);

    // 404 on the primary => try the fallback alias (one time, logged).
    if (res.status === 404 && i < candidates.length - 1) {
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new TransportError(res.status, `Gemini HTTP ${res.status}: ${detail}`.slice(0, 300));
    }

    geminiResolved = m;
    if (m !== model && !geminiFallbackWarned) {
      geminiFallbackWarned = true;
      console.warn(`  [gemini] primary "${model}" unavailable (404) — using fallback "${m}".`);
    }

    const data = (await res.json()) as GeminiResponse;
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
    const um = data.usageMetadata ?? {};
    return {
      text,
      usage: {
        inputTokens: um.promptTokenCount ?? 0,
        outputTokens: um.candidatesTokenCount ?? 0,
        cacheReadTokens: um.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
      },
    };
  }

  throw new TransportError(404, `No available Gemini model (tried ${candidates.join(', ')})`);
}

/** The model Gemini actually used (after fallback resolution), for the summary. */
export function resolvedGeminiModel(): string {
  return geminiResolved ?? GEMINI_PRIMARY_MODEL;
}

export const PROVIDERS: ProviderConfig[] = [
  {
    key: 'anthropic',
    label: 'Anthropic Haiku 4.5',
    model: ANTHROPIC_MODEL,
    envVar: 'ANTHROPIC_API_KEY',
    // From the Claude API model table: $1 / $5 per MTok; cache read 0.1x, write 1.25x.
    pricing: { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 },
    generate: anthropicGenerate,
  },
  {
    key: 'gemini',
    label: 'Gemini Flash-Lite',
    model: GEMINI_PRIMARY_MODEL,
    envVar: 'GEMINI_API_KEY',
    // APPROXIMATE flash-lite pricing — adjust to your account's rate card. Cost
    // is the TIEBREAKER here, not the filter, so exactness isn't load-bearing.
    pricing: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0 },
    generate: geminiGenerate,
  },
];
