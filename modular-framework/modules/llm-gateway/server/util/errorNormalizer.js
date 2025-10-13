// Normalizes thrown errors into a consistent JSON structure.

function normalizeError(err) {
  const status = err?.status || err?.statusCode || 500;
  const message =
    err?.message ||
    err?.error?.message ||
    'Unexpected error';

  const code =
    err?.code ||
    err?.error?.code ||
    (status >= 500 ? 'SERVER_ERROR' : 'BAD_REQUEST');

  const details =
    err?.error?.details ||
    err?.response?.data ||
    null;

  return {
    ok: false,
    status,
    error: {
      code,
      message,
      details
    }
  };
}

module.exports = { normalizeError };
