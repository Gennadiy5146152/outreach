import * as z from "zod/v4";

const id = z.uuid();
const values = z.record(z.string(), z.unknown()).default({});
const page = z.number().int().min(1).default(1);
const pageSize = z.number().int().min(5).max(100).default(50);
const ids = z.array(id).min(1).max(500);
const queueIds = z.array(id).min(1).max(100);
const empty = z.object({}).strict();
const confirm = z.object({ confirmation_token: z.string().min(8).max(200), confirm: z.literal(true) }).strict();
const suppressionInput = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("email"), target: z.string().email(), reason: z.string().min(1).max(500) }).strict(),
  z.object({ scope: z.literal("domain"), target: z.string().min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i), reason: z.string().min(1).max(500) }).strict(),
]);
const researchSource = z.object({
  source_key: z.string().min(1).max(100).optional(),
  url: z.string().url().max(2000),
  source_type: z.enum(["official", "conference", "publication", "profile", "video", "directory", "other"]).default("other"),
  title: z.string().max(300).optional(),
  publisher: z.string().max(200).optional(),
  published_at: z.string().max(60).optional(),
  excerpt: z.string().max(500).default(""),
  trust_tier: z.number().int().min(1).max(5).default(5),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
const researchFact = z.object({
  source_id: z.string().min(1).max(200),
  fact_type: z.string().min(1).max(80).default("other"),
  text: z.string().min(1).max(500),
  evidence: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).default(0.5),
  selected_for_copy: z.boolean().default(false),
}).strict();
const researchContact = z.object({
  source_id: z.string().min(1).max(200),
  name: z.string().max(200).default(""),
  role: z.string().max(200).default(""),
  email: z.string().email().optional(),
  email_status: z.enum(["confirmed", "needs_review", "rejected"]).default("needs_review"),
  confidence: z.number().min(0).max(1).default(0.5),
  evidence: z.string().min(1).max(500),
}).strict();

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
  definition("leads_import", "Импортировать локальный CSV в базу лидов либо CSV/XLSX в персональные черновики.", z.object({ kind: z.enum(["leads", "outreach"]).default("outreach"), file_path: z.string().min(1), mapping: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).strict(), writeAnnotations),
  definition("personalization_pilots_list", "Получить список пилотов персонализации и их счётчики.", z.object({ page, page_size: pageSize }).strict(), readAnnotations),
  definition("personalization_pilot_get", "Получить пилот персонализации, квалификацию, доказательства и черновики.", z.object({ pilot_id: id }).strict(), readAnnotations),
  definition("personalization_pilot_prepare", "Подготовить точный список до 1000 адресов для персонализации без создания пилота и без отправки писем.", z.object({ limit: z.number().int().min(1).max(1000).default(30) }).strict(), prepareAnnotations),
  definition("personalization_pilot_execute", "Создать ранее подготовленный пилот черновиков. Вызывать только после явного разрешения пользователя; письма не отправляются.", confirm, executeAnnotations),
  definition("company_research_list", "Получить очередь исследования компаний по приоритету и статусу.", z.object({ page, page_size: pageSize, status: z.enum(["queued", "researching", "review", "ready", "failed"]).optional() }).strict(), readAnnotations),
  definition("company_research_get", "Получить карточку исследования компании: источники, факты, контакты и кандидаты писем.", z.object({ run_id: id }).strict(), readAnnotations),
  definition("company_research_queue_prepare", "Подготовить точный список всех подходящих компаний для исследования без создания очереди.", z.object({ rules_version: z.string().min(1).max(100).optional() }).strict(), prepareAnnotations),
  definition("company_research_queue_execute", "Создать подтверждённую очередь исследования компаний. Письма и черновики не создаются.", confirm, executeAnnotations),
  definition("company_research_job_claim", "Взять следующую компанию для публичного исследования на ограниченное время.", z.object({ worker_id: z.string().min(1).max(200), lease_minutes: z.number().int().min(1).max(60).default(15) }).strict(), writeAnnotations),
  definition("company_research_evidence_save", "Сохранить до 10 публичных источников и связанные факты/контакты для арендованной задачи.", z.object({ run_id: id, worker_id: z.string().min(1).max(200), sources: z.array(researchSource).max(10).default([]), facts: z.array(researchFact).max(30).default([]), contacts: z.array(researchContact).max(30).default([]) }).strict(), writeAnnotations),
  definition("company_research_job_complete", "Завершить арендованное исследование; создаются только неподключённые к отправке кандидаты писем.", z.object({ run_id: id, worker_id: z.string().min(1).max(200), status: z.enum(["ready", "review", "failed"]), error: z.string().max(1000).optional() }).strict(), writeAnnotations),
  definition("company_research_retry", "Вернуть неудачное или спорное исследование в очередь.", z.object({ run_id: id }).strict(), writeAnnotations),
  definition("company_research_drafts_prepare", "Подготовить материализацию выбранных кандидатов в обычные черновики без отправки.", z.object({ draft_ids: ids }).strict(), prepareAnnotations),
  definition("company_research_drafts_execute", "Создать подтверждённые обычные черновики из кандидатов исследования. Отправка не запускается.", confirm, executeAnnotations),
  definition("drafts_list", "Получить персональные черновики.", z.object({ page, page_size: pageSize, status: z.string().max(60).optional(), import_id: id.optional() }).strict(), readAnnotations),
  definition("draft_update", "Изменить карточку черновика или follow-up шаг.", z.object({ action: z.enum(["draft", "step"]), draft_id: id, position: z.number().int().min(2).max(4).optional(), values }).strict(), writeAnnotations),
  definition("drafts_preflight", "Проверить точный набор черновиков перед запуском.", z.object({ draft_ids: ids }).strict(), readAnnotations),
  definition("draft_bulk_action_prepare", "Подготовить подтверждение массовой отмены или удаления черновиков без выполнения.", z.object({ action: z.enum(["cancel", "delete"]), draft_ids: ids }).strict(), prepareAnnotations),
  definition("draft_bulk_action_execute", "Выполнить ранее подготовленную массовую отмену или удаление. Вызывать только после явного разрешения пользователя в текущем диалоге.", confirm, executeAnnotations),
  definition("attachment_upload", "Загрузить локальный файл во вложения шага кампании или персонального черновика.", z.object({ target: z.enum(["campaign_step", "outreach_step"]), target_id: id, file_path: z.string().min(1) }).strict(), writeAnnotations),
  definition("attachment_delete_prepare", "Подготовить удаление точного вложения без выполнения.", z.object({ attachment_id: id }).strict(), prepareAnnotations),
  definition("attachment_delete_execute", "Удалить ранее подготовленное вложение. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("launch_prepare", "Выполнить preflight и подготовить точный запуск черновиков или кампании без отправки.", z.object({ source: z.enum(["drafts", "campaign"]), draft_ids: ids.optional(), campaign_id: id.optional(), mode: z.enum(["manual", "auto", "immediate"]).default("manual"), daily_first_limit: z.number().int().positive().max(10_000).optional() }).strict(), prepareAnnotations),
  definition("launch_execute", "Запустить ранее подготовленную цепочку. Вызывать только после явного разрешения пользователя в текущем диалоге.", confirm, executeAnnotations),
  definition("campaigns_list", "Получить кампании и их шаги.", empty, readAnnotations),
  definition("campaign_manage", "Создать или изменить настройки кампании или шага. Участники управляются только через campaign_enrollment_prepare/execute.", z.object({ action: z.enum(["create", "update", "add_step", "update_step"]), campaign_id: id.optional(), step_id: id.optional(), values }).strict(), writeAnnotations),
  definition("campaign_enrollment_prepare", "Подготовить добавление, массовый выбор, паузу или возобновление участников кампании без выполнения.", z.object({ action: z.enum(["enroll", "keep_selected", "pause", "resume"]), campaign_id: id, lead_ids: z.array(id).min(1).max(100).optional(), mailbox_ids: z.array(id).min(1).max(100).optional(), enrollment_ids: z.array(id).min(1).max(100).optional() }).strict(), prepareAnnotations),
  definition("campaign_enrollment_execute", "Выполнить подготовленное изменение участников. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("queue_list", "Получить ожидающие или отправленные элементы очереди.", z.object({ page, page_size: pageSize, filter: z.enum(["waiting", "sent", "all"]).default("waiting") }).strict(), readAnnotations),
  definition("queue_approval_prepare", "Подготовить подтверждение точных элементов ручной очереди.", z.object({ queue_ids: queueIds }).strict(), prepareAnnotations),
  definition("queue_approval_execute", "Подтвердить подготовленные письма в ручной очереди. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("queue_cancel_prepare", "Подготовить отмену точных элементов очереди и связанных цепочек без выполнения.", z.object({ queue_ids: queueIds }).strict(), prepareAnnotations),
  definition("queue_cancel_execute", "Выполнить подготовленную отмену очереди и связанных цепочек. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("runs_list", "Получить список запусков аутрича.", z.object({ page, page_size: pageSize }).strict(), readAnnotations),
  definition("run_get", "Получить детальный запуск и получателей.", z.object({ run_id: id }).strict(), readAnnotations),
  definition("run_control", "Подготовить или выполнить остановку запуска, его follow-up либо всей рассылки; phase=execute разрешён только после явного разрешения пользователя.", z.object({ phase: z.enum(["prepare", "execute"]), action: z.enum(["stop", "stop_all", "stop_followups", "continue_followups"]).optional(), run_id: id.optional(), lead_ids: z.array(id).min(1).max(500).optional(), confirmation_token: z.string().optional(), confirm: z.boolean().optional() }).strict(), executeAnnotations),
  definition("conversations_list", "Получить диалоги, включая очередь 'Требуют решения'.", z.object({ page, page_size: pageSize, status: z.string().max(80).optional(), classification: z.string().max(80).optional(), search: z.string().max(300).optional() }).strict(), readAnnotations),
  definition("conversation_get", "Получить полную карточку и историю диалога.", z.object({ conversation_id: id }).strict(), readAnnotations),
  definition("conversation_classify", "Изменить классификацию, которая не останавливает цепочки.", z.object({ conversation_id: id, classification: z.enum(["neutral_reply", "auto_reply", "unknown"]) }).strict(), writeAnnotations),
  definition("conversation_classify_prepare", "Подготовить классификацию, которая остановит цепочки для точного круга лидов.", z.object({ conversation_id: id, classification: z.enum(["positive_reply", "negative_reply", "unsubscribe", "not_target", "bounce"]) }).strict(), prepareAnnotations),
  definition("conversation_classify_execute", "Выполнить подготовленную останавливающую классификацию. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("conversation_action", "Подготовить или выполнить stop/continue/delay/close/assign_thread/suppress; phase=execute разрешён только после явного разрешения пользователя.", z.object({ phase: z.enum(["prepare", "execute"]), action: z.enum(["stop", "continue", "delay", "close", "assign_thread", "suppress"]), conversation_id: id.optional(), values: values.optional(), confirmation_token: z.string().optional(), confirm: z.boolean().optional() }).strict(), executeAnnotations),
  definition("reply_prepare", "Подготовить точный ручной ответ и показать последствия без отправки.", z.object({ conversation_id: id, mailbox_id: id, subject: z.string().min(1).max(998), body_text: z.string().min(1).max(200_000) }).strict(), prepareAnnotations),
  definition("reply_execute", "Отправить ранее подготовленный ручной ответ. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("suppressions_list", "Получить stop-list email и доменов.", empty, readAnnotations),
  definition("suppression_prepare", "Подготовить добавление точного email или целого домена в stop-list.", suppressionInput, prepareAnnotations),
  definition("suppression_execute", "Добавить подготовленный адрес или домен в stop-list. Вызывать только после явного разрешения пользователя.", confirm, executeAnnotations),
  definition("mailboxes_list", "Получить безопасное состояние mailbox без паролей.", empty, readAnnotations),
  definition("mailbox_check", "Проверить SMTP, IMAP и доменные записи существующего mailbox.", z.object({ mailbox_id: id }).strict(), writeAnnotations),
  definition("inbox_sync", "Запросить синхронизацию входящих писем.", empty, writeAnnotations),
  definition("delivery_mode_prepare", "Подготовить переключение dry-run/реальной отправки без изменения настроек.", z.object({ dry_run: z.boolean() }).strict(), prepareAnnotations),
  definition("delivery_mode_execute", "Выполнить подготовленное переключение режима. Включение реальной отправки разрешено только после явного подтверждения пользователя.", confirm, executeAnnotations),
];
