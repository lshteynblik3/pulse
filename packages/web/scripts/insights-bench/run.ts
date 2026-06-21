/**
 * insights-bench — the harness.
 *
 * For each present provider × each fixture, run N times (sequential, gentle
 * inter-call delay). Per call, record one of THREE outcomes:
 *   - schema-valid    : parsed AND passed the zod schema
 *   - schema-invalid  : parsed but failed the schema, OR couldn't be parsed
 *   - transport       : HTTP error / timeout / 429 (after backoff retries)
 * Transport errors are EXCLUDED from the pass-rate denominator and retried with
 * backoff — a rate-limit is not a JSON-quality failure.
 *
 * Parse outcomes are categorized THREE ways so you can judge instruction
 * following separately from validity:
 *   - clean    : JSON.parse succeeded on the raw text as-is
 *   - fenced   : only parsed after stripping ```code fences``` (the model
 *                ignored "no code fences" but the JSON was otherwise fine)
 *   - hard-invalid : not parseable even after stripping fences
 * We never silently strip fences before parsing — fenced is its own bucket.
 *
 * Output: the results table, then the FULL untruncated raw text grouped by
 * provider × fixture (read tone + the privacy line by eye).
 *
 * Run: pnpm --filter @pulse/web bench:insights
 * Env: ANTHROPIC_API_KEY, GEMINI_API_KEY (a missing key skips that provider).
 */

import { insightsSchema } from './schema';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt';
import { FIXTURES, type BenchFixture } from './fixtures';
import {
  PROVIDERS,
  TransportError,
  resolvedGeminiModel,
  type GenUsage,
  type Pricing,
  type ProviderConfig,
} from './providers';

const N = 5;
const MAX_TRANSPORT_RETRIES = 3;
const INTER_CALL_DELAY_MS = 250;

/** Temporal gate: insights are read days later, so a relative day word in the
 *  OUTPUT points at the wrong day. Any hit fails the gate. */
const RELATIVE = /\b(today|tomorrow|yesterday)\b/i;

type Outcome = 'schema-valid' | 'schema-invalid' | 'transport';
type ParseCategory = 'clean' | 'fenced' | 'hard-invalid' | 'n/a';

interface RunRecord {
  outcome: Outcome;
  parseCategory: ParseCategory;
  rawText: string;
  transportMessage?: string;
  usage?: GenUsage;
  cost?: number;
  /** Whether the raw output contains a relative day word (today/tomorrow/yesterday). */
  relativeWords?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function costOf(usage: GenUsage, p: Pricing): number {
  return (
    (usage.inputTokens * p.input +
      usage.cacheReadTokens * p.cacheRead +
      usage.cacheWriteTokens * p.cacheWrite +
      usage.outputTokens * p.output) /
    1_000_000
  );
}

/** Parse raw model text. Never silently strips fences: clean first, then a
 *  fenced retry recorded as its own category, else hard-invalid. */
function parseRaw(raw: string): { parsed: unknown; category: Exclude<ParseCategory, 'n/a'> } {
  const trimmed = raw.trim();
  try {
    return { parsed: JSON.parse(trimmed), category: 'clean' };
  } catch {
    /* fall through */
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return { parsed: JSON.parse(fence[1].trim()), category: 'fenced' };
    } catch {
      /* fall through */
    }
  }
  return { parsed: null, category: 'hard-invalid' };
}

