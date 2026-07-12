export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function toBool(value) {
  return value === true || value === "true" || value === "on" || value === "1";
}

export function parseArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function emailDomain(email = "") {
  return String(email).split("@")[1]?.toLowerCase() || "";
}
