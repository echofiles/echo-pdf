export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (code: string, message: string, details?: unknown): HttpError =>
  new HttpError(400, code, message, details)

export const notFound = (code: string, message: string, details?: unknown): HttpError =>
  new HttpError(404, code, message, details)

export const unprocessable = (code: string, message: string, details?: unknown): HttpError =>
  new HttpError(422, code, message, details)
