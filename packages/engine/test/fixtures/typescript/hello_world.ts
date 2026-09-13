/** Greeting demo. */

export const GREETING = "Hello";

export class Greeter {
  /** Greets people. */
  prefix: string = "Hi";

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  greet(name: string): string {
    console.log(name);
    return `${this.prefix}, ${name}`;
  }
}

export function greetUser(name: string): string {
  return `${GREETING}, ${name}`;
}
