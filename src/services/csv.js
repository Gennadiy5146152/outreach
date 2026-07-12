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
  const keys = header.map((item) => item.trim().toLowerCase());
  const get = (row, names) => {
    const index = names.map((name) => keys.indexOf(name)).find((item) => item >= 0);
    return index >= 0 ? row[index]?.trim() || "" : "";
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
