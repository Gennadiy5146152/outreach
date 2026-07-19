import { env } from "../config/env.js";

let iamTokenCache = {
  token: null,
  expiresAtMs: 0,
};

export function getYandexGptMissingConfigMessage() {
  return (
    "Yandex GPT не настроен. Укажите YANDEX_FOLDER_ID и один из токенов: " +
    "YANDEX_IAM_TOKEN или YANDEX_PASSPORT_AUTH_TOKEN."
  );
}

export function isYandexGptConfigured() {
  return Boolean(env.yandexGptMock || (env.yandexFolderId && (env.yandexIamToken || env.yandexPassportAuthToken)));
}

async function exchangePassportTokenForIam(oauthToken) {
  const response = await fetch("https://iam.api.cloud.yandex.net/iam/v1/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ yandexPassportOauthToken: String(oauthToken || "") }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Yandex IAM: ${response.status} ${text}`.trim());
  }

  const result = await response.json().catch(() => ({}));
  if (!result.iamToken) throw new Error("Yandex IAM: токен не получен");
  return String(result.iamToken);
}

export async function resolveYandexIamToken() {
  if (env.yandexIamToken) return { iamToken: env.yandexIamToken, source: "env" };
  if (!env.yandexPassportAuthToken) return { iamToken: "", source: "missing" };

  if (iamTokenCache.token && Date.now() < iamTokenCache.expiresAtMs) {
    return { iamToken: iamTokenCache.token, source: "cache" };
  }

  const token = await exchangePassportTokenForIam(env.yandexPassportAuthToken);
  iamTokenCache = {
    token,
    expiresAtMs: Date.now() + 11 * 60 * 60 * 1000,
  };
  return { iamToken: token, source: "oauth_exchange" };
}

function extractUsage(result) {
  const usage = result?.result?.usage || result?.usage;
  if (!usage || typeof usage !== "object") return null;
  const numberOrNull = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : null;
  };
  return {
    inputTextTokens: numberOrNull(usage.inputTextTokens ?? usage.inputTokens ?? usage.promptTokens),
    completionTokens: numberOrNull(usage.completionTokens ?? usage.outputTokens),
    totalTokens: numberOrNull(usage.totalTokens),
  };
}

function extractText(result) {
  return (
    result?.result?.alternatives?.[0]?.message?.text ||
    result?.alternatives?.[0]?.message?.text ||
    result?.result?.alternatives?.[0]?.text ||
    result?.alternatives?.[0]?.text ||
    result?.text ||
    ""
  );
}

export async function callYandexGpt({
  prompt,
  maxTokens = 512,
  model = env.yandexGptModel,
  temperature = 0.1,
} = {}) {
  if (env.yandexGptMock) {
    return {
      text: JSON.stringify({
        classification: "positive_reply",
        confidence: 0.91,
        reason: "mock: получатель заинтересован",
      }),
      model: "mock",
      usage: null,
    };
  }

  if (!isYandexGptConfigured()) {
    throw new Error(getYandexGptMissingConfigMessage());
  }

  const { iamToken } = await resolveYandexIamToken();
  if (!iamToken) throw new Error(getYandexGptMissingConfigMessage());

  const response = await fetch(
    "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${iamToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        modelUri: `gpt://${env.yandexFolderId}/${model || "yandexgpt-lite"}`,
        completionOptions: {
          stream: false,
          temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
          maxTokens: Math.max(1, Math.floor(Number(maxTokens) || 512)),
        },
        messages: [{ role: "user", text: String(prompt || "") }],
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Yandex GPT: ${response.status} ${text}`.trim());
  }

  const result = await response.json().catch(() => ({}));
  const text = extractText(result);
  if (!text && result?.error) throw new Error(result.error.message || JSON.stringify(result.error));
  if (!text) throw new Error("Yandex GPT: пустой ответ модели");

  return {
    text: String(text).trim(),
    model: String(model || "yandexgpt-lite"),
    usage: extractUsage(result),
  };
}
