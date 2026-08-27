/** Error codes a parent agent can branch on, mapped to process exit codes. */
export type ErrorCode =
  | 'BAD_ARGS'
  | 'PROVIDER_UNREACHABLE'
  | 'TIMEOUT'
  | 'PATH_NOT_FOUND'
  | 'INTERNAL'

export const EXIT_CODES: Record<ErrorCode, number> = {
  BAD_ARGS: 2,
  PROVIDER_UNREACHABLE: 3,
  TIMEOUT: 4,
  PATH_NOT_FOUND: 5,
  INTERNAL: 10,
}

/** An error with a code and an actionable next step, ready to be printed as one-line JSON. */
export class ScoutlingError extends Error {
  readonly code: ErrorCode
  readonly hint: string | undefined

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message)
    this.name = 'ScoutlingError'
    this.code = code
    this.hint = hint
  }

  get exitCode(): number {
    return EXIT_CODES[this.code]
  }

  toJSON(): { error: ErrorCode; message: string; hint?: string } {
    return this.hint === undefined
      ? { error: this.code, message: this.message }
      : { error: this.code, message: this.message, hint: this.hint }
  }
}
