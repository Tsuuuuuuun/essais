// 記事の OGP 画像と description。
// 画像は書き出した記事の頁から題・日付・本文を抜き、縦組の 1200×630 に組み直して headless Chrome で撮る。
// 組版は site.css をそのまま使うので、縦中横・注番号・引用などがサイトと同じに出る。
// 撮った画像は組み直した HTML のハッシュで .cache/og/ に取っておき、変わった記事だけ撮り直す。使わなくなった画像は書き出しのたびに捨てる。

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, '.cache/og');
const CSS = path.join(ROOT, 'src/assets/site.css');
const CHROME = process.env.ESSAIS_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const OG_FILE = 'og.png';

// 記事の頁から、画像に載せる部分を抜く。本文は道具・題・奥付・注・図を除いたもの
function parts(html) {
  const art = /<article>([\s\S]*?)<\/article>/.exec(html)?.[1];
  if (!art) return null;
  const title = /<h1>([\s\S]*?)<\/h1>/.exec(art)?.[1] ?? '';
  const date = /<p class="colophon">([\s\S]*?)<\/p>/.exec(art)?.[1] ?? '';
  const body = art
    .replace(/<div class="tools">[\s\S]*?<\/div>/, '')
    .replace(/<h1>[\s\S]*?<\/h1>/, '')
    .replace(/<p class="colophon">[\s\S]*?<\/p>/, '')
    .replace(/<p class="back">[\s\S]*?<\/p>/, '')
    .replace(/<section class="fns"[\s\S]*?<\/section>/, '')
    .replace(/<div class="figs"[\s\S]*?<\/div>/, '');
  return { title, date, body };
}

