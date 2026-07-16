export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function rowsToObjects(rows) {
  const [header = [], ...data] = rows;
  const keys = header.map((item) => String(item || "").trim().toLowerCase());
  const get = (row, names) => {
    const index = names.map((name) => keys.indexOf(name)).find((item) => item >= 0);
    return index >= 0 ? String(row[index] || "").trim() : "";
  };

  return data.map((row) => ({
    company: get(row, ["company", "компания", "name", "название"]),
    contact_name: get(row, ["contact", "контакт", "person", "имя"]),
    position: get(row, ["position", "должность"]),
    email: get(row, ["email", "почта", "e-mail"]),
    website: get(row, ["website", "site", "сайт"]),
    segment: get(row, ["segment", "сегмент", "industry", "ниша"]),
    city: get(row, ["city", "город"]),
    pain: get(row, ["pain", "боль", "trigger", "триггер"]),
    notes: get(row, ["notes", "заметки", "comment"]),
    source: get(row, ["source", "источник"]),
  }));
}

export const OUTREACH_COLUMN_ALIASES = {
  company: ["company", "компания", "name", "название"],
  contact_name: ["contact", "контакт", "person", "имя", "contact_name"],
  position: ["position", "должность"],
  email: ["email", "почта", "e-mail"],
  website: ["website", "site", "сайт"],
  segment: ["segment", "сегмент", "industry", "ниша"],
  city: ["city", "город"],
  pain: ["pain", "боль", "trigger", "триггер"],
  notes: ["notes", "заметки", "comment"],
  source: ["source", "источник"],
  mailbox: ["mailbox", "ящик", "почта отправителя", "sender_email"],
  subject: ["subject", "тема", "тема письма"],
  body: ["body", "text", "текст", "тело письма", "письмо"],
  send_after: ["send_after", "send at", "отправить после", "дата отправки"],
  followup_1_subject: ["followup_1_subject", "follow-up 1 subject", "фоллоуап 1 тема"],
  followup_1_body: ["followup_1_body", "follow-up 1 body", "фоллоуап 1 текст"],
  followup_1_delay_days: ["followup_1_delay_days", "follow-up 1 delay", "фоллоуап 1 задержка"],
  followup_2_subject: ["followup_2_subject", "follow-up 2 subject", "фоллоуап 2 тема"],
  followup_2_body: ["followup_2_body", "follow-up 2 body", "фоллоуап 2 текст"],
  followup_2_delay_days: ["followup_2_delay_days", "follow-up 2 delay", "фоллоуап 2 задержка"],
  followup_3_subject: ["followup_3_subject", "follow-up 3 subject", "фоллоуап 3 тема"],
  followup_3_body: ["followup_3_body", "follow-up 3 body", "фоллоуап 3 текст"],
  followup_3_delay_days: ["followup_3_delay_days", "follow-up 3 delay", "фоллоуап 3 задержка"],
};

function cellText(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value || "").trim();
}

export function inferOutreachMapping(rows) {
  const [header = []] = rows;
  const keys = header.map((item) => cellText(item).toLowerCase());
  return Object.fromEntries(Object.entries(OUTREACH_COLUMN_ALIASES).map(([field, aliases]) => {
    const index = aliases.map((name) => keys.indexOf(name)).find((item) => item >= 0);
    return [field, index >= 0 ? index : ""];
  }));
}

export function rowsToOutreachRows(rows, mapping = {}) {
  const [header = [], ...data] = rows;
  const keys = header.map((item) => String(item || "").trim().toLowerCase());
  const get = (row, field) => {
    const mappedIndex = mapping[field] === "" || mapping[field] === undefined ? NaN : Number(mapping[field]);
    const index = Number.isInteger(mappedIndex) && mappedIndex >= 0
      ? mappedIndex
      : OUTREACH_COLUMN_ALIASES[field].map((name) => keys.indexOf(name)).find((item) => item >= 0);
    if (index < 0) return "";
    return cellText(row[index]);
  };

  return data
    .map((row, index) => ({
      source_row_number: index + 2,
      company: get(row, "company"),
      contact_name: get(row, "contact_name"),
      position: get(row, "position"),
      email: get(row, "email"),
      website: get(row, "website"),
      segment: get(row, "segment"),
      city: get(row, "city"),
      pain: get(row, "pain"),
      notes: get(row, "notes"),
      source: get(row, "source"),
      mailbox: get(row, "mailbox"),
      subject: get(row, "subject"),
      body: get(row, "body"),
      send_after: get(row, "send_after"),
      followup_1_subject: get(row, "followup_1_subject"),
      followup_1_body: get(row, "followup_1_body"),
      followup_1_delay_days: get(row, "followup_1_delay_days"),
      followup_2_subject: get(row, "followup_2_subject"),
      followup_2_body: get(row, "followup_2_body"),
      followup_2_delay_days: get(row, "followup_2_delay_days"),
      followup_3_subject: get(row, "followup_3_subject"),
      followup_3_body: get(row, "followup_3_body"),
      followup_3_delay_days: get(row, "followup_3_delay_days"),
    }))
    .filter((row) => Object.entries(row)
      .some(([key, value]) => key !== "source_row_number" && String(value || "").trim()));
}
