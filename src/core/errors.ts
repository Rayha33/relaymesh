export class RelayError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "RelayError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: string): RelayError {
  return new RelayError(404, "NOT_FOUND", `${entity} ${id} was not found`);
}

export function conflict(message: string, details?: unknown): RelayError {
  return new RelayError(409, "CONFLICT", message, details);
}

export function forbidden(message: string): RelayError {
  return new RelayError(403, "FORBIDDEN", message);
}

export function unauthorized(message = "Authentication required"): RelayError {
  return new RelayError(401, "UNAUTHORIZED", message);
}
