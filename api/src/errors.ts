/** An error the client may see verbatim, as "<type>: <message>". Anything else becomes InternalError. */
export class UserError extends Error {
  constructor(public type: "ValidationError" | "Forbidden" | "NotFound" | "Unavailable", message: string) {
    super(message);
  }
}

export const invalid = (message: string) => new UserError("ValidationError", message);
