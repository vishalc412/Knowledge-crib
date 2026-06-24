// A minimal TS module in the mixed fixture. It must not be linked to the SQL tables/procs.
export function greet(name: string): string {
  return `hello ${name}`;
}
