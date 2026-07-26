export class SourceAcquisitionError extends Error {
  constructor(category, message, exitCode = 1) {
    super(message);
    this.name = 'SourceAcquisitionError';
    this.category = category;
    this.exitCode = exitCode;
  }
}

export function sourceCollisionError(message, registeredSourceId) {
  const error = new SourceAcquisitionError('source-collision', message, 3);
  if (registeredSourceId) error.registeredSourceId = registeredSourceId;
  return error;
}
