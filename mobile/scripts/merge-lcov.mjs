#!/usr/bin/env node
// Merge multiple LCOV reports (jest + node:test) and print per-file + total
// statement coverage. Usage: node scripts/merge-lcov.mjs <file1> <file2> ...
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
const perFile = new Map(); // path -> { hit: Map<line,1>, found: Map<line,1> }

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  let path = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      path = normalizePath(line.slice(3));
      if (!perFile.has(path)) perFile.set(path, { hit: new Map(), found: new Map() });
    } else if (line.startsWith('DA:') && path) {
      const [num, hits] = line.slice(3).split(',');
      const entry = perFile.get(path);
      entry.found.set(num, 1);
      if (Number(hits) > 0) entry.hit.set(num, 1);
    } else if (line === 'end_of_record') {
      path = null;
    }
  }
}

let totalFound = 0;
let totalHit = 0;
const rows = [];
for (const [path, { hit, found }] of perFile) {
  const foundCount = found.size;
  const hitCount = hit.size;
  totalFound += foundCount;
  totalHit += hitCount;
  rows.push({ path, foundCount, hitCount, pct: foundCount ? (hitCount / foundCount) * 100 : 100 });
}
rows.sort((a, b) => a.pct - b.pct || b.foundCount - a.foundCount);
for (const row of rows) {
  console.log(`${row.pct.toFixed(1).padStart(5)}%  ${String(row.hitCount).padStart(5)}/${String(row.foundCount).padStart(5)}  ${row.path}`);
}
console.log(`\nTOTAL ${((totalHit / totalFound) * 100).toFixed(1)}% (${totalHit}/${totalFound})`);

// jest emits repo-relative paths, node:test emits absolute ones: normalize to
// the path after /src/ so both reports merge on the same key.
function normalizePath(path) {
  const marker = '/src/';
  const index = path.lastIndexOf(marker);
  return index >= 0 ? path.slice(index + 1) : path;
}
