/**
 * shared/lib/reports/fetchAll.js
 *
 * Pagination helpers for Supabase/PostgREST reads. A single request returns at
 * most 1,000 rows by default and silently truncates beyond that, which makes
 * report totals quietly wrong. These helpers page until the data runs out and
 * THROW on any error, so a failed read can never look like an empty report.
 */

/**
 * @param {(from: number, to: number) => PromiseLike<{data: any[]|null, error: any}>} buildPage
 *        Returns one page query, e.g. (f, t) => sb.from('orders').select('*').order('id').range(f, t)
 * @param {{ label?: string, pageSize?: number, maxPages?: number }} [opts]
 */
export async function fetchAllRows(buildPage, { label = 'rows', pageSize = 1000, maxPages = 500 } = {}) {
  const all = [];
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize;
    const { data, error } = await buildPage(from, from + pageSize - 1);
    if (error) throw new Error(`Could not load ${label}: ${error.message || String(error)}`);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
  throw new Error(`Could not load ${label}: more than ${maxPages * pageSize} rows`);
}

/** Split an array into chunks (for `.in()` lists, which have URL-length limits). */
export function chunk(list, size = 150) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Run `fetchOne(idsChunk)` for each chunk of ids and concatenate the rows. */
export async function fetchByIds(ids, fetchOne, size = 150) {
  const out = [];
  for (const part of chunk([...new Set(ids)].filter(Boolean), size)) {
    out.push(...(await fetchOne(part)));
  }
  return out;
}
