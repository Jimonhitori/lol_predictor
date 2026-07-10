import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || 'docs');
const maxBytes = Number(process.env.MAX_STATIC_ASSET_BYTES || 25 * 1024 * 1024);
const files = [];

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(fullPath);
    else if (entry.isFile()) files.push(fullPath);
  }
}

walk(root);
const oversized = files
  .map(file => ({ file: path.relative(root, file).replaceAll('\\', '/'), bytes: fs.statSync(file).size }))
  .filter(item => item.bytes > maxBytes)
  .sort((left, right) => right.bytes - left.bytes);
const report = {
  ok: oversized.length === 0,
  root,
  max_bytes: maxBytes,
  files_checked: files.length,
  oversized,
};
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
