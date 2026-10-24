// 執筆画面のローカルサーバー。
//   pnpm write → http://localhost:8090
// 原稿は src/posts/<名前>/index.md に直接保存する。画像も同じフォルダに置く。
// 消した原稿はフォルダごと .trash/<名前>-<日時>/ に移す。戻すときはフォルダを src/posts/ に戻す。
// プレビューはサイトと同じ変換（lib/markdown.js）と CSS（src/assets/site.css）で組む。

import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir, stat, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { md } from '../../lib/markdown.js';
import { kanjiDate } from '../../lib/kanji.js';
import { ORDER_FILE, readOrder, formatOrder, sortPosts } from '../../lib/order.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const POSTS = path.join(ROOT, 'src/posts');
const ASSETS = path.join(ROOT, 'src/assets');
const TRASH = path.join(ROOT, '.trash');
const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || '127.0.0.1';

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg']);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

// ---- 原稿ファイルの読み書き ----
// front matter は title / date だけを扱う単純なもの
function parsePost(text) {
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
    body: body.replace(/^\n+/, ''),
  };
}

function formatPost({ title, date, body }) {
  const lines = ['---', `title: ${JSON.stringify(title || '')}`];
  if (date) lines.push(`date: ${date}`);
  lines.push('---', '', String(body || '').replace(/\r/g, '').replace(/\s*$/, ''), '');
  return lines.join('\n');
}

async function listPosts() {
  let names = [];
  try { names = await readdir(POSTS); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!SLUG.test(name)) continue;
    try {
      const p = parsePost(await readFile(path.join(POSTS, name, 'index.md'), 'utf8'));
      out.push({ slug: name, title: p.title, date: p.date });
    } catch {}
  }
  return sortPosts(out, readOrder(), (p) => p.slug, (p) => Date.parse(p.date) || 0);
}

// ---- プレビュー ----
function renderArticle({ title, date, body }) {
  return (
    `<h1>${md.renderInline(String(title || '題'))}</h1>\n` +
    md.render(String(body || '')) +
    (date ? `<p class="colophon">${kanjiDate(date)}</p>` : '')
  );
}

const PREVIEW = `<!doctype html>
<html lang="ja" class="tate js" data-preview>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base id="base" href="/posts/">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&display=swap">
<link rel="stylesheet" href="/assets/site.css">
<script src="/assets/site.js" defer></script>
</head>
<body>
<main id="scroller" tabindex="0" aria-label="プレビュー"><article id="out"></article></main>
</body>
</html>`;

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
    if (req.method === 'GET' && url.pathname === '/preview') return send(res, 200, PREVIEW, TYPES['.html']);

    if (req.method === 'GET' && parts[0] === 'assets') {
      const f = inside(ASSETS, parts.slice(1).join('/'));
      return f ? serveFile(res, f) : send(res, 404, '見つかりません');
    }
    // プレビューの中の画像（記事と同じフォルダ）
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
        await writeFile(ORDER_FILE, formatOrder([...new Set(list)]), 'utf8');
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

      // プレビュー
      if (req.method === 'POST' && parts[1] === 'render') {
        const data = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        return json(res, 200, { html: renderArticle(data) });
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
          const isNew = await stat(file).then(() => false, () => true);
          await mkdir(dir, { recursive: true });
          await writeFile(file, formatPost(data), 'utf8');
          // 新しい原稿は目次の末尾に加える
          const order = readOrder();
          if (isNew && !order.includes(slug)) await writeFile(ORDER_FILE, formatOrder([...order, slug]), 'utf8');
          return json(res, 200, { ok: true });
        }
        // 消す。フォルダは .trash に移し、目次の並びからも外す
        if (req.method === 'DELETE' && parts.length === 3) {
          try { await stat(file); } catch { return json(res, 404, { error: 'この原稿は見つかりません' }); }
          const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
          const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
          await mkdir(TRASH, { recursive: true });
          await rename(dir, path.join(TRASH, `${slug}-${stamp}`));
          const order = readOrder();
          if (order.includes(slug)) await writeFile(ORDER_FILE, formatOrder(order.filter((s) => s !== slug)), 'utf8');
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
