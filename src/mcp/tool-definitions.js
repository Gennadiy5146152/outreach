import * as z from "zod/v4";

const id = z.string().min(1).max(100);
const values = z.record(z.string(), z.unknown()).default({});
const page = z.number().int().min(1).default(1);
const pageSize = z.number().int().min(5).max(100).default(50);
const ids = z.array(id).min(1).max(500);
const empty = z.object({}).strict();
const confirm = z.object({ confirmation_token: z.string().min(8).max(200), confirm: z.literal(true) }).strict();

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const writeAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const prepareAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const executeAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

function definition(name, description, inputSchema, annotations) {
  return { name, description, inputSchema, annotations };
}

export const TOOL_DEFINITIONS = [
  definition("outreach_status", "Проверить доступность Outreach Desk, dry-run и безопасные runtime-настройки.", empty, readAnnotations),
  definition("outreach_dashboard", "Получить сводные метрики аутрича.", empty, readAnnotations),
  definition("events_list", "Получить журнал событий с ограниченной пагинацией.", z.object({ page, page_size: pageSize }).strict(), readAnnotations),
  definition("leads_list", "Найти лидов по фильтрам.", z.object({ page, page_size: pageSize, status: z.string().max(60).optional(), segment: z.string().max(200).optional(), search: z.string().max(300).optional() }).strict(), readAnnotations),
  definition("lead_upsert", "Создать лида или обновить существующего по lead_id.", z.object({ lead_id: id.optional(), lead: values }).strict(), writeAnnotations),
  definition("leads_import", "Импортировать локальный CSV/XLSX в базу лидов или персональные черновики.", z.object({ kind: z.enum(["leads", "outreach"]).default("outreach"), file_path: z.string().min(1), mapping: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).strict(), writeAnnotations),
  definition("drafts_list", "Получить персональные черновики.", z.object({ page, page_size: pageSize, status: z.string().max(60).optional(), import_id: id.optional() }).strict(), readAnnotations),
  definition("draft_update", "Изменить карточку черновика или follow-up шаг.", z.object({ action: z.enum(["draft", "step"]), draft_id: id, position: z.number().int().min(2).max(4).optional(), values }).strict(), writeAnnotations),
  definition("drafts_preflight", "Проверить точный набор черновиков перед запуском.", z.object({ draft_ids: ids }).strict(), readAnnotations),
  definition("draft_bulk_action_prepare", "Подготовить подтверждение массовой отмены или удаления черновиков без выполнения.", z.object({ action: z.enum(["cancel", "delete"]), draft_ids: ids }).strict(), prepareAnnotations),
  definition("draft_bulk_action_execute", "Выполнить ранее подготовленную массовую отмену или удаление. Вызывать только после явного разрешения пользователя в текущем диалоге.", confirm, executeAnnotations),
  definition("attachment_upload", "Загрузить локальный файл во вложения шага кампании или персонального черновика.", z.object({ target: z.enum(["campaign_step", "outreach_step"]), target_id: id, file_path: z.string().min(1) }).strict(), writeAnnotations),
  definition("attachment_delete_prepare", "Подготовить удаление точного вложения без выполнения.", z.object({ attachment_id: id }).strict(), prepareAnnotations),
  definition("attachment_delete_execute", "Удалить ранее подготовленное вложение. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("launch_prepare", "Выполнить preflight и подготовить точный запуск черновиков или кампании без отправки.", z.object({ source: z.enum(["drafts", "campaign"]), draft_ids: ids.optional(), campaign_id: id.optional(), mode: z.enum(["manual", "auto"]).default("manual"), daily_first_limit: z.number().int().positive().max(10_000).optional() }).strict(), prepareAnnotations),
  definition("launch_execute", "Запустить ранее подготовленную цепочку. Вызывать только после явного разрешения пользователя в текущем диалоге.", confirm, executeAnnotations),
  definition("campaigns_list", "Получить кампании и их шаги.", empty, readAnnotations),
  definition("campaign_manage", "Создать или изменить кампанию, шаг либо участие лида.", z.object({ action: z.enum(["create", "update", "add_step", "update_step", "enroll", "keep_selected", "pause_enrollment", "resume_enrollment"]), campaign_id: id.optional(), step_id: id.optional(), enrollment_id: id.optional(), values }).strict(), writeAnnotations),
  definition("queue_list", "Получить ожидающие или отправленные элементы очереди.", z.object({ page, page_size: pageSize, filter: z.enum(["waiting", "sent", "all"]).default("waiting") }).strict(), readAnnotations),
  definition("queue_approval_prepare", "Подготовить подтверждение точных элементов ручной очереди.", z.object({ queue_ids: ids }).strict(), prepareAnnotations),
  definition("queue_approval_execute", "Подтвердить подготовленные письма в ручной очереди. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("queue_cancel", "Отменить один точный элемент очереди и связанную цепочку, если это предусмотрено приложением.", z.object({ queue_id: id }).strict(), writeAnnotations),
  definition("runs_list", "Получить список запусков аутрича.", z.object({ page, page_size: pageSize }).strict(), readAnnotations),
  definition("run_get", "Получить детальный запуск и получателей.", z.object({ run_id: id }).strict(), readAnnotations),
  definition("run_control", "Подготовить или выполнить остановку/продолжение follow-up запуска; execute требует явного разрешения.", z.object({ phase: z.enum(["prepare", "execute"]), action: z.enum(["stop", "stop_followups", "continue_followups"]).optional(), run_id: id.optional(), confirmation_token: z.string().optional(), confirm: z.boolean().optional() }).strict(), prepareAnnotations),
  definition("conversations_list", "Получить диалоги, включая очередь 'Требуют решения'.", z.object({ page, page_size: pageSize, status: z.string().max(80).optional(), classification: z.string().max(80).optional(), search: z.string().max(300).optional() }).strict(), readAnnotations),
  definition("conversation_get", "Получить полную карточку и историю диалога.", z.object({ conversation_id: id }).strict(), readAnnotations),
  definition("conversation_classify", "Изменить классификацию ответа в диалоге.", z.object({ conversation_id: id, classification: z.string().min(1).max(80) }).strict(), writeAnnotations),
  definition("conversation_action", "Подготовить или выполнить stop/continue/delay/close/assign_thread/suppress; высокорисковый execute требует явного разрешения.", z.object({ phase: z.enum(["prepare", "execute"]), action: z.enum(["stop", "continue", "delay", "close", "assign_thread", "suppress"]), conversation_id: id.optional(), values: values.optional(), confirmation_token: z.string().optional(), confirm: z.boolean().optional() }).strict(), prepareAnnotations),
  definition("reply_prepare", "Подготовить точный ручной ответ и показать последствия без отправки.", z.object({ conversation_id: id, subject: z.string().min(1).max(998), body_text: z.string().min(1).max(200_000), body_html: z.string().max(500_000).optional() }).strict(), prepareAnnotations),
  definition("reply_execute", "Отправить ранее подготовленный ручной ответ. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("suppressions_list", "Получить stop-list email и доменов.", empty, readAnnotations),
  definition("suppression_prepare", "Подготовить добавление email или домена в stop-list.", z.object({ email: z.string().email().optional(), domain: z.string().min(1).max(253).optional(), reason: z.string().min(1).max(500) }).strict(), prepareAnnotations),
  definition("suppression_execute", "Добавить подготовленный адрес или домен в stop-list. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("mailboxes_list", "Получить безопасное состояние mailbox без паролей.", empty, readAnnotations),
  definition("mailbox_check", "Проверить SMTP, IMAP и доменные записи существующего mailbox.", z.object({ mailbox_id: id }).strict(), writeAnnotations),
  definition("inbox_sync", "Запросить синхронизацию входящих писем.", empty, writeAnnotations),
  definition("delivery_mode_prepare", "Подготовить переключение dry-run/реальной отправки без изменения настроек.", z.object({ dry_run: z.boolean() }).strict(), prepareAnnotations),
  definition("delivery_mode_execute", "Выполнить подготовленное переключение режима. Включение реальной отправки разрешено только после явного подтверждения пользователя.", confirm, executeAnnotations),
];
