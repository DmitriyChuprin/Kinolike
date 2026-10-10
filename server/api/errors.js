class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details !== undefined) error.details = details;
  return res.status(status).json({ error });
}

function notFoundHandler(req, res) {
  return sendError(res, 404, 'ENDPOINT_NOT_FOUND', 'API endpoint not found');
}

function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  if (error instanceof SyntaxError && error.status === 400 && error.type === 'entity.parse.failed') {
    return sendError(res, 400, 'INVALID_JSON', 'Request body contains invalid JSON');
  }
  if (error instanceof ApiError) {
    return sendError(res, error.status, error.code, error.message, error.details);
  }
  console.error('[Hermes API]', error);
  return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { ApiError, sendError, notFoundHandler, errorHandler, asyncRoute };
