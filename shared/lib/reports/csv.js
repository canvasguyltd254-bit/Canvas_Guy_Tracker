/**
 * shared/lib/reports/csv.js
 *
 * CSV for accountants. Opens cleanly in Excel (UTF-8 BOM, CRLF), quotes fields
 * that need it, and neutralises spreadsheet formula injection: a text cell that
 * starts with = + - @ is prefixed with an apostrophe. Real numbers are written
 * as numbers and are never prefixed, so negative amounts stay numeric.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  let s = String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * @param {{ key: string, label: string }[]} columns
 * @param {object[]} rows
 * @returns {string} CSV text including the BOM
 */
export function toCsv(columns, rows) {
  const head = columns.map(c => cell(c.label)).join(',');
  const body = (rows || []).map(r => columns.map(c => cell(r[c.key])).join(','));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}
