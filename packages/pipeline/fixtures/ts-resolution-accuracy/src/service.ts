export class Alpha {
  ping(): string {
    return 'alpha';
  }
}

export class Beta {
  ping(): string {
    return 'beta';
  }
}

export function helper(): string {
  return 'helper';
}

export class Overloaded {
  convert(value: string): string;
  convert(value: number): string;
  convert(value: string | number): string {
    return String(value);
  }
}
