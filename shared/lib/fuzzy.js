/**
 * shared/lib/fuzzy.js
 *
 * Dice coefficient bigram similarity for fuzzy name matching.
 * Used to suggest supplier matches for Chatpesa transactions.
 *
 * Returns a score 0.0 – 1.0. Threshold of 0.70 = 70% similarity.
 */

export function diceCoefficient(a, b) {
  a = a.toLowerCase().trim().replace(/\s+/g, ' ');
  b = b.toLowerCase().trim().replace(/\s+/g, ' ');
  if (a === b) return 1.0;
  if (a.length < 2 || b.length < 2) return 0.0;

  const getBigrams = (str) => {
    const map = new Map();
    for (let i = 0; i < str.length - 1; i++) {
      const bg = str.slice(i, i + 2);
      map.set(bg, (map.get(bg) || 0) + 1);
    }
    return map;
  };

  const aBigrams = getBigrams(a);
  const bBigrams = getBigrams(b);

  let intersection = 0;
  for (const [bg, count] of aBigrams) {
    const bCount = bBigrams.get(bg) || 0;
    intersection += Math.min(count, bCount);
  }

  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

/**
 * Find the best-matching supplier for a given account name.
 *
 * @param {string} accountName  — from Chatpesa CSV "Account Name" column
 * @param {Array}  suppliers    — array of { id, name } objects
 * @param {number} threshold    — minimum score (default 0.70)
 * @returns {{ id, name, score } | null}
 */
export function findBestSupplierMatch(accountName, suppliers, threshold = 0.70) {
  if (!accountName || !suppliers?.length) return null;

  let best = null;
  let bestScore = 0;

  for (const s of suppliers) {
    const score = diceCoefficient(accountName, s.name);
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      best = { id: s.id, name: s.name, score: Math.round(score * 100) };
    }
  }

  return best;
}
