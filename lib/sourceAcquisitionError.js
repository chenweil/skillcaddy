export class SourceAcquisitionError extends Error {
  constructor(category, message, exitCode = 1) {
    super(message);
    this.name = 'SourceAcquisitionError';
    this.category = category;
    this.exitCode = exitCode;
  }
}
