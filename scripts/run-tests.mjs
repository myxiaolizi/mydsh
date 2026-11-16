/**
 * Run every test suite and report one verdict.
 *
 * Each suite runs in its own process because several of them mutate module state
 * or open real sockets; sharing a process would let one leak into another.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Ordered cheapest-first, so a syntax error fails before the slow suites run. */
const SUITES = [
  { name: 'source gate', script: 'check-source.mjs' },
  { name: 'repo targets', script: 'test-repo.mjs' },
  { name: 'format rules', script: 'test-format.mjs' },
  { name: 'pricing', script: 'test-pricing.mjs' },
  { name: 'session titles', script: 'test-session-titles.mjs' },
  { name: 'agent family', script: 'test-agents.mjs' },
  { name: 'i18n', script: 'test-i18n.mjs' },
  { name: 'host units', script: 'test-host.mjs' },
  { name: 'usage index', script: 'test-usage.mjs' },
  { name: 'usage stress', script: 'test-usage-stress.mjs' },
  { name: 'activation', script: 'test-activation.mjs' },
  { name: 'client bundle', script: 'test-client.mjs' },
  { name: 'heatmap', script: 'test-heatmap.mjs' },
  { name: 'tunnel protocol', script: 'test-tunnel.mjs' },
  { name: 'auto-continue', script: 'test-auto-continue.mjs' },
  { name: 'control wiring', script: 'test-wiring.mjs' },
  { name: 'display effects', script: 'test-display-effects.mjs' },
  { name: 'toolbox', script: 'test-toolbox.mjs' },
  { name: '7z', script: 'test-7z.mjs' },
  { name: 'backup e2e', script: 'test-backup-e2e.mjs' },
];

function runOne(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, script)], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (error) => resolve({ code: 1, stdout: '', stderr: String(error) }));
  });
}

const failures = [];

for (const suite of SUITES) {
  const started = Date.now();
  const result = await runOne(suite.script);
  const elapsed = Date.now() - started;

  // Show the suite's own summary line, which states its pass count.
  const summary = result.stdout.split('\n').reverse().find((line) => /passed|clean/i.test(line)) ?? '';
  const ok = result.code === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${suite.name.padEnd(16)} ${String(elapsed).padStart(5)}ms  ${summary.trim()}`);

  if (!ok) {
    failures.push({ suite: suite.name, stdout: result.stdout, stderr: result.stderr });
  }
}

if (failures.length > 0) {
  console.log('');
  for (const failure of failures) {
    console.log(`===== ${failure.suite} =====`);
    const lines = `${failure.stdout}\n${failure.stderr}`.split('\n').filter((line) => line.trim() !== '');
    // Show only the failing assertions, not the passing noise.
    for (const line of lines) {
      if (/FAIL|Error|error:|failed|not valid|denied/i.test(line)) console.log(`  ${line.trim()}`);
    }
  }
  console.log(`\n${failures.length} suite(s) failed`);
  process.exit(1);
}

console.log(`\nall ${SUITES.length} suites passed`);
