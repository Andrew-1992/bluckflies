/**
 * npm run eval -- [--only id,id] [--repeat N] [--max-usd 2]
 *
 * Runs the AI quality scenarios (src/evals/scenarios.ts) against the real
 * Claude model in ANTHROPIC_MODEL, on sandbox flights and an in-memory store:
 * no real bookings, payments or messages. Prints a pass/fail table, saves a
 * JSON report under evals/results/, and exits 1 if any scenario failed, so it
 * can gate a prompt or model change before deployment.
 *
 * Model output varies between runs: use --repeat 3 before switching models or
 * changing the system prompt.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AnthropicLlmClient } from '../agent/llm.js';
import { configuredPrices, costMicros, usd } from '../agent/pricing.js';
import { loadConfig } from '../config/env.js';
import { runScenario, type ScenarioResult } from '../evals/harness.js';
import { SCENARIOS } from '../evals/scenarios.js';

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      'max-usd': { type: 'string', default: '2' },
    },
  });
  // Only the AI settings are read from .env; everything else is the eval sandbox
  // (in-memory store, sandbox airlines), so evals never touch production systems.
  const ai = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(ANTHROPIC_|AGENT_PRICE_)/.test(k)));
  const config = loadConfig({ ...ai, NODE_ENV: 'development', PAYMENT_WEBHOOK_SECRET: 'eval-only-not-a-secret-0000000000000000' });
  if (!config.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in .env: evals run against the real model.');
    return 2;
  }
  const repeat = Number(values.repeat);
  const maxMicros = Number(values['max-usd']) * 1_000_000;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('--repeat must be 1 to 10');
  if (!(maxMicros > 0)) throw new Error('--max-usd must be a positive number');

  const only = values.only?.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = only?.filter((id) => !SCENARIOS.some((s) => s.id === id)) ?? [];
  if (unknown.length) throw new Error(`Unknown scenario(s): ${unknown.join(', ')}. Known: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;

  const { prices } = configuredPrices(config);
  const model = new AnthropicLlmClient(config.ANTHROPIC_API_KEY, config.ANTHROPIC_MODEL);
  console.log(`BluckFlies AI evals: ${scenarios.length} scenario(s) × ${repeat} on ${config.ANTHROPIC_MODEL}, spending cap ${usd(maxMicros)}\n`);

  const results: (ScenarioResult & { attempt: number; costMicros: number })[] = [];
  let spent = 0;
  outer: for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const s of scenarios) {
      if (spent >= maxMicros) {
        console.log(`\nStopped: spending cap ${usd(maxMicros)} reached (raise it with --max-usd).`);
        break outer;
      }
      const r = await runScenario(s, model, { modelName: config.ANTHROPIC_MODEL });
      // The eval budget is generous, so "unavailable" means the API call itself failed:
      // that is a setup problem, not the assistant misbehaving.
      if (r.run.errors.includes('AGENT_UNAVAILABLE')) {
        console.error(`Could not reach the Claude API (scenario ${s.id}). Check ANTHROPIC_API_KEY, ANTHROPIC_MODEL, billing and the network, e.g. with npm run connect:check.`);
        return 2;
      }
      const cost = costMicros(r.run.usage, prices);
      spent += cost;
      results.push({ ...r, attempt, costMicros: cost });
      console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${s.id.padEnd(28)} ${usd(cost).padStart(9)}  ${s.title}`);
      for (const f of r.failed) console.log(`        ✗ ${f}`);
      if (!r.passed) console.log(`        last reply: ${(r.run.replies.at(-1) ?? '').replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n${passed}/${results.length} passed, cost ${usd(spent)}`);
  const dir = join(process.cwd(), 'evals', 'results');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `eval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ model: config.ANTHROPIC_MODEL, at: new Date().toISOString(), costUsd: spent / 1_000_000, passed, total: results.length, results }, null, 2));
  console.log(`Report: ${file}`);
  return passed === results.length && results.length === scenarios.length * repeat ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
