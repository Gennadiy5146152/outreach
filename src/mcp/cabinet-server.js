import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { safeTool, toolSuccess } from "./result.js";

export function createCabinetMcpServer({ client, scopes = [], allCampaigns = false }) {
  const server = new McpServer(
    { name: "outreach-private-cabinet", version: "1.0.0" },
    {
      instructions:
        "Work only inside the token owner's cabinet. cabinet_access reports all_campaigns: true for access to all current and future campaigns of this owner; otherwise use only the listed campaign_ids. Action scopes still apply independently. Before delivery or stopping, call prepare, show the full returned plan and ask for explicit human approval. Execute only after that approval. No Telegram sessions, QR authentication, contacts, arbitrary chats or general history are accessible.",
    },
  );
  const id = z.uuid(),
    campaign = z.object({ campaign_id: id }).strict();
  const register = (
    name,
    description,
    inputSchema,
    scope,
    readOnlyHint,
    handler,
  ) => {
    if (scope && !scopes.includes(scope)) return;
    server.registerTool(
      name,
      {
        description,
        inputSchema,
        annotations: {
          readOnlyHint,
          destructiveHint: name.endsWith("_execute"),
          openWorldHint: false,
        },
      },
      safeTool(async (input) => toolSuccess(description, await handler(input))),
    );
  };
  register(
    "cabinet_access",
    "Показать права этого токена без секретов.",
    z.object({}).strict(),
    null,
    true,
    () => client.get("/api/cabinet/mcp/context"),
  );
  register(
    "instagram_connections_list",
    "Показать подключённые Instagram-профили и срок доступа. Без токенов Instagram, входа, переписки и отправки.",
    z.object({}).strict(),
    "instagram:read",
    true,
    () => client.get("/api/cabinet/instagram"),
  );
  register(
    "campaigns_list",
    "Получить только разрешённые этому токену рассылки.",
    z.object({}).strict(),
    "outreach:read",
    true,
    () => client.get("/api/cabinet/campaigns"),
  );
  if (allCampaigns === true) {
    register(
      "campaign_connections_list",
      "Показать только ID, имя и статус собственных Telegram-профилей для создания рассылки. Без QR, сессий, переписки и управления подключением.",
      z.object({}).strict(),
      "outreach:draft",
      true,
      () => client.get("/api/cabinet/campaign-connections"),
    );
    register(
      "campaign_create",
      "Создать пустую рассылку на паузе в кабинете владельца токена. Нужны право на черновики и доступ ко всем рассылкам. Сообщения и очередь не создаются.",
      z.object({
        connection_id: id,
        name: z.string().trim().min(1).max(200),
        daily_limit: z.number().int().min(1).max(100).default(10),
        window_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("09:30"),
        window_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default("11:30"),
      }).strict(),
      "outreach:draft",
      false,
      input => client.post("/api/cabinet/campaigns", input),
    );
  }
  register(
    "drafts_list",
    "Прочитать черновики выбранной разрешённой рассылки.",
    campaign
      .extend({ page: z.number().int().min(1).max(10000).default(1) })
      .strict(),
    "outreach:read",
    true,
    ({ campaign_id, page }) =>
      client.get(`/api/cabinet/campaigns/${campaign_id}/drafts`, {
        query: { page },
      }),
  );
  register(
    "draft_create",
    "Сохранить черновик без отправки. Право на редактирование должно быть выдано отдельно.",
    campaign
      .extend({
        address: z.string().min(4).max(100),
        recipient_id: z.string().regex(/^[1-9]\d{0,18}$/),
        name: z.string().max(200).default(""),
        body: z.string().min(1).max(4000),
        source_url: z.url().optional(),
        permission_kind: z.enum(["request", "consent"]).optional(),
        permission_evidence: z.string().max(1000).optional(),
      })
      .strict(),
    "outreach:draft",
    false,
    ({ campaign_id, ...body }) =>
      client.post(`/api/cabinet/campaigns/${campaign_id}/drafts`, body),
  );
  register(
    "draft_update",
    "Изменить только текст неотправленного черновика.",
    campaign
      .extend({ draft_id: id, body: z.string().min(1).max(4000) })
      .strict(),
    "outreach:draft",
    false,
    ({ campaign_id, draft_id, body }) =>
      client.patch(`/api/cabinet/campaigns/${campaign_id}/drafts/${draft_id}`, {
        body,
      }),
  );
  register(
    "queue_list",
    "Прочитать очередь только выбранной разрешённой рассылки.",
    campaign
      .extend({ page: z.number().int().min(1).max(10000).default(1) })
      .strict(),
    "outreach:read",
    true,
    ({ campaign_id, page }) =>
      client.get(`/api/cabinet/campaigns/${campaign_id}/queue`, {
        query: { page },
      }),
  );
  register(
    "outreach_thread_get",
    "Прочитать исходящее сообщение сервиса и только привязанные к нему ответы. Общая история чата недоступна.",
    campaign.extend({ job_id: id }).strict(),
    "outreach:read",
    true,
    ({ campaign_id, job_id }) =>
      client.get(`/api/cabinet/campaigns/${campaign_id}/threads/${job_id}`),
  );
  for (const kind of ["launch", "stop"]) {
    const scope = kind === "launch" ? "outreach:send" : "outreach:stop";
    register(
      `telegram_${kind}_prepare`,
      kind === "launch"
        ? "Подготовить точные сообщения и расписание. Покажите план и запросите явное разрешение; подготовка не отправляет."
        : "Подготовить остановку указанных сообщений. Покажите план и запросите явное разрешение.",
      campaign.extend({ draft_ids: z.array(id).min(1).max(500) }).strict(),
      scope,
      false,
      ({ campaign_id, draft_ids }) =>
        client.post(`/api/cabinet/campaigns/${campaign_id}/${kind}/prepare`, {
          draft_ids,
        }),
    );
    register(
      `telegram_${kind}_execute`,
      "Выполнить подготовленный план только после явного одобрения человеком.",
      z
        .object({
          confirmation_token: z.string().min(20).max(200),
          confirm: z.literal(true),
        })
        .strict(),
      scope,
      false,
      (body) => client.post("/api/cabinet/execute", { ...body, kind }),
    );
  }
  return server;
}
