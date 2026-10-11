const SECRET_PATTERN = /(authorization|cookie|password|secret|token|database[_-]?url)\s*[:=]\s*[^\s,;]+/gi;

export function redactText(value, secrets = []) {
  let text = String(value ?? "").replace(SECRET_PATTERN, "$1=[REDACTED]");
  for (const secret of secrets.filter(Boolean)) {
    text = text.split(String(secret)).join("[REDACTED]");
  }
  return text.slice(0, 600);
}

export class OutreachApiError extends Error {
  constructor(message, { status = null, code = "outreach_api_error", details = null, secrets = [], cause } = {}) {
    super(redactText(message, secrets), cause ? { cause } : undefined);
    this.name = "OutreachApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
