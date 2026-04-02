/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access,
   @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment,
   @typescript-eslint/no-unsafe-function-type */

export function extractHandler(app: any, method: string, routePath: string): Function {
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

export function extractMiddleware(app: any, method: string, routePath: string, index = 0): Function {
  const router = app._router || app.router;
  if (!router?.stack) throw new Error('No Express router stack');
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      if (index >= st.length)
        throw new Error(`Middleware index ${String(index)} out of bounds (${String(st.length)} handlers)`);
      return st[index].handle;
    }
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
}

// CJS compat
module.exports = { extractHandler, extractMiddleware };
