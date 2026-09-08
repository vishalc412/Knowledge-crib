import assert from 'node:assert/strict';
import { evaluateLaunchDecision } from './launch-decision.mjs';

assert.deepEqual(
  evaluateLaunchDecision({
    acceptance: { pass: true, requiredFailures: [] },
    certification: { required: true, missingRuntimeCells: [] },
  }),
  { decision: 'GO', blockers: [] },
);
assert.deepEqual(
  evaluateLaunchDecision({
    acceptance: { pass: false, requiredFailures: ['clean-commit', 'runtime-certification'] },
    certification: { required: true, missingRuntimeCells: ['codex/win32'] },
  }),
  {
    decision: 'NO-GO',
    blockers: ['clean-commit', 'runtime-certification', 'codex/win32'],
  },
);
console.log('launch decision tests ok');
