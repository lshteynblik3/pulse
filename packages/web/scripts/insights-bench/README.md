# insights-bench

A **throwaway model bench** for Phase 5 (AI insights). It is **not** the cron, the
worker, or anything in the request path — it exists only to compare candidate
models on the real coach prompt and realistic data before we commit to one.

It runs each candidate model over six deliberately-ugly fixtures N times, and
reports:

- a **schema-adherence table** (how often the raw output passes the strict zod
  schema), and
- the **full untruncated raw outputs** grouped by model × fixture, so you can
  read tone and the hard privacy line by eye.

## What it measures

- **Three call outcomes:** `schema-valid` / `schema-invalid` / `transport-error`.
  Transport errors (HTTP error, timeout, 429) are **excluded** from the pass-rate
  denominator and retried with backoff — a rate-limit is not a JSON-quality
  failure.
- **Three parse categories:** `clean` (parsed as-is) / `fenced` (only parsed
  after stripping ` ``` ` code fences — the model ignored "no code fences") /
  `hard-invalid`. Fences are never stripped silently; `fenced` is its own bucket.
- **Token counts + a per-run cost estimate**, labelled the **tiebreaker, not the
  filter**. Gemini pricing is approximate (see `providers.ts`); reliability and
  tone decide, not cost.

The three insight types (`peak-window`, `meeting-load`, `streak`) each map to a
dedicated input number, so every insight is grounded. (`consistency` was dropped
— it had no dedicated number and free-floated into ungrounded praise on thin
fixtures.)

It validates **unconstrained** output with `safeParse` — no Anthropic
structured-outputs / `output_config.format` — so both providers are judged on
equal footing for raw instruction-following.

## Providers & models

Two providers, behind one `generate()` seam in `providers.ts`:

- **Anthropic** via the official `@anthropic-ai/sdk` — `claude-haiku-4-5-20251001`.
  The frozen system prompt carries `cache_control: ephemeral`, mirroring the real
  Phase 5 caching design.
- **Gemini** via raw `fetch` — `gemini-3.1-flash-lite`, falling back once (logged)
  to the `gemini-2.5-flash-lite` alias if your account 404s the primary.

Model IDs are adjustable constants at the top of `providers.ts` (non-legacy as of
June 2026).

## Run it

Set the keys you have (a missing key skips that provider — no crash). On
PowerShell:

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
$env:GEMINI_API_KEY = "..."
pnpm --filter @pulse/web bench:insights
```

`N` (runs per model × fixture) is a const at the top of `run.ts`, default `5`.
At N=5 with both providers that's 2 × 6 × 5 = 60 calls, run sequentially.

## Files

- `schema.ts` — the strict zod output schema + bounds rationale.
- `prompt.ts` — the frozen coach system prompt + the labelled-plain-lines user
  message builder (absence spelled in words).
- `fixtures.ts` — the six contract-shaped fixtures.
- `providers.ts` — the two-provider `generate()` seam.
- `run.ts` — the harness (loops, retries, table, raw dumps, flags).
