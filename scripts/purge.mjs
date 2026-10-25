#!/usr/bin/env node
// 消した原稿（front matter が deleted: true のもの）を本当に消す。
//
//   pnpm purge             → 消すものを出し、確かめてから消す
//   pnpm purge --dry-run   → 消すはずのものを出して終わる（R2 の LIST はする、DELETE はしない）
//
// 消すのは三つ。手元の記事フォルダ（画像ごと）、src/posts/order.json の名前、R2 の写し（posts/<名前>/ 以下）。
// R2 を先に消す。途中で失敗しても手元は残るので、もう一度走らせればやり直せる。
// R2 の写しを残すと、backup --pull で消した原稿が戻ってきてしまうので、写しも消す。
// ESSAIS_R2_BACKUP_BUCKET が無ければ手元だけ消す。

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { POSTS_DIR, deletedSlugs, parsePost } from '../lib/post.js';
import { ORDER_FILE, readOrder, formatOrder } from '../lib/order.js';
import { PREFIX, backupConfig, remoteHashes, removeObject } from './backup.mjs';

const dryRun = process.argv.includes('--dry-run');

async function confirm(question) {
  // 確かめられないとき（パイプなど）は消さない
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } catch {
    return false; // Ctrl+D など
  } finally {
    rl.close();
  }
}

try {
  const slugs = deletedSlugs();
  if (!slugs.length) {
    console.log('purge: 消した原稿はない');
    process.exit(0);
  }

  const r2 = backupConfig();
  const keys = r2
    ? [...(await remoteHashes(r2)).keys()].filter((k) => slugs.some((s) => k.startsWith(`${PREFIX}${s}/`)))
    : [];

  for (const slug of slugs) {
    const { title } = parsePost(readFileSync(join(POSTS_DIR, slug, 'index.md'), 'utf8'));
    console.log(`${slug}  ${title || '（題なし）'}`);
  }
  if (dryRun) for (const k of keys) console.log(`remove  ${k}`);
  console.log(r2 ? `R2 の写し: ${keys.length} files（${r2.bucket}）` : 'R2 の設定が無いので、手元だけ消す');

  if (dryRun) {
    console.log(`dry-run: ${slugs.length} 本`);
    process.exit(0);
  }
  if (!(await confirm(`${slugs.length} 本を本当に消しますか？戻せません。[y/N] `))) {
    console.log('purge: やめた');
    process.exit(0);
  }

  for (const k of keys) await removeObject(r2, k);
  for (const slug of slugs) rmSync(join(POSTS_DIR, slug), { recursive: true, force: true });
  const order = readOrder();
  if (order.some((s) => slugs.includes(s))) {
    writeFileSync(ORDER_FILE, formatOrder(order.filter((s) => !slugs.includes(s))), 'utf8');
  }
  console.log(`purge: ${slugs.length} 本を消した（R2 の写し ${keys.length} files）`);
} catch (e) {
  console.error(`purge: ${e.message}`);
  process.exit(1);
}
