#!/usr/bin/env node
// src/posts/ の原稿の写しを R2 に取る。公開（scripts/deploy.mjs）の最後に毎回走るほか、単独でも動く。
//
//   node scripts/backup.mjs             → 変わったファイルだけ上げる
//   node scripts/backup.mjs --dry-run   → 上げるはずのものを出して終わる（LIST はする、PUT はしない）
//   node scripts/backup.mjs --pull      → 逆向き。R2 にあって手元に無い・違うものを src/posts/ に書く（--dry-run も効く）
//
// 原稿を git に入れない（.git/info/exclude などで外す）ときは、ここが唯一の写しになる。
// src/posts/posts.json はコードとして git で扱うので写さない（--pull で古い写しが git の版を上書きしないように）。
// 置き先は ESSAIS_R2_BACKUP_BUCKET。公開しないバケットを使う。
//
// キーは src/ からの相対パスそのまま（posts/yomu/index.md）。
// R2 の LIST が返す etag は単一 PUT なら中身の MD5 なので、手元の MD5 と比べて違うものだけ送る。
// 手元で消したファイルは R2 から消さない。消しても戻せる場所にしておくため。
// R2 から消すのは pnpm purge（scripts/purge.mjs）で、消した原稿を本当に消すときだけ。
// --pull はその逆で、R2 を正として手元を揃える。手元にだけあるファイルは消さない（消し間違いを伝播させない）。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, extname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const POSTS = join(root, 'src/posts');
const API = 'https://api.cloudflare.com/client/v4';
export const PREFIX = 'posts/';
// git で扱うので写さないもの（src/posts/ からの相対パス）
const TRACKED = new Set(['posts.json']);

const MIME = {
  '.md': 'text/markdown; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml',
};

const md5 = (buf) => createHash('md5').update(buf).digest('hex');
// キーに日本語や空白が入っても URL に載るように、区切りごとに符号化する
const keyPath = (key) => key.split('/').map(encodeURIComponent).join('/');

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    const rel = relative(POSTS, abs).split(sep).join('/');
    if (TRACKED.has(rel)) continue;
    if (statSync(abs).isDirectory()) {
      files.push(...collect(abs));
      continue;
    }
    const buf = readFileSync(abs);
    files.push({
      key: PREFIX + rel,
      buf,
      md5: md5(buf),
      type: MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
    });
  }
  return files;
}

