import { Base, type Greeter, helper } from './base.js';

export class App extends Base implements Greeter {
  run(): number {
    return helper();
  }
}
