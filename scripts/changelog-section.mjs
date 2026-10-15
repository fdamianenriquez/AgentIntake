// Prints the CHANGELOG.md section for one version (without its heading), for
// release notes. Exits with 1 if the changelog has no section for it.
//
//   node scripts/changelog-section.mjs 1.2.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/changelog-section.mjs <version>');
  process.exit(2);
}

const lines = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf-8').split('\n');
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  console.error(`CHANGELOG.md has no "## [${version}]" section.`);
  process.exit(1);
}
let end = lines.findIndex((line, i) => i > start && (line.startsWith('## ') || /^\[[^\]]+\]: /.test(line)));
if (end === -1) end = lines.length;
console.log(
  lines
    .slice(start + 1, end)
    .join('\n')
    .trim()
);
