// `now` here is a PARAMETER. Its call target is a value, not a statically known symbol, so no
// resolver may claim an edge to the same-named function in clock.ts (audit F11).
export function enqueue(now: () => number): number {
  return now();
}
