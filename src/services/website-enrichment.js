import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_PAGES = 3;
const MAX_REDIRECTS = 5;

function error(code) {
  return new Error(code);
}

export function normalizeWebsiteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) throw error("website_url_required");
  return new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
}

function normalizedHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function privateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && parts[2] === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && parts[2] === 100) ||
    (a === 203 && b === 0 && parts[2] === 113) ||
    a >= 224
  );
}

function privateIpv6(address) {
  const value = normalizedHostname(address).split("%")[0];
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("::ffff:")) {
    const tail = value.slice("::ffff:".length);
    return net.isIP(tail) === 4 ? privateIpv4(tail) : true;
  }
  const first = Number.parseInt(value.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    value.startsWith("2001:db8:")
  );
}

function isPublicIp(address) {
  const family = net.isIP(normalizedHostname(address));
  if (family === 4) return !privateIpv4(address);
  if (family === 6) return !privateIpv6(address);
  return false;
}

export async function assertPublicHttpUrl(url, { lookup = dnsLookup } = {}) {
  const target = url instanceof URL ? url : normalizeWebsiteUrl(url);
  if (!["http:", "https:"].includes(target.protocol)) throw error("website_protocol_not_allowed");
  if (target.username || target.password) throw error("website_credentials_not_allowed");
  const hostname = normalizedHostname(target.hostname);
  if (!hostname) throw error("website_url_not_public");

  if (net.isIP(hostname)) {
    if (!isPublicIp(hostname)) throw error("website_url_not_public");
    return;
  }

  let answers;
  try {
    answers = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw error("website_dns_failed");
  }
  const records = Array.isArray(answers) ? answers : [answers];
  if (!records.length || records.some((record) => !isPublicIp(record?.address || ""))) {
    throw error("website_url_not_public");
  }
}

function siteKey(url) {
  return normalizedHostname(url.hostname).replace(/^www\./, "");
}

function sameSite(left, right) {
  return siteKey(left) === siteKey(right);
}

async function readBoundedText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw error("website_response_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw error("website_response_too_large");
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw error("website_response_too_large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

async function fetchHtmlPage({ url, rootUrl, fetchImpl, lookup, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(error("website_request_timeout")), timeoutMs);
  try {
    let current = new URL(url);
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      await assertPublicHttpUrl(current, { lookup });
      if (!sameSite(rootUrl, current)) throw error("website_cross_site_redirect");
      const response = await fetchImpl(current.href, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "KorDev-Outreach-Personalization/1.0 contact=team@korotkov.dev",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw error("website_redirect_without_location");
        if (redirectCount === MAX_REDIRECTS) throw error("website_too_many_redirects");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw error(`website_http_${response.status}`);
      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
        throw error("website_content_type_not_html");
      }
      const html = await readBoundedText(response, maxBytes);
      return { url: current.href, html };
    }
    throw error("website_too_many_redirects");
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decodeHtml(String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|address)>/gi, ". ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function pageCandidates(html, rootUrl) {
  const candidates = [];
  const anchorPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorPattern)) {
    let url;
    try {
      url = new URL(decodeHtml(match[1]), rootUrl);
    } catch {
      continue;
    }
    if (!sameSite(rootUrl, url) || !["http:", "https:"].includes(url.protocol)) continue;
    const label = htmlToText(match[2]).toLowerCase();
    const haystack = `${label} ${url.pathname.toLowerCase()}`;
    let score = 0;
    if (/контакт|contact/.test(haystack)) score = 20;
    else if (/о[-_ ]?(компании|нас)|about|company/.test(haystack)) score = 10;
    if (!score) continue;
    url.hash = "";
    candidates.push({ url, score });
  }
  return [...new Map(candidates.sort((a, b) => a.score - b.score).map((item) => [item.url.href, item])).values()]
    .slice(0, MAX_PAGES - 1)
    .map((item) => item.url);
}

