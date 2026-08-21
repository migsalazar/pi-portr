export class AskResultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AskResultError";
  }
}
