import path from "node:path";
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import { OutreachApiError, redactText } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("OUTREACH_BASE_URL must be a valid http or https URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new TypeError("OUTREACH_BASE_URL must use http or https");
  }
  if (url.username || url.password) {
    throw new TypeError("OUTREACH_BASE_URL must not contain credentials");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function appendQuery(url, query = {}) {
  for (const [key, rawValue] of Object.entries(query)) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) url.searchParams.append(key, String(value));
  }
}

async function decodeResponse(response) {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return { error: "invalid_json_response", message: text.slice(0, 500) };
    }
  }
  return text;
}

function safeErrorDetails(value, token) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return redactText(value, [token]);
  try {
    return JSON.parse(redactText(JSON.stringify(value), [token]));
  } catch {
    return null;
  }
}

export function createOutreachClient({
  baseUrl = "http://127.0.0.1:3000",
  token,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  if (!String(token || "").trim()) throw new TypeError("MCP API token is required");
  if (typeof fetchImpl !== "function") throw new TypeError("fetch implementation is required");
  const normalizedTimeoutMs = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 100), 120_000);

  async function request(endpoint, { method = "GET", query, body, form } = {}) {
    const url = new URL(endpoint, normalizedBaseUrl);
    appendQuery(url, query);
    const headers = { accept: "application/json", authorization: `Bearer ${token}` };
    let requestBody;
    if (form) {
      requestBody = form;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      requestBody = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(normalizedTimeoutMs),
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new OutreachApiError(
        timedOut
          ? `Outreach Desk request timed out after ${normalizedTimeoutMs} ms`
          : `Outreach Desk is unavailable at ${normalizedBaseUrl.origin}`,
        { code: timedOut ? "request_timeout" : "request_failed", secrets: [token], cause: error },
      );
    }

    const decoded = await decodeResponse(response);
    if (!response.ok) {
      const code = typeof decoded === "object" && decoded?.error ? String(decoded.error) : "http_error";
      const detailText = typeof decoded === "string"
        ? decoded
        : decoded?.message || decoded?.error || `HTTP ${response.status}`;
      throw new OutreachApiError(`Outreach Desk returned ${response.status}: ${detailText}`, {
        status: response.status,
        code,
        details: safeErrorDetails(decoded, token),
        secrets: [token],
      });
    }
    return decoded;
  }

  async function upload(endpoint, {
    filePath,
    fields = {},
    allowedExtensions = [],
    maxBytes = DEFAULT_MAX_UPLOAD_BYTES,
    fileField = "file",
  } = {}) {
    if (!path.isAbsolute(String(filePath || ""))) {
      throw new OutreachApiError("Upload path must be absolute", { code: "upload_path_not_absolute" });
    }
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      throw new OutreachApiError("Upload file does not exist", { code: "upload_file_not_found", cause: error });
    }
    if (!fileStat.isFile()) {
      throw new OutreachApiError("Upload path must point to a regular file", { code: "upload_not_regular_file" });
    }
    const extension = path.extname(filePath).toLowerCase();
    const normalizedExtensions = allowedExtensions.map((item) => String(item).toLowerCase());
    if (normalizedExtensions.length && !normalizedExtensions.includes(extension)) {
      throw new OutreachApiError(`Upload extension ${extension || "(none)"} is not allowed`, { code: "upload_extension_not_allowed" });
    }
    if (fileStat.size > maxBytes) {
      throw new OutreachApiError(`Upload size ${fileStat.size} exceeds limit ${maxBytes}`, { code: "upload_too_large" });
    }

    const form = new FormData();
    for (const [key, rawValue] of Object.entries(fields)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value !== undefined && value !== null) form.append(key, String(value));
      }
    }
    form.append(fileField, await openAsBlob(filePath), path.basename(filePath));
    return request(endpoint, { method: "POST", form });
  }

  return {
    request,
    get: (endpoint, options = {}) => request(endpoint, { ...options, method: "GET" }),
    post: (endpoint, body, options = {}) => request(endpoint, { ...options, method: "POST", body }),
    patch: (endpoint, body, options = {}) => request(endpoint, { ...options, method: "PATCH", body }),
    put: (endpoint, body, options = {}) => request(endpoint, { ...options, method: "PUT", body }),
    delete: (endpoint, body, options = {}) => request(endpoint, { ...options, method: "DELETE", body }),
    upload,
  };
}
