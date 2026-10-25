// 原稿（でんでんマークダウン寄りの Markdown）を、このサイトの組版の HTML に変える。
// サイトのビルド（11ty）と執筆画面のプレビューの両方がこのファイルを使う。
//
// 対応している書き方
//   {漢字|かんじ}        ルビ
//   {東京|とう|きょう}   一字ずつのルビ
//   ^12^                 縦中横（三字まで）
//   *語* / **語**        強調（傍点）
//   行末の改行           段落の中の改行（空行で段落を分ける）
//   空行を重ねる         段落と段落の間に、重ねた数だけ一行の空きを入れる（空行二つで一行空く）
//   ## 題                見出し（一段だけ）。番号は縦組で漢数字、横組で算用数字
//   > 文                 引用。――で始まる行は出典
//   ---                  場面の区切り（＊）
//   - 項目 / 1. 項目     箇条書き。番号は縦組で漢数字、横組で算用数字
//   文[^1]               注。本文には注番号だけを付け、末尾の注にまとめる
//   [^1]: 注の文         注の中身（空行まで）。URL はそのままリンクになり、[説明](https://…) とも書ける
//   ![説明](neko.jpg)    図。本文には（図一）を付け、押すと開く
//   ＮＨＫ（全角英数字）  縦組では正立、横組では半角に戻して表示
//   和文と英数字の間      空きは組版側で付ける（原稿のスペースは取り除く）

import MarkdownIt from 'markdown-it';
import { kanjiNumber } from './kanji.js';

const JA = '[\\u3005\\u3006\\u3040-\\u309f\\u30a0-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff]';
const JA_CHAR = new RegExp(JA);
const isJa = (c) => !!c && JA_CHAR.test(c);