async function callWithRetry(
  provider: ProviderConfig,
  user: string,
): Promise<{ result?: Awaited<ReturnType<ProviderConfig['generate']>>; transportMessage?: string }> {
  for (let attempt = 0; attempt <= MAX_TRANSPORT_RETRIES; attempt++) {
    try {
      const result = await provider.generate(provider.model, SYSTEM_PROMPT, user);
      return { result };
    } catch (err) {
      const msg =
        err instanceof TransportError
          ? `HTTP ${err.status ?? 'n/a'}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err);
      if (attempt === MAX_TRANSPORT_RETRIES) return { transportMessage: msg };
      const delay = 1000 * 2 ** attempt; // 1s, 2s, 4s
      console.warn(
        `    transport error (attempt ${attempt + 1}/${MAX_TRANSPORT_RETRIES + 1}): ${msg} — retrying in ${delay}ms`,
      );
      await sleep(delay);
    }
  }
  return { transportMessage: 'unreachable' };
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

async function main() {
  const present = PROVIDERS.filter((p) => {
    if (!process.env[p.envVar]) {
      console.log(`Skipping ${p.label}: ${p.envVar} not set.`);
      return false;
    }
    return true;
  });
  if (present.length === 0) {
    console.log('\nNo providers available — set ANTHROPIC_API_KEY and/or GEMINI_API_KEY.');
    process.exit(1);
  }

  console.log(`\ninsights-bench — N=${N} per (provider × fixture), sequential.`);
  console.log(`Providers: ${present.map((p) => `${p.label} [${p.model}]`).join(', ')}`);
  console.log(`Fixtures: ${FIXTURES.length}. Total calls: ${present.length * FIXTURES.length * N}.\n`);

  // key: `${providerKey}::${fixtureKey}` -> records
  const results = new Map<string, RunRecord[]>();

  for (const provider of present) {
    for (const fixture of FIXTURES) {
      const user = buildUserMessage(fixture);
      const runs: RunRecord[] = [];
      for (let i = 0; i < N; i++) {
        process.stdout.write(`[${provider.key}] ${fixture.key} run ${i + 1}/${N} ... `);
        const { result, transportMessage } = await callWithRetry(provider, user);

        if (!result) {
          runs.push({ outcome: 'transport', parseCategory: 'n/a', rawText: '', transportMessage });
          console.log('transport-error');
          await sleep(INTER_CALL_DELAY_MS);
          continue;
        }

        const cost = costOf(result.usage, provider.pricing);
        const relativeWords = RELATIVE.test(result.text);
        const { parsed, category } = parseRaw(result.text);

        if (parsed === null) {
          runs.push({ outcome: 'schema-invalid', parseCategory: 'hard-invalid', rawText: result.text, usage: result.usage, cost, relativeWords });
          console.log('schema-invalid (hard-invalid)');
        } else {
          const sp = insightsSchema.safeParse(parsed);
          if (sp.success) {
            runs.push({ outcome: 'schema-valid', parseCategory: category, rawText: result.text, usage: result.usage, cost, relativeWords });
            console.log(`schema-valid (${category})${relativeWords ? ' [RELATIVE-WORD]' : ''}`);
          } else {
            runs.push({ outcome: 'schema-invalid', parseCategory: category, rawText: result.text, usage: result.usage, cost, relativeWords });
            console.log(`schema-invalid (${category})`);
          }
        }
        await sleep(INTER_CALL_DELAY_MS);
      }
      results.set(`${provider.key}::${fixture.key}`, runs);
    }
  }

  // ---- Results table ----
  console.log('\n\n===== RESULTS =====');
  console.log(
    'pass rate = schema-valid / (schema-valid + schema-invalid). transport excluded from denominator.\n',
  );
  const header = [
    pad('provider', 11),
    pad('fixture', 24),
    pad('valid', 6),
    pad('invalid', 8),
    pad('transp', 7),
    pad('pass%', 6),
    pad('clean', 6),
    pad('fenced', 7),
    pad('hard', 5),
    pad('relWd', 6),
    pad('inTok', 7),
    pad('outTok', 7),
    pad('$/run', 10),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const provider of present) {
    for (const fixture of FIXTURES) {
      const runs = results.get(`${provider.key}::${fixture.key}`) ?? [];
      const valid = runs.filter((r) => r.outcome === 'schema-valid').length;
      const invalid = runs.filter((r) => r.outcome === 'schema-invalid').length;
      const transp = runs.filter((r) => r.outcome === 'transport').length;
      const denom = valid + invalid;
      const passRate = denom === 0 ? 'n/a' : `${Math.round((valid / denom) * 100)}%`;
      const clean = runs.filter((r) => r.parseCategory === 'clean').length;
      const fenced = runs.filter((r) => r.parseCategory === 'fenced').length;
      const hard = runs.filter((r) => r.parseCategory === 'hard-invalid').length;
      const relWd = runs.filter((r) => r.relativeWords).length;
      const scored = runs.filter((r) => r.usage);
      const avgIn = scored.length
        ? Math.round(scored.reduce((s, r) => s + (r.usage!.inputTokens + r.usage!.cacheReadTokens + r.usage!.cacheWriteTokens), 0) / scored.length)
        : 0;
      const avgOut = scored.length ? Math.round(scored.reduce((s, r) => s + r.usage!.outputTokens, 0) / scored.length) : 0;
      const avgCost = scored.length ? scored.reduce((s, r) => s + (r.cost ?? 0), 0) / scored.length : 0;

      console.log(
        [
          pad(provider.key, 11),
          pad(fixture.key, 24),
          pad(String(valid), 6),
          pad(String(invalid), 8),
          pad(String(transp), 7),
          pad(passRate, 6),
          pad(String(clean), 6),
          pad(String(fenced), 7),
          pad(String(hard), 5),
          pad(String(relWd), 6),
          pad(String(avgIn), 7),
          pad(String(avgOut), 7),
          pad(`$${avgCost.toFixed(6)}`, 10),
        ].join(' '),
      );
    }
  }

  // ---- Cost tiebreaker note ----
  console.log(
    '\nCOST IS THE TIEBREAKER, NOT THE FILTER. At one paid user the per-night difference\n' +
      'between these models is a fraction of a cent — reliability and tone win. Gemini\n' +
      'pricing is approximate (see providers.ts); Anthropic is from the model rate card.',
  );
  if (present.some((p) => p.key === 'gemini')) {
    console.log(`Gemini resolved to model: ${resolvedGeminiModel()}`);
  }

  // ---- Full raw outputs ----
  console.log('\n\n===== RAW OUTPUTS (untruncated) =====');
  for (const provider of present) {
    for (const fixture of FIXTURES) {
      const runs = results.get(`${provider.key}::${fixture.key}`) ?? [];
      console.log(`\n########## ${provider.label} × ${fixture.label} ##########`);
      runs.forEach((r, i) => {
        const tag = r.outcome === 'transport' ? `transport-error: ${r.transportMessage}` : `${r.outcome} / ${r.parseCategory}`;
        console.log(`\n--- run ${i + 1}/${N} [${tag}] ---`);
        if (r.outcome !== 'transport') console.log(r.rawText);
      });
    }
  }

  // ---- Relative-words gate (the temporal gate) ----
  console.log('\n\n===== RELATIVE-WORDS GATE =====');
  console.log('Any model output containing "today", "tomorrow", or "yesterday" FAILS the gate.\n');
  let relHits = 0;
  for (const provider of present) {
    for (const fixture of FIXTURES) {
      const runs = results.get(`${provider.key}::${fixture.key}`) ?? [];
      runs.forEach((r, i) => {
        if (r.outcome === 'transport') return;
        const m = r.rawText.match(RELATIVE);
        if (m) {
          relHits++;
          console.log(`[${provider.key}] ${fixture.key} run ${i + 1}: contains "${m[0]}"`);
        }
      });
    }
  }
  if (relHits === 0) console.log('>>> CLEAN — zero relative day words in any output.');
  else console.log(`\n>>> ${relHits} output(s) contain a relative day word — TEMPORAL GATE FAILED.`);

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nBench crashed:', err);
  process.exit(1);
});
