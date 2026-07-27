// Learn more: https://docs.expo.dev/guides/customizing-metro/
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

/**
 * `expo-sqlite` runs on the web through wa-sqlite, which is compiled to
 * WebAssembly. Metro does not treat `.wasm` as an asset by default, so the
 * import inside `expo-sqlite/web/worker.ts` fails to resolve and takes the
 * entire web bundle down with it.
 */
config.resolver.assetExts.push('wasm');

/**
 * wa-sqlite stores its database in a SharedArrayBuffer, which browsers only
 * expose to cross-origin-isolated pages. Without these two headers the page
 * loads but every database call fails at runtime — a much more confusing
 * failure than a build error.
 */
config.server.enhanceMiddleware = (middleware) => (request, response, next) => {
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  return middleware(request, response, next);
};

module.exports = config;
