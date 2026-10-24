// 原稿ファイル（src/posts/<名前>/index.md）の読み書き（サイトと執筆画面で共通）。
// front matter は title / date / draft だけを扱う単純なもの。
// draft: true の原稿は下書きで、サイトには出さない。

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const POSTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/posts');
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parsePost(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const data = {};
  let body = text;
  if (m) {
    body = text.slice(m[0].length);
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (!kv) continue;
      let v = kv[2].trim();
      if (v.startsWith('"')) { try { v = JSON.parse(v); } catch {} }
      else if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
      data[kv[1]] = v;
    }
  }
  return {
    title: String(data.title ?? ''),
    date: data.date ? String(data.date).slice(0, 10) : '',
    draft: data.draft === 'true',
    body: body.replace(/^\n+/, ''),
  };
}

export function formatPost({ title, date, draft, body }) {
  const lines = ['---', `title: ${JSON.stringify(title || '')}`];
  if (date) lines.push(`date: ${date}`);
  if (draft) lines.push('draft: true');
  lines.push('---', '', String(body || '').replace(/\r/g, '').replace(/\s*$/, ''), '');
  return lines.join('\n');
}

// 下書きでない原稿の名前
export function publishedSlugs() {
  let names = [];
  try { names = readdirSync(POSTS_DIR); } catch { return []; }
  return names.filter((name) => {
    if (!SLUG.test(name)) return false;
    try { return !parsePost(readFileSync(path.join(POSTS_DIR, name, 'index.md'), 'utf8')).draft; }
    catch { return false; }
  });
}
