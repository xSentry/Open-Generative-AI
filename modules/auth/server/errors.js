export class AuthError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.status = status;
  }
}

export function errorResponse(error) {
  if (error instanceof AuthError || (error?.code && error?.status)) {
    return {
      body: { error: { code: error.code, message: error.message } },
      status: error.status,
    };
  }

  console.error(error);
  return {
    body: { error: { code: 'server_error', message: 'Unexpected server error.' } },
    status: 500,
  };
}
