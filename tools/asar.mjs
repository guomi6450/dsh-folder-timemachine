// Minimal asar reader — enough to inspect and extract the packages this
// verification needs out of D:\dsh\resources\app.asar.
//
//   node tools/asar.mjs list   <asar> <prefix>
//   node tools/asar.mjs cat    <asar> <path>
//   node tools/asar.mjs extract <asar> <prefix> <outDir>
//
// asar layout: a Pickle header (payload size, header string size), the JSON
// directory, then the concatenated file bytes.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [, , command, asarPath, ...rest] = process.argv;

if (asarPath === undefined || command === undefined) {
  console.error('usage: asar.mjs <list|cat|extract> <asar> <prefix|path> [outDir]');
  process.exit(2);
}

const archive = await readFile(asarPath);
// Two nested Pickles: the outer one holds the header pickle's byte length, the
// inner one holds the header JSON's byte length and then the JSON itself.
const headerPickleSize = archive.readUInt32LE(4);
const headerPickle = archive.subarray(8, 8 + headerPickleSize);
const jsonSize = headerPickle.readUInt32LE(4);
const header = JSON.parse(headerPickle.subarray(8, 8 + jsonSize).toString('utf8'));
const baseOffset = 8 + headerPickleSize;

function walk(node, prefix, visit) {
  if (node === null || typeof node !== 'object') return;
  if (typeof node.files === 'object' && node.files !== null) {
    for (const [name, child] of Object.entries(node.files)) {
      walk(child, prefix === '' ? name : prefix + '/' + name, visit);
    }
    return;
  }
  visit(prefix, node);
}

function entries(under) {
  const found = [];
  walk(header, '', (path, node) => {
    // Match whole path segments only: `cordis` must not swallow `cordis-plugin-timer`.
    if (under === undefined || under === '' || path === under || path.startsWith(under + '/')) {
      found.push({ path, node });
    }
  });
  return found;
}

function bytesOf(node) {
  const size = Number(node.size ?? 0);
  const offset = baseOffset + Number(node.offset ?? 0);
  return archive.subarray(offset, offset + size);
}

if (command === 'list') {
  const prefix = rest[0] ?? '';
  for (const entry of entries(prefix)) {
    console.log(`${String(entry.node.size ?? '-').padStart(9)}  ${entry.node.unpacked === true ? 'unpacked ' : ''}${entry.path}`);
  }
} else if (command === 'cat') {
  const wanted = rest[0];
  const hit = entries(wanted).find((entry) => entry.path === wanted);
  if (hit === undefined) {
    console.error('not found: ' + wanted);
    process.exit(1);
  }
  const bytes = bytesOf(hit.node);
  const limit = Number(rest[1] ?? 0);
  process.stdout.write(limit > 0 ? bytes.subarray(0, limit) : bytes);
} else if (command === 'extract') {
  const prefix = rest[0];
  const outDir = rest[1];
  if (prefix === undefined || outDir === undefined) {
    console.error('usage: asar.mjs extract <asar> <prefix> <outDir>');
    process.exit(2);
  }
  let count = 0;
  for (const entry of entries(prefix)) {
    if (entry.node.unpacked === true) continue;
    const target = join(outDir, entry.path.slice(prefix.length).replace(/^\/+/, ''));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytesOf(entry.node));
    count += 1;
  }
  console.log(`extracted ${count} files under ${prefix} -> ${outDir}`);
} else {
  console.error('unknown command: ' + command);
  process.exit(2);
}
