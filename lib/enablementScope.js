export const ENABLEMENT_SCOPES = Object.freeze(['project', 'global', 'hermes']);

export function normalizeEnablementScope(value = 'project') {
  if (!ENABLEMENT_SCOPES.includes(value)) {
    throw new Error(`scope 必须是 project、global 或 hermes：${value}`);
  }
  return value;
}
