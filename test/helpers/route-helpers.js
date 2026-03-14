'use strict';

/**
 * Extract the final route handler from an Express app's internal router stack,
 * skipping middleware (requireTier, rateLimit) to call the handler directly.
 *
 * @param {object} app  - Express app instance
 * @param {string} method - HTTP method (lowercase: 'get', 'post')
 * @param {string} routePath - Route path (e.g., '/api/admin/kick')
 * @returns {Function} The route handler
 */
function extractHandler(app, method, routePath) {
  const router = app._router || app.router;
  if (!router?.stack) throw new Error('No Express router stack');
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      return st[st.length - 1].handle;
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${routePath}`);
}

/**
 * Extract a specific middleware from a route's handler stack by index.
 * Index 0 = first middleware (usually requireTier), last = actual handler.
 *
 * @param {object} app  - Express app instance
 * @param {string} method - HTTP method (lowercase)
 * @param {string} routePath - Route path
 * @param {number} [index=0] - Stack index (0 = first middleware)
 * @returns {Function} The middleware function
 */
function extractMiddleware(app, method, routePath, index = 0) {
  const router = app._router || app.router;
  if (!router?.stack) throw new Error('No Express router stack');
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      if (index >= st.length) throw new Error(`Middleware index ${index} out of bounds (${st.length} handlers)`);
      return st[index].handle;
    }
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
}

module.exports = { extractHandler, extractMiddleware };
