'use strict';

function wrapAsyncHandler(handler) {
  return function asyncRouteBoundary(req, res, next) {
    try {
      return Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      return next(error);
    }
  };
}

function patchAsyncRoutes(app) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'all']) {
    const original = app[method];
    if (typeof original !== 'function') continue;
    app[method] = function patchedRoute(path, ...handlers) {
      return original.call(this, path, ...handlers.map(handler =>
        typeof handler === 'function' ? wrapAsyncHandler(handler) : handler
      ));
    };
  }
}

function createErrorMiddleware(logger = console) {
  return function errorMiddleware(error, req, res, next) {
    logger.error('Unhandled request error:', error && (error.stack || error.message || error));
    if (res.headersSent) return next(error);
    return res.status(500).json({ error: 'خطای داخلی سرور.' });
  };
}

module.exports = { wrapAsyncHandler, patchAsyncRoutes, createErrorMiddleware };
