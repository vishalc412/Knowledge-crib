export class Base {
  greet(): string {
    return 'hi';
  }
}

export interface Greeter {
  greet(): string;
}

export function helper(): number {
  return 42;
}
