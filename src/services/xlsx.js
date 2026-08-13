import path from "node:path";
import { strFromU8, unzipSync } from "fflate";

function xmlDecode(value = "") {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function xmlAttr(source = "", name) {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(source)?.[1] || "";
}

function firstTagText(source = "", tagName) {
  const match = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`).exec(source);
  return match ? xmlDecode(match[1]) : undefined;
}

function richText(source = "") {
  return [...source.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
    .map((match) => xmlDecode(match[1]))
    .join("");
}

function parseSharedStrings(xml = "") {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => richText(match[1]));
}

function columnIndex(cellRef = "") {
  const letters = String(cellRef).match(/[A-Z]+/i)?.[0] || "";
  return [...letters.toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function zipText(zip, name) {
  const entry = zip[name];
  return entry ? strFromU8(entry) : "";
}

function firstWorksheetPath(zip) {
  const workbook = zipText(zip, "xl/workbook.xml");
  const rels = zipText(zip, "xl/_rels/workbook.xml.rels");
  const firstSheetRelId = [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)]
    .map((match) => xmlAttr(match[1], "r:id"))
    .find(Boolean);
  if (!firstSheetRelId) return "xl/worksheets/sheet1.xml";

  for (const match of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (xmlAttr(match[1], "Id") !== firstSheetRelId) continue;
    const target = xmlAttr(match[1], "Target");
    if (!target) break;
    return target.startsWith("/")
      ? target.slice(1)
      : path.posix.normalize(`xl/${target}`);
  }
  return "xl/worksheets/sheet1.xml";
}

function parseCellValue(cellAttrs, cellBody = "", sharedStrings = []) {
  const type = xmlAttr(cellAttrs, "t");
  const value = firstTagText(cellBody, "v");
  if (type === "s") return sharedStrings[Number(value)] ?? "";
  if (type === "inlineStr") return richText(firstTagText(cellBody, "is") || cellBody);
  if (type === "str") return value ?? "";
  if (type === "b") return value === "1";
  if (value === undefined) return "";
  const number = Number(value);
  return Number.isFinite(number) && String(value).trim() !== "" ? number : value;
}

export function parseXlsxRowsFromXml(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const sharedStrings = parseSharedStrings(zipText(zip, "xl/sharedStrings.xml"));
  const sheetXml = zipText(zip, firstWorksheetPath(zip));
  if (!sheetXml) {
    const error = new Error("xlsx_sheet_not_found");
    error.status = 400;
    throw error;
  }

  return [...sheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
    const row = [];
    let nextIndex = 0;
    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cellMatch[1] || "";
      const explicitIndex = columnIndex(xmlAttr(attrs, "r"));
      const index = explicitIndex >= 0 ? explicitIndex : nextIndex;
      row[index] = parseCellValue(attrs, cellMatch[2] || "", sharedStrings);
      nextIndex = index + 1;
    }
    return row.map((value) => value ?? "");
  });
}
