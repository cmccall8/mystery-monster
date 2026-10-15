import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Apostrophes are removed so Frankenstein's → frankensteins, as in AGENTS.md.
export const slug = name => name.toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/['’]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function pictureMaps(source) {
  return Object.fromEntries(['MONSTER_PICS', 'MONSTER_POSTERS'].map(key => {
    const literal = source.match(new RegExp(`const ${key} = (\\{[\\s\\S]*?\\n\\});`));
    if (!literal) throw new Error(`Missing ${key}`);
    // The reference uses quoted keys and string values with a trailing comma.
    return [key, JSON.parse(literal[1].replace(/,\s*}/g, '}'))];
  }));
}

export async function extract() {
  const root = new URL('../', import.meta.url);
  const maps = pictureMaps(await readFile(new URL('reference/mystery-monster-scorekeeper.html', root), 'utf8'));
  for (const [key, entries] of Object.entries(maps)) {
    const folder = key === 'MONSTER_PICS' ? 'portraits' : 'posters';
    await mkdir(new URL(`images/${folder}/`, root), { recursive: true });
    const names = new Set();
    for (const [name, uri] of Object.entries(entries)) {
      const match = uri.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!match) throw new Error(`Invalid JPEG data for ${name}`);
      const filename = slug(name);
      if (names.has(filename)) throw new Error(`Duplicate slug: ${name}`);
      names.add(filename);
      await writeFile(new URL(`images/${folder}/${filename}.jpg`, root), Buffer.from(match[1], 'base64'));
      console.log(`${folder}: ${name} → ${filename}.jpg`);
    }
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await extract();
