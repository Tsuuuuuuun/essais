// 目次の並び（サイトと執筆画面で共通）。
// src/posts/order.json に原稿の名前を並べた順。載っていない原稿はその後ろに、日付の古い順。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ORDER_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/posts/order.json');

export function readOrder() {
  try {
    const list = JSON.parse(readFileSync(ORDER_FILE, 'utf8'));
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function formatOrder(list) {
  return JSON.stringify(list, null, 2) + '\n';
}

// slugOf は原稿の名前、timeOf は日付（数値）を返す
export function sortPosts(items, order, slugOf, timeOf) {
  const rank = new Map(order.map((s, i) => [s, i]));
  const r = (x) => rank.get(slugOf(x)) ?? Infinity;
  return items.sort((a, b) => r(a) - r(b) || timeOf(a) - timeOf(b));
}