export async function fetchWebsitePages({
  website,
  fetchImpl = fetch,
  lookup = dnsLookup,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const rootUrl = normalizeWebsiteUrl(website);
  rootUrl.hash = "";
  const pages = [];
  const errors = [];
  const targets = [rootUrl];
  for (let index = 0; index < targets.length && index < MAX_PAGES; index += 1) {
    const target = targets[index];
    try {
      const page = await fetchHtmlPage({ url: target, rootUrl, fetchImpl, lookup, timeoutMs, maxBytes });
      page.text = htmlToText(page.html);
      pages.push(page);
      if (index === 0) targets.push(...pageCandidates(page.html, new URL(page.url)));
    } catch (fetchError) {
      errors.push({ url: target.href, error: fetchError?.message || String(fetchError) });
    }
  }
  return { pages, errors };
}

function metaContent(html, key, value) {
  for (const tag of String(html || "").match(/<meta\b[^>]*>/gi) || []) {
    const attributes = {};
    for (const match of tag.matchAll(/([:\w-]+)\s*=\s*["']([^"']*)["']/g)) {
      attributes[match[1].toLowerCase()] = decodeHtml(match[2]).trim();
    }
    if (String(attributes[key] || "").toLowerCase() === value.toLowerCase()) return attributes.content || "";
  }
  return "";
}

function evidenceAround(text, pattern, radius = 100) {
  const match = pattern.exec(text);
  pattern.lastIndex = 0;
  if (!match) return "";
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return text.slice(start, end).trim();
}

function firstMatchingCity(text) {
  const cities = [
    "Москва", "Санкт-Петербург", "Новосибирск", "Екатеринбург", "Казань", "Самара",
    "Краснодар", "Уфа", "Пермь", "Челябинск", "Тюмень", "Ростов-на-Дону",
    "Нижний Новгород", "Саратов", "Воронеж", "Красноярск", "Волгоград", "Омск",
  ];
  return cities.find((city) => new RegExp(
    `(?:^|[^А-ЯЁа-яё])${city.replace("-", "[-‑–—]")}(?=$|[^А-ЯЁа-яё])`,
    "iu",
  ).test(text)) || "";
}

function businessType(text) {
  const patterns = [
    /медицинск(?:ая|ий|ое)\s+клиник[аеиу]?/i,
    /клиник[аеиу]?/i,
    /интернет-магазин/i,
    /юридическ(?:ая|ие)\s+(?:компания|услуги)/i,
    /ресторан|кафе|отель|гостиниц[аы]|стоматологи[яи]/i,
  ];
  return patterns.map((pattern) => text.match(pattern)?.[0]).find(Boolean) || "";
}

function namedContacts(pages) {
  const contacts = [];
  const seen = new Set();
  const pattern = /((?:генеральный|коммерческий|технический)?\s*директор|руководитель|владелец|основатель)\s*[:—–-]?\s*([А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2})/g;
  for (const page of pages) {
    for (const match of page.text.matchAll(pattern)) {
      const name = match[2].trim();
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      contacts.push({
        name,
        position: match[1].trim(),
        confidence: 0.95,
        sourceUrl: page.url,
        evidence: evidenceAround(page.text, new RegExp(match[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))),
      });
    }
  }
  return contacts;
}

function alternativeEmails(pages) {
  const values = new Map();
  const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const page of pages) {
    for (const match of page.text.matchAll(emailPattern)) {
      const email = match[0].toLowerCase();
      if (!values.has(email)) values.set(email, { email, sourceUrl: page.url });
    }
  }
  return [...values.values()].sort((left, right) => left.email.localeCompare(right.email));
}

function digitalProcesses(pages) {
  const definitions = [
    ["form", /<form\b/i, true],
    ["ecommerce", /интернет-магазин|корзин[аыу]|оформить заказ|купить онлайн/i, false],
    ["booking", /бронирован(?:ие|ия|ию)|забронировать/i, false],
    ["online_appointment", /онлайн[- ]запис|записаться онлайн/i, false],
    ["catalog", /каталог/i, false],
    ["personal_account", /личн(?:ый|ого) кабинет|войти в кабинет/i, false],
  ];
  const found = [];
  for (const [type, pattern, useHtml] of definitions) {
    const page = pages.find((item) => pattern.test(useHtml ? item.html : item.text));
    pattern.lastIndex = 0;
    if (!page) continue;
    const source = useHtml ? htmlToText(page.html.replace(/<form\b/i, " форма ")) : page.text;
    found.push({ type, sourceUrl: page.url, evidence: evidenceAround(source, useHtml ? /форма/i : pattern) || source.slice(0, 200) });
  }
  return found;
}

export function extractSiteSignals(pages = []) {
  const normalized = pages.map((page) => ({
    url: String(page.url),
    html: String(page.html || ""),
    text: page.text || htmlToText(page.html),
  }));
  const combined = normalized.map((page) => page.text).join(" ");
  const first = normalized[0] || { html: "", text: "" };
  const title = decodeHtml(first.html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "")
    .replace(/\s+[—|–-]\s+.*$/, "")
    .trim();
  const canonicalCompany = metaContent(first.html, "property", "og:site_name")
    || metaContent(first.html, "name", "application-name")
    || title;
  return {
    canonicalCompany,
    businessType: businessType(combined),
    city: firstMatchingCity(combined),
    namedContacts: namedContacts(normalized),
    alternativeEmails: alternativeEmails(normalized),
    digitalProcesses: digitalProcesses(normalized),
  };
}
