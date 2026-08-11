/** Claude declined the request (stop_reason: "refusal"). */
export class ClaudeRefusalError extends Error {
  constructor(message = "Claude refused the request") {
    super(message);
    this.name = "ClaudeRefusalError";
    Object.setPrototypeOf(this, ClaudeRefusalError.prototype);
  }
}

/** Output failed zod validation even after one repair retry. */
export class ClaudeJsonError extends Error {
  readonly raw: string;
  constructor(message: string, raw: string) {
    super(message);
    this.name = "ClaudeJsonError";
    this.raw = raw;
    Object.setPrototypeOf(this, ClaudeJsonError.prototype);
  }
}
