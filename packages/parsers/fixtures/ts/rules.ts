export function approve(amount: number): string {
  if (amount > 100) {
    log(amount);
    return issue(amount);
  } else {
    deny(amount);
  }
}

export function review(items: number[]): void {
  for (const x of items) {
    log(x);
  }
}

function log(x: number): void {
  return;
}

function issue(amount: number): string {
  return makeToken(amount);
}

function deny(x: number): void {
  throw new Error('denied');
}

export function makeToken(amount: number): string {
  return 'tok:' + amount;
}