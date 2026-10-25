// 執筆画面のローカルサーバー。
//   pnpm write → http://localhost:8090
// 原稿は src/posts/<名前>/index.md に直接保存する。画像も同じフォルダに置く。
// 下書きは front matter の draft: true（読み書きは lib/post.js）。
// 消した原稿は front matter に deleted: true を付けるだけで、フォルダも目次の並びも残す（戻せるように）。
// 本当に消すのは pnpm purge（scripts/purge.mjs）。
// 見たままの編集には ProseMirror を使う。node_modules から ES モジュールのまま配る（/vendor/<名前>.js）。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER_FILE, readOrder, formatOrder, sortPosts } from '../../lib/order.js';
import { POSTS_DIR as POSTS, SLUG, parsePost, formatPost } from '../../lib/post.js';
import { toDoc } from './doc.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || '127.0.0.1';

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

async function listPosts() {
  let names = [];
  try { names = await readdir(POSTS); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!SLUG.test(name)) continue;
    try {
      const p = parsePost(await readFile(path.join(POSTS, name, 'index.md'), 'utf8'));
      out.push({ slug: name, title: p.title, date: p.date, draft: p.draft, deleted: p.deleted });
    } catch {}
  }
  return sortPosts(out, readOrder(), (p) => p.slug, (p) => Date.parse(p.date) || 0);
}

// ---- ブラウザに配るモジュール ----
// 名前 → ES モジュールのファイル。依存の依存（orderedmap など）は、それを使うパッケージの場所から探す
const VENDOR = [
  'prosemirror-model', 'prosemirror-state', 'prosemirror-view', 'prosemirror-transform',
  'prosemirror-keymap', 'prosemirror-commands', 'prosemirror-history', 'prosemirror-inputrules',
  'prosemirror-schema-list', 'orderedmap', 'rope-sequence', 'w3c-keyname',
];
const vendor = new Map();
function packageDir(file) {
  for (let dir = path.dirname(file); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    try { readFileSync(path.join(dir, 'package.json')); return dir; } catch {}
  }
  return null;
}
function resolveVendor(name) {
  if (vendor.has(name)) return vendor.get(name);
  const from = [path.join(ROOT, 'package.json'), ...[...vendor.values()].map((f) => f && path.join(packageDir(f), 'package.json'))];
  for (const parent of from) {
    if (!parent) continue;
    try {
      const dir = packageDir(createRequire(parent).resolve(name));
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const exp = pkg.exports && (pkg.exports['.'] || pkg.exports);
      const entry = (exp && (typeof exp.import === 'string' ? exp.import : exp.import && exp.import.default)) || pkg.module;
      if (!entry) continue;
      const file = path.join(dir, entry);
      vendor.set(name, file);
      return file;
    } catch {}
  }
  return null;
}
VENDOR.forEach(resolveVendor);

// ---- 公開 ----
// pnpm run deploy と同じく、ビルドしてから scripts/deploy.mjs を走らせる。一度に一つだけ
const ELEVENTY = path.join(ROOT, 'node_modules/@11ty/eleventy/cmd.cjs');
const DEPLOY = path.join(ROOT, 'scripts/deploy.mjs');
let deploying = false;

function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { cwd: ROOT, env: process.env });
    let log = '';
    const tee = (out) => (c) => { out.write(c); log += c; };
    child.stdout.on('data', tee(process.stdout));
    child.stderr.on('data', tee(process.stderr));
    child.on('error', (e) => resolve({ code: 1, log: log + e.message }));
    child.on('close', (code) => resolve({ code, log }));
  });
}

async function deploy() {
  const build = await run(ELEVENTY);
  if (build.code !== 0) return { ok: false, step: 'build', log: build.log };
  const up = await run(DEPLOY);
  return { ok: up.code === 0, step: 'deploy', log: build.log + up.log };
}

// ---- HTTP ----
function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), TYPES['.json']);

