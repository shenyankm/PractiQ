export function questionSearchPredicate(term: string) {
  const words = term.trim().split(/\s+/).filter(Boolean);
  if (words.length && words.every((word) => [...word].length >= 3)) {
    return {
      sql: 'q.id IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?)',
      value: words.map((word) => `"${word.replaceAll('"', '""')}"`).join(' AND '),
    } as const;
  }
  return { sql: 'q.stem LIKE ?', value: `%${term}%` } as const;
}