async function call(r2, path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { authorization: `Bearer ${r2.token}`, ...headers },
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path} が JSON を返さなかった（${res.status}）${text.slice(0, 200)}`);
  }
  if (!res.ok || json.success === false) {
    const errs = (json.errors || []).map((e) => `${e.code}: ${e.message}`).join(', ') || text.slice(0, 200);
    throw new Error(`${method} ${path} が失敗（${res.status}）${errs}`);
  }
  return json;
}

// 中身をそのまま返す（JSON ではない）。失敗したときだけ JSON のエラーが返る。
async function getObject(r2, key) {
  const res = await fetch(`${API}/accounts/${r2.accountId}/r2/buckets/${r2.bucket}/objects/${keyPath(key)}`, {
    headers: { authorization: `Bearer ${r2.token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    let errs = text.slice(0, 200);
    try {
      errs = (JSON.parse(text).errors || []).map((e) => `${e.code}: ${e.message}`).join(', ') || errs;
    } catch {}
    throw new Error(`GET ${key} が失敗（${res.status}）${errs}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// R2 にあるものの MD5。1000 件ずつ、cursor が尽きるまで。
export async function remoteHashes(r2) {
  const hashes = new Map();
  let cursor;
  do {
    const q = new URLSearchParams({ prefix: PREFIX, per_page: '1000' });
    if (cursor) q.set('cursor', cursor);
    const json = await call(r2, `/accounts/${r2.accountId}/r2/buckets/${r2.bucket}/objects?${q}`);
    for (const o of json.result || []) hashes.set(o.key, String(o.etag || '').replace(/"/g, ''));
    cursor = json.result_info?.is_truncated ? json.result_info.cursor : null;
  } while (cursor);
  return hashes;
}

export async function removeObject(r2, key) {
  await call(r2, `/accounts/${r2.accountId}/r2/buckets/${r2.bucket}/objects/${keyPath(key)}`, { method: 'DELETE' });
}

// .env を読んで設定を組む。バケットが無ければ null（写しは取らない）。
export function backupConfig() {
  const envFile = join(root, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const bucket = process.env.ESSAIS_R2_BACKUP_BUCKET;
  if (!bucket) return null;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.ESSAIS_R2_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  const missing = [!accountId && 'CLOUDFLARE_ACCOUNT_ID', !token && 'CLOUDFLARE_API_TOKEN'].filter(Boolean);
  if (missing.length) throw new Error(`ESSAIS_R2_BACKUP_BUCKET があるのに ${missing.join(' と ')} がない`);
  return { bucket, accountId, token };
}

// 変わったものだけ上げる。log は一行ずつ受け取る（deploy.mjs が画面へ流すため）。
export async function backup(r2, { dryRun = false, log = console.log } = {}) {
  if (!existsSync(POSTS)) throw new Error(`${relative(root, POSTS)}/ がない`);
  const files = collect(POSTS);
  const remote = await remoteHashes(r2);
  const changed = files.filter((f) => remote.get(f.key) !== f.md5);
  const unchanged = files.length - changed.length;

  if (dryRun) {
    for (const f of changed) log(`${remote.has(f.key) ? 'update' : 'new   '}  ${f.key}`);
    log(`dry-run: ${changed.length} files → ${r2.bucket}（変わっていない ${unchanged}）`);
    return { changed: changed.length, unchanged };
  }

  for (const f of changed) {
    await call(r2, `/accounts/${r2.accountId}/r2/buckets/${r2.bucket}/objects/${keyPath(f.key)}`, {
      method: 'PUT',
      headers: { 'content-type': f.type },
      body: f.buf,
    });
  }
  log(`backup: ${changed.length} files → ${r2.bucket}（変わっていない ${unchanged}）`);
  return { changed: changed.length, unchanged };
}

// 逆向き。R2 にあって手元に無い・中身が違うものを src/posts/ に書く。手元にだけあるものには触らない。
// 新しい機械で clone したあと、最初に走らせる用途。
export async function pull(r2, { dryRun = false, log = console.log } = {}) {
  const remote = await remoteHashes(r2);
  const plan = [];
  let unchanged = 0;
  for (const [key, etag] of remote) {
    const rel = key.slice(PREFIX.length);
    // キーはこちらが書いたものだが、src/posts/ の外に書かされないことだけは確かめる
    if (!key.startsWith(PREFIX) || !rel || rel.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      throw new Error(`おかしなキーがある: ${key}`);
    }
    if (TRACKED.has(rel)) continue;
    const file = join(POSTS, ...rel.split('/'));
    const exists = existsSync(file);
    if (exists && md5(readFileSync(file)) === etag) {
      unchanged++;
      continue;
    }
    plan.push({ key, etag, file, how: exists ? 'update' : 'new   ' });
  }

  if (dryRun) {
    for (const p of plan) log(`${p.how}  ${p.key}`);
    log(`dry-run: ${plan.length} files ← ${r2.bucket}（変わっていない ${unchanged}）`);
    return { changed: plan.length, unchanged };
  }

  for (const p of plan) {
    const buf = await getObject(r2, p.key);
    // 落としたものが一覧の etag と違えば、途中で変わったか壊れたか。手元を汚さずに止める
    if (md5(buf) !== p.etag) throw new Error(`${p.key}: 中身の MD5 が一覧の etag と合わない`);
    mkdirSync(dirname(p.file), { recursive: true });
    writeFileSync(p.file, buf);
    log(`${p.how}  ${p.key}`);
  }
  log(`pull: ${plan.length} files ← ${r2.bucket}（変わっていない ${unchanged}）`);
  return { changed: plan.length, unchanged };
}

// 単独で動かしたとき
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dryRun = process.argv.includes('--dry-run');
  const doPull = process.argv.includes('--pull');
  try {
    const r2 = backupConfig();
    if (!r2) {
      console.error('backup: ESSAIS_R2_BACKUP_BUCKET がない');
      process.exit(1);
    }
    await (doPull ? pull : backup)(r2, { dryRun });
  } catch (e) {
    console.error(`backup: ${e.message}`);
    process.exit(1);
  }
}
