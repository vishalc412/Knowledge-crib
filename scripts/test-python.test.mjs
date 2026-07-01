import assert from 'node:assert/strict';
import { pythonCandidates } from './test-python.mjs';

assert.deepEqual(pythonCandidates('win32'), [
  { command: 'py', prefixArgs: ['-3'] },
  { command: 'python', prefixArgs: [] },
  { command: 'python3', prefixArgs: [] },
]);
assert.deepEqual(pythonCandidates('darwin'), [
  { command: 'python3', prefixArgs: [] },
  { command: 'python', prefixArgs: [] },
]);

console.log('test-python tests ok');
