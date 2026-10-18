// Minimal RFC 4180 reader: quoted fields, escaped quotes, CRLF or LF. Records keep the source
// line span so evidence can point back at the row.

export type CsvRecord = { values: Record<string, string>; rowNumber: number; start: number; end: number };

export function parseCsv(text: string): CsvRecord[] {
  const rows: { cells: string[]; start: number; end: number }[] = [];
  let cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  let rowStart = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      const end = i;
      if (char === "\r" && text[i + 1] === "\n") i++;
      cells.push(cell);
      rows.push({ cells, start: rowStart, end });
      cells = [];
      cell = "";
      rowStart = i + 1;
    } else {
      cell += char;
    }
  }
  if (inQuotes) throw new Error("Unterminated quoted CSV field");
  if (cell !== "" || cells.length > 0) {
    cells.push(cell);
    rows.push({ cells, start: rowStart, end: text.length });
  }

  const nonEmpty = rows.filter((row) => !(row.cells.length === 1 && row.cells[0] === ""));
  const [header, ...data] = nonEmpty;
  if (!header) return [];
  const columns = header.cells.map((name) => name.trim());
  return data.map((row, index) => {
    if (row.cells.length !== columns.length) {
      throw new Error(`CSV row ${index + 1} has ${row.cells.length} fields, expected ${columns.length}`);
    }
    const values = Object.fromEntries(columns.map((name, column) => [name, (row.cells[column] ?? "").trim()]));
    return { values, rowNumber: index + 1, start: row.start, end: row.end };
  });
}
