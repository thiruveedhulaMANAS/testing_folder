class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  const payload = {
    error: status === 500 ? 'Internal server error' : err.message
  };
  if (err.details) payload.details = err.details;
  if (status === 500) {
    console.error(err);
  }
  res.status(status).json(payload);
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { HttpError, errorHandler, asyncHandler };