async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('大きすぎます'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function serveFile(res, file) {
  try {
    const s = await stat(file);
    if (!s.isFile()) return send(res, 404, '見つかりません');
    send(res, 200, await readFile(file), TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  } catch {
    send(res, 404, '見つかりません');
  }
}

// 指定のフォルダの外に出るパスは受け付けない
function inside(base, rel) {
  const p = path.resolve(base, rel);
  return p.startsWith(base + path.sep) ? p : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (req.method === 'GET' && url.pathname === '/') return serveFile(res, path.join(HERE, 'editor.html'));
    if (req.method === 'GET' && url.pathname === '/wysiwyg.js') return serveFile(res, path.join(HERE, 'wysiwyg.js'));
    if (req.method === 'GET' && url.pathname === '/lib/kanji.js') return serveFile(res, path.join(ROOT, 'lib/kanji.js'));
    if (req.method === 'GET' && parts[0] === 'vendor' && parts.length === 2) {
      const name = parts[1].replace(/\.js$/, '');
      const f = VENDOR.includes(name) && resolveVendor(name);
      return f ? serveFile(res, f) : send(res, 404, '見つかりません');
    }

    // 図の画像（記事と同じフォルダ）。ルビ・図の小窓で見せる
    if (req.method === 'GET' && parts[0] === 'posts' && parts.length === 3 && SLUG.test(parts[1])) {
      if (!IMAGE_EXT.has(path.extname(parts[2]).toLowerCase())) return send(res, 404, '見つかりません');
      const f = inside(POSTS, `${parts[1]}/${parts[2]}`);
      return f ? serveFile(res, f) : send(res, 404, '見つかりません');
    }

    if (parts[0] === 'api') {
      // 一覧
      if (req.method === 'GET' && parts[1] === 'posts' && parts.length === 2) return json(res, 200, await listPosts());

      // 並び順（名前の配列）
      if (req.method === 'PUT' && parts[1] === 'order' && parts.length === 2) {
        const list = JSON.parse((await readBody(req)).toString('utf8') || '[]');
        if (!Array.isArray(list) || !list.every((s) => typeof s === 'string' && SLUG.test(s))) {
          return json(res, 400, { error: '並び順を読めません' });
        }
        // 一覧に出ていない名前（消した原稿など）は、もとの位置に残す
        const given = new Set(list), rest = [...given];
        const merged = readOrder().map((s) => (given.has(s) ? rest.shift() : s)).filter(Boolean);
        await writeFile(ORDER_FILE, formatOrder([...new Set([...merged, ...rest])]), 'utf8');
        return json(res, 200, { ok: true });
      }

      // 公開。終わるまで待って結果を返す
      if (req.method === 'POST' && parts[1] === 'deploy' && parts.length === 2) {
        if (deploying) return json(res, 409, { error: 'いま公開しています' });
        deploying = true;
        try {
          const r = await deploy();
          if (r.ok) return json(res, 200, { ok: true, log: r.log });
          // 最後に出た deploy: の行（scripts/deploy.mjs の die）を知らせる
          const line = r.log.split('\n').reverse().find((l) => l.startsWith('deploy: '));
          const error = line ? line.slice('deploy: '.length)
            : r.step === 'build' ? 'ビルドに失敗しました（ターミナルを見てください）' : '公開に失敗しました（ターミナルを見てください）';
          return json(res, 500, { error, log: r.log });
        } finally {
          deploying = false;
        }
      }

      // 原稿を見たままの編集の文書に変える
      if (req.method === 'POST' && parts[1] === 'doc' && parts.length === 2) {
        const data = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        return json(res, 200, { doc: toDoc(data.body) });
      }

      if (parts[1] === 'posts' && parts[2]) {
        const slug = parts[2];
        if (!SLUG.test(slug)) return json(res, 400, { error: '名前は半角の英小文字・数字・ハイフンで付けてください' });
        const dir = path.join(POSTS, slug);
        const file = path.join(dir, 'index.md');

        if (req.method === 'GET' && parts.length === 3) {
          try { return json(res, 200, { slug, ...parsePost(await readFile(file, 'utf8')) }); }
          catch { return json(res, 404, { error: 'この原稿は見つかりません' }); }
        }
        if (req.method === 'PUT' && parts.length === 3) {
          const data = JSON.parse((await readBody(req)).toString('utf8') || '{}');
          const old = await readFile(file, 'utf8').then(parsePost, () => null);
          const isNew = !old;
          // 消した原稿の名前は、pnpm purge で本当に消すまで使えない
          if (old?.deleted) return json(res, 409, { error: 'その名前は消した原稿が使っています（pnpm purge で本当に消すと使えます）' });
          await mkdir(dir, { recursive: true });
          await writeFile(file, formatPost(data), 'utf8');
          // 新しい原稿は目次の先頭に加える
          const order = readOrder();
          if (isNew && !order.includes(slug)) await writeFile(ORDER_FILE, formatOrder([slug, ...order]), 'utf8');
          return json(res, 200, { ok: true });
        }
        // 消す・戻す。front matter の deleted を付け外しするだけ
        if ((req.method === 'DELETE' && parts.length === 3) || (req.method === 'POST' && parts[3] === 'restore' && parts.length === 4)) {
          let p;
          try { p = parsePost(await readFile(file, 'utf8')); } catch { return json(res, 404, { error: 'この原稿は見つかりません' }); }
          await writeFile(file, formatPost({ ...p, deleted: req.method === 'DELETE' }), 'utf8');
          return json(res, 200, { ok: true });
        }
        // 画像を記事のフォルダに保存する
        if (req.method === 'POST' && parts[3] === 'images') {
          const raw = String(url.searchParams.get('name') || 'image');
          const ext = path.extname(raw).toLowerCase();
          if (!IMAGE_EXT.has(ext)) return json(res, 400, { error: 'この形式の画像は置けません' });
          let stem = path.basename(raw, path.extname(raw)).normalize('NFKC').toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'image';
          await mkdir(dir, { recursive: true });
          let name = stem + ext;
          for (let i = 2; ; i++) {
            try { await stat(path.join(dir, name)); name = `${stem}-${i}${ext}`; } catch { break; }
          }
          await writeFile(path.join(dir, name), await readBody(req));
          return json(res, 200, { name });
        }
      }
      return json(res, 404, { error: '見つかりません' });
    }
    send(res, 404, '見つかりません');
  } catch (e) {
    json(res, e.status || 500, { error: e.message || 'うまくいきませんでした' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`執筆画面: http://${HOST === '127.0.0.1' ? 'localhost' : HOST}:${PORT}`);
  console.log(`原稿の保存先: ${POSTS}`);
});
