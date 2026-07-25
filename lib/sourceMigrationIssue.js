export class SourceMigrationIssue extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}
