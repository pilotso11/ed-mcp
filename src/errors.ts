/** An error whose message is safe and useful to show to the user. */
export class UserError extends Error {
  override name = "UserError";
}

export class NotConfiguredError extends UserError {
  override name = "NotConfiguredError";
  constructor(service: string, vars: string[]) {
    super(`${service} not configured: set ${vars.join(", ")}`);
  }
}
