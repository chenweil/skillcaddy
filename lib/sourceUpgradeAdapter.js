const REQUIRED_ADAPTER_METHODS = ['inspect', 'prepare'];
const VALID_KINDS = ['git', 'directory'];

/**
 * @typedef {object} SourceUpgradeAdapter
 * @property {string} stalePlanMessage
 * @property {'git' | 'directory'} kind
 * @property {() => Promise<object>} inspect
 * @property {(workspaceRoot?: string) => Promise<object>} prepare
 */

/**
 * @param {SourceUpgradeAdapter} adapter
 * @returns {Readonly<SourceUpgradeAdapter>}
 */
export function defineSourceUpgradeAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('Source upgrade adapter must be an object');
  }
  if (
    typeof adapter.stalePlanMessage !== 'string' ||
    !adapter.stalePlanMessage.trim()
  ) {
    throw new TypeError(
      'Source upgrade adapter requires stalePlanMessage'
    );
  }
  if (!VALID_KINDS.includes(adapter.kind)) {
    throw new TypeError(
      `Source upgrade adapter requires kind ('git' or 'directory')`
    );
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(
        `Source upgrade adapter requires ${method}()`
      );
    }
  }
  return Object.freeze(adapter);
}
