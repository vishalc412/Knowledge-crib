import { Alpha, type Beta, type Overloaded, helper } from './service.js';

class Shadow {
  ghost(): string {
    return 'shadow';
  }

  callback(): string {
    return 'shadow callback';
  }
}

export function run(alpha: Alpha, beta: Beta, overloaded: Overloaded, dynamic: any): string {
  const local = new Alpha();
  helper();
  alpha.ping();
  beta.ping();
  local.ping();
  overloaded.convert('value');
  dynamic.ghost();
  return 'done';
}

export function shadowed(): string {
  const helper = () => 'local';
  return helper();
}

export function invoke(callback: () => string): string {
  return callback();
}

export class Controller {
  constructor(private readonly alpha: Alpha) {}

  execute(): string {
    return this.alpha.ping();
  }
}
