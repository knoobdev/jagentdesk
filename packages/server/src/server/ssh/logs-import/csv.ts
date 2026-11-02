import type { SshImportIssue } from "@jagentdesk/protocol/ssh/logs-import-schemas";
import type { ParsedServerDrafts, ServerDraftBase } from "./ssh-config.js";

// CSV import (spec 25.9) with the template header `label,address,port,username,group,tags`.
// Columns are matched by header name, so order is free and only `address` is
// required. `group` nests with "/" ("Prod/Web"); `tags` separates with ";" or ",".

export const CSV_TEMPLATE_HEADER = "label,address,port,username,group,tags";

const COLUMNS = ["label", "address", "port", "username", "group", "tags"] as const;
type Column = (typeof COLUMNS)[number];

interface CsvRecord {
  line: number; // 1-based line where the record starts
  fields: string[];
}

/** RFC 4180 records: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsvRecords(text: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let fieldStarted = false;
  const endRecord = () => {
    fields.push(field);
    if (fields.length > 1 || fields[0] !== "") records.push({ line: recordLine, fields });
    fields = [];
    field = "";
    fieldStarted = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"' && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (char === ",") {
      fields.push(field);
      field = "";
      fieldStarted = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      endRecord();
      line += 1;
      recordLine = line;
    } else {
      field += char;
      fieldStarted = true;
    }
  }
  if (field !== "" || fields.length > 0) endRecord();
  return records;
}

function rowIssue(file: string, line: number, message: string): SshImportIssue {
  return { location: { file, line }, severity: "error", code: "invalid_row", message };
}

export function parseServersCsv(text: string, file: string): ParsedServerDrafts {
  const records = parseCsvRecords(text.replace(/^﻿/, ""));
  const issues: SshImportIssue[] = [];
  const header = records[0];
  if (!header) return { servers: [], issues };
  const positions = new Map<Column, number>();
  header.fields.forEach((name, index) => {
    const column = COLUMNS.find((candidate) => candidate === name.trim().toLowerCase());
    if (column) positions.set(column, index);
  });
  if (!positions.has("address")) {
    issues.push(
      rowIssue(file, header.line, `The first row must be the header ${CSV_TEMPLATE_HEADER}`),
    );
    return { servers: [], issues };
  }
  const servers: ServerDraftBase[] = [];
  for (const record of records.slice(1)) {
    const value = (column: Column) => {
      const position = positions.get(column);
      return position === undefined ? "" : (record.fields[position] ?? "").trim();
    };
    const address = value("address");
    if (address === "") {
      issues.push(rowIssue(file, record.line, "Address is empty"));
      continue;
    }
    const portText = value("port");
    const port = portText === "" ? undefined : Number(portText);
    if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) {
      issues.push(
        rowIssue(file, record.line, `Port "${portText}" must be a number from 1 to 65535`),
      );
      continue;
    }
    const label = value("label") || address;
    const username = value("username");
    const groupPath = value("group")
      .split("/")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const tags = [
      ...new Set(
        value("tags")
          .split(/[;,]/)
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ""),
      ),
    ];
    servers.push({
      draftId: `${file}:${record.line}`,
      alias: label,
      label,
      address,
      ...(port !== undefined ? { port } : {}),
      ...(username ? { username } : {}),
      groupPath,
      tags,
      jumpChain: [],
      location: { file, line: record.line },
    });
  }
  return { servers, issues };
}
