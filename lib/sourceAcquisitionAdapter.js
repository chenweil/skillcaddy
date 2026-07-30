const REQUIRED_ADAPTER_METHODS = [
  'inspect',
  'prepare',
  'resolveIdentity',
  'buildRecord',
  'matchesIdentity',
  'matchesContent',
  'assertInstalled'
];

/**
 * @typedef {object} SourceAcquisitionAdapter
 * @property {string} stalePlanMessage
 * @property {() => Promise<object>} inspect
 * @property {(workspaceRoot: string) => Promise<object>} prepare
 * @property {(candidate: object, records: object[]) => Promise<object>|object} resolveIdentity
 * @property {(plan: object) => object} buildRecord
 * @property {(record: object, plan: object) => boolean} matchesIdentity
 * @property {(record: object, plan: object) => boolean} matchesContent
 * @property {(rootDir: string, record: object, plan: object) => Promise<void>} assertInstalled
 */

/**
 * @param {SourceAcquisitionAdapter} adapter
 * @returns {Readonly<SourceAcquisitionAdapter>}
 */
export function defineSourceAcquisitionAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('Source acquisition adapter must be an object');
  }
  if (
    typeof adapter.stalePlanMessage !== 'string' ||
    !adapter.stalePlanMessage.trim()
  ) {
    throw new TypeError(
      'Source acquisition adapter requires stalePlanMessage'
    );
  }
  for (const method of REQUIRED_ADAPTER_METHODS) {
    if (typeof adapter[method] !== 'function') {
      throw new TypeError(
        `Source acquisition adapter requires ${method}()`
      );
    }
  }
  return Object.freeze(adapter);
}
