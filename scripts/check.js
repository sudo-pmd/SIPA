// Vérification syntaxique de l'ensemble du code JavaScript du prototype.
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const skip = new Set(['node_modules', 'data', '.git', '.cloud-attachments', '.freebuff']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (skip.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (entry.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(root).sort();
let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failed++;
    console.error(`✗ ${relative(root, file)}\n${error.stderr?.toString() ?? error.message}`);
  }
}
console.log(`${failed === 0 ? '✓' : '✗'} ${files.length} fichiers JavaScript vérifiés — ${failed} erreur(s).`);
process.exit(failed === 0 ? 0 : 1);