// ルビの読み・注番号・図の参照・区切りの＊を落とした、地の文だけの文字列
export function plainText(html) {
  return String(html ?? '')
    .replace(/<rt>[\s\S]*?<\/rt>|<rp>[\s\S]*?<\/rp>/g, '')
    .replace(/<a class="(?:fnref|figref)"[\s\S]*?<\/a>/g, '')
    .replace(/<p class="(?:break|src)"[\s\S]*?<\/p>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    // 改行などの空白は詰める。欧文の語間だけは一つ残す。全角英数字も欧文として扱う（「ｌｏｓｔ ｕｍｂｒｅｌｌａ」）
    .replace(/\s+/g, ' ')
    .replace(/ (?=[^\x00-\x7fＡ-Ｚａ-ｚ０-９])|(?<=[^\x00-\x7fＡ-Ｚａ-ｚ０-９]) /g, '')
    .trim();
}

// 記事の書き出し。description に使う
export function excerpt(html, length = 100) {
  const p = parts(html);
  if (!p) return '';
  const text = plainText(p.body);
  return text.length > length ? text.slice(0, length) + '…' : text;
}

// 日付を題の左下に置き、その左に本文を薄く流して左端で消す
function page({ title, date, body }, css) {
  const long = plainText(title).length > 12;
  return `<!doctype html><html lang="ja" class="tate js"><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@400;600&display=block">
<style>${css}</style>
<style>
:root { color-scheme: light; --paper: #fcfbf8; --ink: #26241f; --ink-soft: #77736a; --rule: #dcd8cf; }
html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: var(--paper); }
.og { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 80px 300px 80px 0;
  writing-mode: vertical-rl; text-orientation: mixed; font-family: var(--mincho);
  line-break: strict; hanging-punctuation: allow-end; text-spacing-trim: trim-start; }
/* 日付は題と本文のちょうど真ん中に置く。字面から字面までを --gap にそろえるため、
   題と本文の側では行送りの上下の空き（題は (1.5 - 1) / 2 = 0.25em、本文は (2.1 - 1) / 2 = 0.55em）を差し引く */
.og { --gap: 56px; }
html.tate .og h1 { flex: none; margin: 0; margin-block-end: calc(var(--gap) - 0.25em); padding: 0; font-size: ${long ? 48 : 58}px; font-weight: 600; line-height: 1.5; letter-spacing: 0.15em; }
.og .d { flex: none; font-size: 20px; line-height: 1; letter-spacing: 0.15em; color: var(--ink-soft); text-align: end; }
.og .b { flex: 1; min-inline-size: 0; overflow: hidden; margin-block-start: calc(var(--gap) - 0.55em);
  font-size: 21px; line-height: 2.1; letter-spacing: 0.06em; color: var(--ink-soft);
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 70%); mask-image: linear-gradient(to right, transparent 0, #000 70%); }
.og .b blockquote { margin-block: 1em; }
.og .b > :first-child { margin-block-start: 0; }
.mark { position: absolute; left: 56px; bottom: 44px; font-family: var(--mincho); font-size: 20px; letter-spacing: 0.2em; color: var(--ink-soft); }
</style></head><body>
<div class="og" hidden><h1>${title}</h1><div class="d">${date}</div><div class="b">${body}</div></div>
<div class="mark">essais</div>
<script>
  // 字体が届く前に組むと、縦中横の幅が代わりの字体で決まったまま残り、数字が行の中心からずれる。
  // 使う字を読み込み終えてから見せて、はじめから Shippori Mincho で組ませる。
  // 字体が届かなくても load は空の配列で済んでしまうので、届いたかどうかを撮る側へ console で知らせる
  const og = document.querySelector('.og');
  const text = og.textContent + 'essais';
  Promise.all(['400', '600'].map((w) => document.fonts.load(w + ' 1em "Shippori Mincho"', text)))
    .then((faces) => faces.every((f) => f.length > 0), () => false)
    .then((ok) => { console.log(ok ? '${FONTS_OK}' : '${FONTS_NG}'); og.hidden = false; });
</script>
</body></html>`;
}

const FONTS_OK = 'essais-og:fonts-ok';
const FONTS_NG = 'essais-og:fonts-missing';

// 撮って、Shippori Mincho で組めたかどうかを返す。頁の console は --enable-logging で stderr に出る
async function shoot(html, png) {
  const dir = await mkdtemp(path.join(tmpdir(), 'essais-og-'));
  try {
    const file = path.join(dir, 'og.html');
    await writeFile(file, html);
    // 同時に何枚も撮れるよう、Chrome のプロファイルは一枚ごとに分ける
    const { stderr } = await promisify(execFile)(CHROME, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--window-size=1200,630', '--virtual-time-budget=6000', `--user-data-dir=${path.join(dir, 'profile')}`,
      '--enable-logging=stderr', '--v=0', `--screenshot=${png}`, 'file://' + file,
    ], { maxBuffer: 16 * 1024 * 1024 });
    return stderr.includes(FONTS_OK);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 書き出した記事の頁ごとに、同じフォルダへ og.png を置く
export async function writeOgImages(results) {
  try { await stat(CHROME); } catch {
    console.warn(`[og] Chrome が見つからないので OGP 画像を作らない（ESSAIS_CHROME で場所を指定できる）: ${CHROME}`);
    return;
  }
  const css = await readFile(CSS, 'utf8');
  await mkdir(CACHE, { recursive: true });
  const jobs = results
    .filter((r) => r.url?.startsWith('/posts/') && r.outputPath?.endsWith('.html'))
    .map((r) => ({ r, p: parts(r.content) }))
    .filter(({ p }) => p);
  let made = 0;
  const used = new Set();
  const fallback = [];
  const run = async ({ r, p }) => {
    const html = page(p, css);
    const name = createHash('sha256').update(html).digest('hex').slice(0, 32) + '.png';
    used.add(name);
    const cached = path.join(CACHE, name);
    const out = path.join(path.dirname(r.outputPath), OG_FILE);
    try { await stat(cached); } catch {
      made++;
      // 代わりの字体で撮れたものは今回の書き出しにだけ使い、取っておかない。次のビルドで撮り直す
      if (await shoot(html, out)) await copyFile(out, cached);
      else fallback.push(r.url);
      return;
    }
    await copyFile(cached, out);
  };
  // 四枚ずつ撮る
  for (let i = 0; i < jobs.length; i += 4) await Promise.all(jobs.slice(i, i + 4).map(run));
  // 書き出しは毎回すべての記事を通るので、今回使わなかった画像は古い組版のもの。捨てる
  const stale = (await readdir(CACHE)).filter((f) => !used.has(f));
  await Promise.all(stale.map((f) => rm(path.join(CACHE, f), { force: true })));
  console.log(`[og] OGP 画像 ${jobs.length} 枚（新しく撮ったもの ${made} 枚、捨てた古いもの ${stale.length} 枚）`);
  if (fallback.length) {
    console.warn(`[og] Shippori Mincho が届かず、代わりの字体で撮った（取っておかないので次のビルドで撮り直す）: ${fallback.join(' ')}`);
  }
}