// 英数字の連なり（単語の間のスペースは含む）と、全角英数字の連なり
const RUN = /([A-Za-z0-9](?:[A-Za-z0-9.,'’&\-\/:%+]| (?=[A-Za-z0-9]))*)|([Ａ-Ｚａ-ｚ０-９]+)/g;

// 前後の文字を探すときに素通りするトークン
const TRANSPARENT = new Set(['em_open', 'em_close', 'strong_open', 'strong_close', 'link_open', 'link_close']);

const SOURCE_LINE = /^(――|——|─|--)\s*/;

const NOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]*/;
const NOTE_REF = /^\[\^([^\]\s]+)\]/;
// 注の中の URL。和文の文字や空白で終わり、末尾の句読点は含めない
const URL_RUN = /https?:\/\/[!-~]+/g;
const URL_TAIL = /[.,;:!?'"]+$/;

// 注の中身を読むときの印。リンクは注の中でだけ使える
const IN_NOTE = Symbol('in-note');

// 行頭の引用記号と箇条書きの記号。和欧間のスペースを取り除くときに触らない（「1. 項目」の空白は記法の一部）
const LINE_HEAD = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*/;

export function createMarkdown() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false, breaks: false });
  const esc = md.utils.escapeHtml;

  // 随筆の本文に要らない書き方は止めておく（行頭の数字や字下げが別のものに化けないように）
  // 見出しは ## だけを使う。下線式（題の次の行に ---）は場面の区切りと紛れるので止める
  md.disable([
    'code', 'fence', 'table', 'lheading', 'html_block',
    'html_inline', 'backticks', 'autolink', 'strikethrough', 'reference',
  ]);

  // 番号は縦組用の漢数字と横組用の算用数字を両方出し、CSS で出し分ける
  const num = (n) => `<span class="nk">${kanjiNumber(n)}</span><span class="na">${n}</span>`;

  // ---- 和欧間：原稿に打たれたスペースは先に取り除く ----
  md.core.ruler.after('normalize', 'wa-space', (state) => {
    // 記法の記号（[ * { や閉じ括弧）を挟んでいても取り除く。全角英数字の前後も同じ
    state.src = state.src.split('\n').map((line) => {
      const head = LINE_HEAD.exec(line)[0];
      return head + line.slice(head.length)
        .replace(new RegExp(`(${JA}) +(?=[\\[*{]*[A-Za-z0-9\\uFF10-\\uFF5A])`, 'g'), '$1')
        .replace(new RegExp(`([A-Za-z0-9.%!?\\uFF10-\\uFF5A][\\])*}]*) +(?=[*{]*${JA})`, 'g'), '$1');
    }).join('\n');
  });

  // ---- 注 [^1] と [^1]: 注の文 ----
  // 注の中身は空行か次の注の手前まで。中身はふつうの文と同じに読み（ルビなども使える）、末尾の注にまとめる
  md.block.ruler.before('reference', 'note_def', (state, startLine, endLine, silent) => {
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    const pos = state.bMarks[startLine] + state.tShift[startLine];
    const m = NOTE_DEF.exec(state.src.slice(pos, state.eMarks[startLine]));
    if (!m) return false;
    if (silent) return true;
    const lines = [state.src.slice(pos + m[0].length, state.eMarks[startLine])];
    let next = startLine + 1;
    for (; next < endLine && !state.isEmpty(next); next++) {
      const line = state.src.slice(state.bMarks[next] + state.tShift[next], state.eMarks[next]);
      if (NOTE_DEF.test(line)) break;
      lines.push(line);
    }
    const open = state.push('note_def_open', '', 1);
    open.meta = { label: m[1] };
    open.map = [startLine, next];
    const inline = state.push('inline', '', 0);
    inline.content = lines.join('\n').trim();
    inline.map = [startLine, next];
    inline.children = [];
    inline.meta = { note: true };
    state.push('note_def_close', '', -1);
    state.line = next;
    return true;
  }, { alt: ['paragraph'] });

  // 注の中身だけ、リンクを読める状態で読む
  md.core.ruler.at('inline', (state) => {
    const noteEnv = Object.create(state.env);
    noteEnv[IN_NOTE] = true;
    for (const t of state.tokens) {
      if (t.type !== 'inline') continue;
      md.inline.parse(t.content, md, t.meta && t.meta.note ? noteEnv : state.env, t.children);
    }
  });

  md.inline.ruler.before('link', 'note_ref', (state, silent) => {
    if (state.env[IN_NOTE]) return false; // 注の中の注は書いたとおりに出す
    const m = NOTE_REF.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      state.pending = state.pending.replace(/[ \t]+$/, ''); // 注番号の前の空白は詰める
      state.push('note_ref', '', 0).meta = { label: m[1] };
    }
    state.pos += m[0].length;
    return true;
  });

  // 本文の [文](URL) はリンクにしない（書いたとおりに出す）
  md.inline.ruler.before('link', 'no-link', (state, silent) => {
    if (state.env[IN_NOTE] || state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false;
    if (!silent) state.pending += '[';
    state.pos++;
    return true;
  });

  // ---- ルビ {漢字|かんじ} ----
  md.inline.ruler.after('text', 'ruby', (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x7b /* { */) return false;
    const end = src.indexOf('}', start + 1);
    if (end < 0) return false;
    const inner = src.slice(start + 1, end);
    const bar = inner.indexOf('|');
    if (bar <= 0 || bar === inner.length - 1 || /[{\n]/.test(inner)) return false;
    if (!silent) {
      const base = inner.slice(0, bar);
      const t = state.push('ruby', '', 0);
      t.meta = { base, reads: inner.slice(bar + 1).split('|'), vis: base };
    }
    state.pos = end + 1;
    return true;
  });
  md.renderer.rules.ruby = (tokens, idx) => {
    const { base, reads } = tokens[idx].meta;
    const chars = Array.from(base);
    if (reads.length > 1 && reads.length === chars.length) {
      return '<ruby>' + chars.map((c, i) => `${esc(c)}<rt>${esc(reads[i])}</rt>`).join('') + '</ruby>';
    }
    return `<ruby>${esc(base)}<rt>${esc(reads.join(''))}</rt></ruby>`;
  };

  // ---- 縦中横 ^12^ ----
  md.inline.ruler.after('ruby', 'tcy', (state, silent) => {
    const m = /^\^([0-9A-Za-z!?]{1,3})\^/.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const t = state.push('tcy', '', 0);
      t.content = m[1];
      t.meta = { vis: 'A' }; // 前後に和欧間の空きを付けない
    }
    state.pos += m[0].length;
    return true;
  });
  md.renderer.rules.tcy = (tokens, idx) => `<span class="tcy">${esc(tokens[idx].content)}</span>`;

  // ---- 強調はすべて傍点 ----
  md.renderer.rules.em_open = md.renderer.rules.strong_open = () => '<em>';
  md.renderer.rules.em_close = md.renderer.rules.strong_close = () => '</em>';

  // ---- 段落の中の改行は、そのまま改行にする（執筆画面の見たままと同じ） ----
  md.renderer.rules.softbreak = () => '<br>';

  // ---- 空き：段落と段落の間で重ねた空行は、その数だけ空の段落にする ----
  // 本文の地の段落の間だけ数える（引用や箇条書きの中、見出しの前後は数えない）。原稿の頭と末尾の空行も数えない
  md.core.ruler.after('block', 'blank-lines', (state) => {
    const tokens = state.tokens;
    for (let i = tokens.length - 1; i > 0; i--) {
      const open = tokens[i];
      const close = tokens[i - 1];
      if (open.type !== 'paragraph_open' || close.type !== 'paragraph_close' || open.level !== 0) continue;
      const prev = tokens[i - 3]; // 前の段落の paragraph_open
      const extra = open.map[0] - prev.map[1] - 1;
      const blanks = [];
      for (let k = 0; k < extra; k++) {
        const p = new state.Token('paragraph_open', 'p', 1);
        p.attrSet('class', 'blank');
        p.block = true;
        const q = new state.Token('paragraph_close', 'p', -1);
        q.block = true;
        blanks.push(p, q);
      }
      tokens.splice(i, 0, ...blanks);
    }
  });

  // ---- 場面の区切り ----
  md.renderer.rules.hr = () => '<p class="break" aria-hidden="true">＊</p>\n';

  // ---- 見出し：## だけを見出しにし、番号を振る ----
  // # や ### は書いたとおりの段落に戻す
  md.core.ruler.after('block', 'heading-level', (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type !== 'heading_open' || t.tag === 'h2') continue;
      const inline = tokens[i + 1];
      inline.content = `${t.markup} ${inline.content}`;
      for (const x of [t, tokens[i + 2]]) {
        x.type = x.type.replace('heading', 'paragraph');
        x.tag = 'p';
        x.markup = '';
      }
    }
  });
  md.core.ruler.after('inline', 'heading-number', (state) => {
    let n = 0;
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const no = new state.Token('heading_no', '', 0);
      no.meta = { n: ++n, vis: 'A' }; // 後ろに和欧間の空きを付けない
      tokens[i + 1].children.unshift(no);
    }
  });
  md.renderer.rules.heading_no = (tokens, idx) => `<span class="no">${num(tokens[idx].meta.n)}</span>`;

  // ---- 箇条書き：記号と番号は本文の頭に置き、ぶら下げて組む ----
  // 番号は縦組用（一、）と横組用（1.）を両方出す。記号の幅は一覧のうちいちばん長いものに揃える
  md.core.ruler.after('inline', 'list-marks', (state) => {
    const tokens = state.tokens;
    const lists = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        t.attrJoin('class', 'items');
        lists.push({ open: t, k: 1, a: 1 });
        continue;
      }
      if (t.type === 'bullet_list_close' || t.type === 'ordered_list_close') {
        const l = lists.pop();
        l.open.attrSet('style', `--lm-k:${l.k}em;--lm-a:${l.a}em`);
        continue;
      }
      if (t.type !== 'list_item_open') continue;
      const l = lists[lists.length - 1];
      const mark = new state.Token('list_mark', '', 0);
      mark.meta = { vis: 'A' }; // 後ろに和欧間の空きを付けない
      if (l.open.type === 'ordered_list_open') {
        // 番号は一つめの項目の数から順に振る（原稿の二つめ以降の数は見ない。1. 1. 1. と書いてもよい）
        const n = (l.n = l.n === undefined ? Number(t.info) : l.n + 1);
        const k = kanjiNumber(n);
        mark.meta.n = n;
        l.k = Math.max(l.k, k.length + 1);
        l.a = Math.max(l.a, Math.ceil((String(n).length * 0.6 + 0.9) * 2) / 2); // 算用数字は半角、0.5em 刻み
      }
      const inline = tokens[i + 1] && tokens[i + 1].type === 'paragraph_open' && tokens[i + 2];
      if (inline && inline.type === 'inline') inline.children.unshift(mark);
      else t.meta = { mark }; // 中身が段落で始まらない項目（空の項目など）
    }
  });
  const listMark = (t) => {
    const n = t.meta.n;
    const body = n ? `<span class="nk">${kanjiNumber(n)}、</span><span class="na">${n}.</span>` : '・';
    return `<span class="lm" aria-hidden="true">${body}</span>`;
  };
  md.renderer.rules.list_mark = (tokens, idx) => listMark(tokens[idx]);
  md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    return self.renderToken(tokens, idx, options) + (t.meta && t.meta.mark ? listMark(t.meta.mark) : '');
  };

  // ---- 引用の出典：――で始まる行を独立させる ----
  md.core.ruler.after('block', 'quote-source', (state) => {
    const tokens = state.tokens;
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'blockquote_open') { depth++; continue; }
      if (t.type === 'blockquote_close') { depth--; continue; }
      if (!depth || t.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open') continue;
      const lines = t.content.split('\n');
      const k = lines.findIndex((l) => SOURCE_LINE.test(l));
      if (k < 0) continue;
      const rest = lines.slice(k);
      rest[0] = '――' + rest[0].replace(SOURCE_LINE, '');
      if (k === 0) {
        tokens[i - 1].attrSet('class', 'src');
        t.content = rest.join('\n');
        continue;
      }
      t.content = lines.slice(0, k).join('\n');
      const open = new state.Token('paragraph_open', 'p', 1);
      open.attrSet('class', 'src');
      open.block = true;
      open.level = tokens[i - 1].level;
      const inline = new state.Token('inline', '', 0);
      inline.content = rest.join('\n');
      inline.children = [];
      inline.block = true;
      inline.level = t.level;
      inline.map = t.map;
      const close = new state.Token('paragraph_close', 'p', -1);
      close.block = true;
      close.level = tokens[i - 1].level;
      tokens.splice(i + 2, 0, open, inline, close);
    }
  });

  // ---- 注と図を末尾にまとめる ----
  // 注は本文で初めて参照した順に番号を振る。参照されない注は出さず、中身のない注番号は書いたとおりに出す
  md.core.ruler.push('notes-and-figures', (state) => {
    if (state.inlineMode) return; // 題などでは番号を振らない
    const defs = new Map();
    const tokens = [];
    for (let i = 0; i < state.tokens.length; i++) {
      const t = state.tokens[i];
      if (t.type !== 'note_def_open') { tokens.push(t); continue; }
      if (!defs.has(t.meta.label)) defs.set(t.meta.label, state.tokens[i + 1]);
      i += 2;
    }
    state.tokens = tokens;

    const notes = [];
    const numbers = new Map();
    const figs = [];
    for (const block of tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      for (const t of block.children) {
        if (t.type === 'note_ref') {
          const { label } = t.meta;
          if (!defs.has(label)) continue;
          if (numbers.has(label)) { t.meta.n = numbers.get(label); continue; }
          notes.push(defs.get(label));
          numbers.set(label, notes.length);
          t.meta.n = notes.length;
          t.meta.first = true;
        } else if (t.type === 'image') {
          figs.push({ src: t.attrGet('src') || '', alt: t.content || '' });
          t.meta = { n: figs.length, vis: '（）' };
        }
      }
    }
    if (figs.length) {
      const html = '<div class="figs" aria-label="図">' + figs.map((f, i) =>
        `<figure id="fig${i + 1}"><img src="${esc(f.src)}" alt="${esc(f.alt)}" loading="lazy">` +
        `<figcaption><b>図${num(i + 1)}</b>${esc(f.alt)}</figcaption></figure>`
      ).join('') + '</div>\n';
      const t = new state.Token('html_block', '', 0);
      t.content = html;
      tokens.push(t);
    }
    if (notes.length) {
      const html = (content) => {
        const t = new state.Token('html_block', '', 0);
        t.content = content;
        return t;
      };
      tokens.push(html('<section class="fns" aria-label="注"><ol>'));
      notes.forEach((inline, i) => {
        const n = i + 1;
        linkifyNote(state, inline);
        tokens.push(
          html(`<li id="fn${n}"><a class="fnback" href="#fnr${n}" aria-label="本文の注${n}へ戻る">${num(n)}</a><span class="fnbody">`),
          inline,
          html('</span></li>'),
        );
      });
      tokens.push(html('</ol></section>\n'));
    }
  });

  // 注の中の URL をリンクにする。見せるのは https:// と末尾の / を除いた形
  function linkifyNote(state, inline) {
    const text = (content) => {
      const x = new state.Token('text', '', 0);
      x.content = content;
      return x;
    };
    const out = [];
    let depth = 0;
    for (const t of inline.children) {
      if (t.type === 'link_open') depth++;
      if (t.type === 'link_close') depth--;
      if (t.type !== 'text' || depth > 0) { out.push(t); continue; }
      const s = t.content;
      let last = 0;
      let m;
      URL_RUN.lastIndex = 0;
      while ((m = URL_RUN.exec(s))) {
        let url = m[0].replace(URL_TAIL, '');
        if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1).replace(URL_TAIL, '');
        const href = md.normalizeLink(url);
        if (!md.validateLink(href)) continue;
        if (m.index > last) out.push(text(s.slice(last, m.index)));
        const open = new state.Token('link_open', 'a', 1);
        open.attrs = [['href', href]];
        out.push(open, text(url.replace(/^https?:\/\//, '').replace(/\/$/, '')), new state.Token('link_close', 'a', -1));
        last = m.index + url.length;
      }
      if (last === 0) { out.push(t); continue; }
      if (last < s.length) out.push(text(s.slice(last)));
    }
    inline.children = out;
  }

  md.renderer.rules.note_ref = (tokens, idx) => {
    const { n, first, label } = tokens[idx].meta;
    if (!n) return esc(`[^${label}]`);
    return `<a class="fnref" href="#fn${n}"${first ? ` id="fnr${n}"` : ''} aria-label="注${n}">${num(n)}</a>`;
  };
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const t = tokens[idx];
    if (/^https?:\/\//.test(t.attrGet('href') || '')) {
      t.attrSet('target', '_blank');
      t.attrSet('rel', 'noopener');
    }
    return self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.image = (tokens, idx) => {
    const t = tokens[idx];
    const n = t.meta && t.meta.n;
    if (!n) return esc(t.content || '');
    return `<a class="figref" href="#fig${n}" role="button" aria-haspopup="dialog">（図${num(n)}）</a>`;
  };

  // ---- 地の文：和欧間の空きと、全角英数字の印 ----
  function neighbor(tokens, idx, dir) {
    for (let i = idx + dir; i >= 0 && i < tokens.length; i += dir) {
      const t = tokens[i];
      if (t.type === 'text') {
        if (t.content) return dir < 0 ? t.content.slice(-1) : t.content[0];
        continue;
      }
      if (TRANSPARENT.has(t.type)) continue;
      if (t.meta && t.meta.vis) return dir < 0 ? t.meta.vis.slice(-1) : t.meta.vis[0];
      return '';
    }
    return '';
  }
  md.renderer.rules.text = (tokens, idx) => {
    const s = tokens[idx].content;
    let out = '';
    let last = 0;
    let m;
    RUN.lastIndex = 0;
    while ((m = RUN.exec(s))) {
      out += esc(s.slice(last, m.index));
      const end = m.index + m[0].length;
      const prev = m.index > 0 ? s[m.index - 1] : neighbor(tokens, idx, -1);
      const next = end < s.length ? s[end] : neighbor(tokens, idx, 1);
      if (m[1]) {
        const cls = [];
        if (isJa(prev)) cls.push('ws');
        if (isJa(next)) cls.push('we');
        out += cls.length ? `<span class="${cls.join(' ')}">${esc(m[0])}</span>` : esc(m[0]);
      } else {
        const cls = ['zen'];
        if (isJa(prev)) cls.push('zws');
        if (isJa(next)) cls.push('zwe');
        const han = m[0].replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
        out += `<span class="${cls.join(' ')}" data-han="${esc(han)}">${esc(m[0])}</span>`;
      }
      last = end;
    }
    return out + esc(s.slice(last));
  };

  return md;
}

export const md = createMarkdown();
