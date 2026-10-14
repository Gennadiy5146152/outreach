import assert from "node:assert/strict";
import test from "node:test";

test("URL policy accepts public HTTP(S) and rejects private, credentialed, and non-web destinations", async () => {
  const { normalizeWebsiteUrl, assertPublicHttpUrl } = await import("../src/services/website-enrichment.js");
  assert.equal(normalizeWebsiteUrl("example.com/path").href, "https://example.com/path");
  await assert.doesNotReject(assertPublicHttpUrl(new URL("https://example.com"), {
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
  }));

  const blocked = [
    "ftp://example.com/file",
    "https://user:secret@example.com",
    "http://127.0.0.1",
    "http://10.0.0.1",
    "http://100.64.0.1",
    "http://169.254.169.254/latest/meta-data",
    "http://172.16.0.1",
    "http://192.168.1.1",
    "http://[::1]",
    "http://[fc00::1]",
    "http://[fe80::1]",
    "http://[::ffff:127.0.0.1]",
  ];
  for (const value of blocked) {
    await assert.rejects(
      assertPublicHttpUrl(normalizeWebsiteUrl(value), { lookup: async () => [] }),
      /website_url_not_public|website_protocol_not_allowed|website_credentials_not_allowed/,
      value,
    );
  }

  await assert.rejects(assertPublicHttpUrl(new URL("https://mixed.example"), {
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ],
  }), /website_url_not_public/);
});

test("website reader revalidates redirects and blocks a public-to-private hop", async () => {
  const { fetchWebsitePages } = await import("../src/services/website-enrichment.js");
  const lookup = async (hostname) => hostname === "public.example"
    ? [{ address: "93.184.216.34", family: 4 }]
    : [{ address: "127.0.0.1", family: 4 }];
  const fetchImpl = async () => new Response(null, {
    status: 302,
    headers: { location: "http://private.example/admin" },
  });

  const result = await fetchWebsitePages({ website: "https://public.example", fetchImpl, lookup });
  assert.equal(result.pages.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /website_url_not_public/);
});

test("website reader limits pages, redirects, bytes, content type, and preserves partial results", async () => {
  const { fetchWebsitePages } = await import("../src/services/website-enrichment.js");
  const calls = [];
  const responses = new Map([
    ["https://example.com/", new Response(`
      <html><head><title>Компания</title></head><body>
        <a href="/about">О компании</a><a href="/contacts">Контакты</a><a href="/fourth">Ещё</a>
      </body></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })],
    ["https://example.com/about", new Response("<html><body>О нас</body></html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["https://example.com/contacts", new Response("not html", { status: 200, headers: { "content-type": "application/pdf" } })],
  ]);
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return responses.get(String(url));
  };
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];

  const result = await fetchWebsitePages({ website: "example.com", fetchImpl, lookup });
  assert.equal(calls.length, 3);
  assert.equal(result.pages.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /website_content_type_not_html/);
  assert.equal(calls.every((call) => call.options.redirect === "manual"), true);
  assert.equal(calls.every((call) => call.options.signal instanceof AbortSignal), true);

  const oversized = await fetchWebsitePages({
    website: "https://large.example",
    lookup,
    maxBytes: 32,
    fetchImpl: async () => new Response("x".repeat(64), { headers: { "content-type": "text/html" } }),
  });
  assert.equal(oversized.pages.length, 0);
  assert.match(oversized.errors[0].error, /website_response_too_large/);

  const timedOut = await fetchWebsitePages({
    website: "https://slow.example",
    lookup,
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  assert.equal(timedOut.pages.length, 0);
  assert.equal(timedOut.errors.length, 1);
});

test("signal extraction returns evidence-backed company, contacts, emails, and digital processes", async () => {
  const { extractSiteSignals } = await import("../src/services/website-enrichment.js");
  const pages = [
    {
      url: "https://alpha.example/",
      html: `<html><head><meta property="og:site_name" content="Клиника Альфа"><title>Клиника Альфа — Москва</title></head>
        <body><h1>Клиника Альфа</h1><p>Онлайн-запись к врачу</p><form action="/request"><input name="phone"></form>
        <a href="/catalog">Каталог услуг</a><a href="/login">Личный кабинет</a></body></html>`,
    },
    {
      url: "https://alpha.example/about",
      html: `<html><body><p>Медицинская клиника в Москве.</p><p>Генеральный директор Иван Петров</p>
        <p>Связаться: info@alpha.example, director@alpha.example</p></body></html>`,
    },
    {
      url: "https://alpha.example/contacts",
      html: `<html><body><p>Бронирование времени приёма</p><p>director@alpha.example</p><p>Москва, ул. Примерная, 1</p></body></html>`,
    },
  ];

  const signals = extractSiteSignals(pages);
  assert.equal(signals.canonicalCompany, "Клиника Альфа");
  assert.match(signals.businessType, /клиник/i);
  assert.equal(signals.city, "Москва");
  assert.deepEqual(signals.alternativeEmails.map((item) => item.email), ["director@alpha.example", "info@alpha.example"]);
  assert.equal(signals.namedContacts.length, 1);
  assert.equal(signals.namedContacts[0].name, "Иван Петров");
  assert.match(signals.namedContacts[0].position, /директор/i);
  assert.equal(signals.namedContacts[0].sourceUrl, "https://alpha.example/about");
  for (const type of ["form", "online_appointment", "catalog", "personal_account", "booking"]) {
    const process = signals.digitalProcesses.find((item) => item.type === type);
    assert.ok(process, type);
    assert.ok(process.sourceUrl.startsWith("https://alpha.example/"));
    assert.ok(process.evidence.length > 0);
  }
});

test("website discovery extracts a public result for a company without a saved website", async () => {
  const { discoverCompanyWebsite } = await import("../src/services/website-enrichment.js");
  const html = `
    <a class="result__a" href="https://unrelated-shop.ru">Совсем другой магазин</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Falpha-studio.ru%2Fabout">Альфа Студия — официальный сайт</a>
    <a class="result__a" href="https://vk.com/alpha">Альфа в VK</a>
  `;
  const result = await discoverCompanyWebsite({
    company: "Альфа Студия",
    city: "Самара",
    emailDomain: "mail.ru",
    fetchImpl: async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(result, "https://alpha-studio.ru/about");
});
