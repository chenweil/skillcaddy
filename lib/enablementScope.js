export const ENABLEMENT_SCOPES = Object.freeze(['project', 'global']);

export function normalizeEnablementScope(value = 'project') {
  if (!ENABLEMENT_SCOPES.includes(value)) {
    throw new Error(`scope 必须是 project 或 global：${value}`);
  }
  return value;
}
