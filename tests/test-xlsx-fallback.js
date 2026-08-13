import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { parseXlsxRowsFromXml } from "../src/services/xlsx.js";

const files = {
  "[Content_Types].xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
      <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
    </Types>`),
  "xl/workbook.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`),
  "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
    </Relationships>`),
  "xl/sharedStrings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <si><t>Почта получателя</t></si>
      <si><t>Тема письма</t></si>
      <si><t>client@example.com</t></si>
      <si><t>Тема</t></si>
    </sst>`),
  "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>
        <row r="1">
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="s"><v>1</v></c>
          <c r="C1" t="inlineStr"><is><t>Заметки</t></is></c>
        </row>
        <row r="2">
          <c r="A2" t="s"><v>2</v></c>
          <c r="B2" t="s"><v>3</v></c>
          <c r="C2" t="str"><f>IFERROR(SOME.UNKNOWN.FUNCTION(), "")</f><v></v></c>
          <c r="D2"><v>3</v></c>
        </row>
      </sheetData>
    </worksheet>`),
};

const rows = parseXlsxRowsFromXml(Buffer.from(zipSync(files)));

assert.deepEqual(rows[0], ["Почта получателя", "Тема письма", "Заметки"]);
assert.equal(rows[1][0], "client@example.com");
assert.equal(rows[1][1], "Тема");
assert.equal(rows[1][2], "");
assert.equal(rows[1][3], 3);

console.log("OK: xlsx fallback parser handles empty formula strings");
