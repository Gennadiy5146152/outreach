import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { safeTool, toolSuccess } from "./result.js";

export function createCabinetMcpServer({ client, scopes = [], allCampaigns = false }) {
  const server = new McpServer(
    { name: "outreach-private-cabinet", version: "1.0.0" },
    {
      instructions:
        "Work only inside the token owner's cabinet. cabinet_access reports all_campaigns: true for access to all current and future campaigns of this owner; otherwise use only the listed campaign_ids. Action scopes still apply independently. Before delivery, stopping or editing queued messages, call prepare, show the full returned plan and ask for explicit human approval. Execute only after that approval. No Telegram sessions, QR authentication, contacts, arbitrary chats or general history are accessible.",
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
      "campaign_window_update",
      "Изменить только окно пустой очереди рассылки на паузе. Лимит и пауза сохраняются, отправка не запускается. Нужны черновики и доступ ко всем рассылкам.",
      campaign.extend({
        window_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        window_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }).strict(),
      "outreach:draft", false,
      ({ campaign_id, ...body }) => client.patch(`/api/cabinet/campaigns/${campaign_id}/window`, body),
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
    "Сохранить черновик без отправки: address и recipient_id либо recipient_source и recipient_id без address. Источник неизменяемый; точное авторство Telegram проверит перед отправкой. Право на редактирование должно быть выдано отдельно.",
    campaign
      .extend({
        address: z.string().min(4).max(100).optional(),
        recipient_source: z.object({
          chat_id: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n),
          username: z.string().regex(/^[a-z][a-z0-9_]{4,31}$/),
          message_id: z.number().int().min(1).max(2147483647),
        }).strict().optional(),
        recipient_id: z.string().regex(/^[1-9]\d{0,18}$/),
        name: z.string().max(200).default(""),
        body: z.string().min(1).max(4000),
        source_url: z.url().optional(),
        permission_kind: z.enum(["request", "consent"]).optional(),
        permission_evidence: z.string().max(1000).optional(),
      })
      .strict().refine(input => (input.address !== undefined) !== (input.recipient_source !== undefined)),
    "outreach:draft",
    false,
    ({ campaign_id, ...body }) =>
      client.post(`/api/cabinet/campaigns/${campaign_id}/drafts`, body),
  );
  register(
    "draft_update",
    "Изменить текст или подтверждённое основание обращения неотправленного черновика. Вид основания и доказательство указываются вместе. Получатель неизменен; отправка не запускается.",
    campaign.extend({
      draft_id: id,
      body: z.string().min(1).max(4000).optional(),
      source_url: z.url().startsWith("https://").max(2000).optional(),
      permission_kind: z.enum(["request", "consent"]).optional(),
      permission_evidence: z.string().trim().min(3).max(1000).optional(),
    }).strict().refine(input => (input.permission_kind !== undefined) === (input.permission_evidence !== undefined))
      .refine(input => [input.body, input.source_url, input.permission_kind].some(v => v !== undefined)),
    "outreach:draft",
    false,
    ({ campaign_id, draft_id, ...body }) =>
      client.patch(`/api/cabinet/campaigns/${campaign_id}/drafts/${draft_id}`, body),
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
    "Прочитать сообщение рассылки и сохранённую переписку с этим получателем после отправки, включая обычные ответы без цитирования. История до рассылки и посторонние диалоги недоступны.",
    campaign.extend({ job_id: id, page:z.number().int().min(1).max(10000).default(1) }).strict(),
    "outreach:read",
    true,
    ({ campaign_id, job_id, page }) =>
      client.get(`/api/cabinet/campaigns/${campaign_id}/threads/${job_id}`,{query:{page}}),
  );
  const statsFilters={from:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),to:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),group_username:z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/).optional()};
  register('campaign_stats_get','Статистика уникальных получателей по дате первого подтверждённого обращения в Москве. Поздние ответы обновляют исходную группу отправки. Не меняет сообщения.',campaign.extend(statsFilters).strict(),'outreach:read',true,
    ({campaign_id,...query})=>client.get(`/api/cabinet/campaigns/${campaign_id}/stats`,{query}));
  register('campaign_response_stats_get','Полная аналитика скорости ответа: Артём и первый ответ клиента отдельно, elapsed/working, median/p90, ожидающие, аномалии, дни/группы и пагинированные эпизоды с точными временами и обоими длительностями. Даты фильтруют начало эпизода по Москве, не когорту рассылки. Рабочее время пересчитывается по текущему настраиваемому календарю; pending не означает обязательный ответ или ноль секунд.',campaign.extend({...statsFilters,mode:z.enum(['elapsed','working']).default('elapsed'),side:z.enum(['artem','client']).default('artem'),status:z.enum(['all','answered','pending','anomaly']).default('all'),page:z.number().int().min(1).max(10000).default(1),page_size:z.number().int().min(1).max(100).default(20)}).strict(),'outreach:read',true,
    ({campaign_id,...query})=>client.get(`/api/cabinet/campaigns/${campaign_id}/response-analytics`,{query}));
  register('campaign_response_schedule_get','Прочитать рабочие дни/часы, timezone и revision календаря аналитики. Календарь настраивается владельцем в кабинете отдельно от окна рассылки; этот инструмент только читает.',campaign.strict(),'outreach:read',true,
    ({campaign_id})=>client.get(`/api/cabinet/campaigns/${campaign_id}/response-schedule`));
  register('outreach_media_list','Пагинированный список сохранённых аудио/голосовых/видео/кружочков только отслеживаемой рассылки: вид, размеры, длительность, статус загрузки и защищённый URL готового файла. URL требует авторизации кабинета; filesystem/session paths не выдаются. Ошибка/ожидание не означает успешный архив. Никакой отправки или произвольной истории.',campaign.extend({job_id:id.optional(),page:z.number().int().min(1).max(10000).default(1),page_size:z.number().int().min(1).max(100).default(50)}).strict(),'outreach:read',true,
    ({campaign_id,...query})=>client.get(`/api/cabinet/campaigns/${campaign_id}/media`,{query}));
  register('outreach_reviews_list','Получить только диалоги рассылки для оценки результата, их snapshot и список job_ids. pending_only выбирает новые/изменившиеся оценки агента; ручные решения защищены. Перед оценкой прочитайте всю переписку всех job_ids, страницами по 500 сообщений.',campaign.extend({...statsFilters,page:z.number().int().min(1).max(10000).default(1),page_size:z.number().int().min(1).max(100).default(50),pending_only:z.boolean().default(true)}).strict(),'outreach:read',true,
    ({campaign_id,...query})=>client.get(`/api/cabinet/campaigns/${campaign_id}/reviews`,{query}));
  register('outreach_followups_list','Прочитать отложенные обращения за всё время рассылки. Дату повторного разбора назначает только владелец вручную в кабинете; отсутствие даты не исключает контакт. due определяется по календарному дню Москвы. Список включает старую оценку later, если после неё появились сообщения: перед повторной обработкой прочитайте полную актуальную переписку. Не отправляет сообщения и не назначает даты.',campaign.extend({view:z.enum(['all','undated','due','upcoming']).default('all'),page:z.number().int().min(1).max(10000).default(1),page_size:z.number().int().min(1).max(100).default(50)}).strict(),'outreach:read',true,
    ({campaign_id,...query})=>client.get(`/api/cabinet/campaigns/${campaign_id}/followups`,{query}));
  if(scopes.includes('outreach:read')&&scopes.includes('outreach:draft'))register('outreach_outcome_update','Сохранить оценку результата по актуальному snapshot и точным message ID этой переписки. Просьба о цене означает interested, не booked. Запись требует явного подтверждения и доказательств обеих сторон. Меняет только статистику, не отправляет и не останавливает сообщения.',campaign.extend({job_id:id,status:z.enum(['interested','later','declined','not_target','needs_review','booked']),reason:z.string().trim().min(3).max(1000),expected_snapshot:z.string().regex(/^[a-f0-9]{32}$/),evidence_message_ids:z.array(z.string().regex(/^[1-9]\d{0,18}$/)).min(1).max(20)}).strict(),'outreach:draft',false,
    ({campaign_id,job_id,...body})=>client.patch(`/api/cabinet/campaigns/${campaign_id}/reviews/${job_id}`,body));
  if (scopes.includes("outreach:send") && scopes.includes("outreach:draft")) {
    register(
      "telegram_queue_edit_prepare",
      "Подготовить замену только текста queued-сообщений и их черновиков. Покажите полный старый и новый текст с получателями, отправителем и временем и запросите явное одобрение. Подготовка сохраняет план; очередь, расписание, пауза и отправка не меняются.",
      campaign.extend({
        items: z.array(z.object({
          job_id: id,
          body: z.string().min(1).max(4000).refine(value => value.trim().length > 0),
        }).strict()).min(1).max(100).refine(items => new Set(items.map(i => i.job_id.toLowerCase())).size === items.length),
      }).strict(),
      null, false,
      ({campaign_id, items}) => client.post(`/api/cabinet/campaigns/${campaign_id}/queue-edit/prepare`, {items}),
    );
    register(
      "telegram_queue_edit_execute",
      "Применить подтверждённую замену текста только после явного одобрения человеком. Изменившаяся очередь отклоняет весь план. Не запускает отправку и не меняет расписание или паузу.",
      z.object({confirmation_token: z.string().min(20).max(200), confirm: z.literal(true)}).strict(),
      null, false,
      input => client.post("/api/cabinet/queue-edit/execute", input),
    );
  }
  if (allCampaigns === true && scopes.includes("outreach:send") && scopes.includes("outreach:draft")) {
    register(
      "telegram_one_off_prepare",
      "Подготовить разовый запуск максимум двух сохранённых сообщений сегодня по Москве. campaign_window_end явно предлагает новое постоянное окончание окна; начало окна сохраняется. Без daily_limit разовый потолок не выше обычного лимита плюс два (до 100); daily_limit явно предлагает новый постоянный лимит и тот же разовый потолок. Покажите полный план, получателей, тексты, время и ограничения, затем запросите явное одобрение. Подготовка только сохраняет план.",
      campaign.extend({
        draft_ids: z.array(id).min(1).max(2).refine(ids => new Set(ids.map(value => value.toLowerCase())).size === ids.length),
        daily_limit: z.number().int().min(1).max(100).optional(),
        campaign_window_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        window_start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        window_end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }).strict().refine(input => input.window_end > input.window_start),
      null, false,
      ({campaign_id, ...body}) => client.post(`/api/cabinet/campaigns/${campaign_id}/one-off/prepare`, body),
    );
    register(
      "telegram_one_off_execute",
      "Выполнить точный разовый план только после явного одобрения человеком. План действует только сегодня и в согласованном окне; изменения состояния отклоняют запуск. Начало постоянного окна сохраняется; только явно предложенные в плане постоянные лимит и окончание окна меняются.",
      z.object({confirmation_token: z.string().min(20).max(200), confirm: z.literal(true)}).strict(),
      null, false,
      input => client.post("/api/cabinet/one-off/execute", input),
    );
  }
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
