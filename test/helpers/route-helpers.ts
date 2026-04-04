type HandlerFn = (...args: unknown[]) => unknown;

export function extractHandler(app: any, method: string, routePath: string): HandlerFn {
  const router = app._router || app.router;
  if (!router?.stack) throw new Error('No Express router stack');
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      return st[st.length - 1].handle as HandlerFn;
    }
  }
  throw new Error(`Handler not found: ${method.toUpperCase()} ${routePath}`);
}

export function extractMiddleware(app: any, method: string, routePath: string, index = 0): HandlerFn {
  const router = app._router || app.router;
  if (!router?.stack) throw new Error('No Express router stack');
  for (const layer of router.stack) {
    if (layer.route?.path === routePath && layer.route.methods[method]) {
      const st = layer.route.stack;
      if (index >= st.length)
        throw new Error(`Middleware index ${String(index)} out of bounds (${String(st.length)} handlers)`);
      return st[index].handle as HandlerFn;
    }
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
}

// CJS compat
module.exports = { extractHandler, extractMiddleware };
