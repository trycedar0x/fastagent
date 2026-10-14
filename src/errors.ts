export class FastagentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'FastagentError';
  }
}
