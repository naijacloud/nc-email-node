/**
 * Kept as a literal rather than read from package.json.
 *
 * Importing package.json would need `resolveJsonModule` and would resolve
 * differently under ESM and CJS, and the published tarball deliberately ships
 * only `dist/` — a runtime read of a file outside it is a crash waiting for the
 * first consumer who bundles us. `npm version` and this line move together.
 */
export const VERSION = '0.2.1';
