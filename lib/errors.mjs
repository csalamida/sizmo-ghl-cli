// lib/errors.mjs — typed errors mapped to documented exit codes.
export const EXIT = { OK: 0, API: 1, USAGE: 2, AUTH: 3, NOTFOUND: 4 };

export class GhlError extends Error {
  constructor(message, code = EXIT.API, remediation = null) {
    super(message);
    this.name = 'GhlError';
    this.code = code;
    this.remediation = remediation;
  }
}
