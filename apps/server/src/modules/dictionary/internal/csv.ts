/** Rows of a CSV text (RFC 4180 quoting, `\n`, `\r\n` or `\r` line endings). */
export function parseCsv(csv: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < csv.length; i++) {
    const char = csv[i]!
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"' && field === '') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && csv[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/** Dictionary import: the first column of each non-empty row, without a leading `term` header. */
export function termsFromCsv(csv: string): string[] {
  const values = parseCsv(csv.replace(/^﻿/, ''))
    .map((row) => (row[0] ?? '').trim())
    .filter((value) => value !== '')
  if (values[0]?.toLowerCase() === 'term') values.shift()
  return values
}
