import assert from 'node:assert/strict';
import { renderClientCertificationMatrix } from './client-certification-matrix.mjs';

const rendered = renderClientCertificationMatrix([
  {
    client: { id: 'codex', version: '0.42.0' },
    platform: { os: 'darwin', arch: 'arm64', node: 'v22.23.1' },
    evidence: {
      configuration: { status: 'pass' },
      protocol: { status: 'pass' },
      runtime: { status: 'pass' },
    },
  },
]);

assert.match(rendered, /\| Codex \| runtime verified \| macOS arm64 \(0\.42\.0\) \|/);
assert.match(rendered, /\| Claude Code \| not certified \| — \|/);
assert.doesNotMatch(rendered, /configuration verified.*Codex/);
console.log('client certification matrix tests ok');
