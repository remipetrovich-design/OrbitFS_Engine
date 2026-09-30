import fs from 'node:fs/promises';
import path from 'node:path';

export async function collectFolderFiles(root, folder, maxFiles, recursive = true, maxDepth = Number.POSITIVE_INFINITY) {
  const output = [];
  async function walk(current, relative, allowChildren, depth) {
    if (output.length >= maxFiles) return;
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (output.length >= maxFiles) break;
      if (entry.name.startsWith('_')) continue;
      const absolute = path.join(current, entry.name);
      const rel = path.posix.join(relative.replace(/\\/g, '/'), entry.name);
      if (entry.isFile()) output.push({ absolute, path: rel });
      else if (entry.isDirectory() && allowChildren && depth < maxDepth) await walk(absolute, rel, true, depth + 1);
    }
  }
  const relative = path.relative(root, folder).replace(/\\/g, '/');
  await walk(folder, relative, recursive !== false, 0);
  return output;
}
