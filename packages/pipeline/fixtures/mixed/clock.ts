// A top-level function whose bare name collides with a PARAMETER name in scheduler.ts.
// Nothing may link the two: they are unrelated symbols in different files.
export function now(): number {
  return 0;
}
