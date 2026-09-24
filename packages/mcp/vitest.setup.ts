import { afterEach } from 'vitest';

// Vitest runs synchronous tests back to back with only microtask yields, so the worker's event loop
// never reaches I/O between them. Its onTaskUpdate RPC reply then sits unread; once a file's run of
// synchronous tests passes 60s (slow Windows runners, a loaded machine), the overdue RPC timer fires
// before the reply is read and the run exits 1 with every test passing. One real macrotask per test
// lets the reply through. Captured at load, before any test can install fake timers.
const realSetImmediate = globalThis.setImmediate;

afterEach(() => new Promise<void>((resolve) => realSetImmediate(() => resolve())));
