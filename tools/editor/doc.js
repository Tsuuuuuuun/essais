// 原稿（Markdown）を、執筆画面の見たままの編集（ProseMirror）の文書に変える。
// 読み方はサイトと同じ（lib/markdown.js）。番号振りと注・図のまとめは編集画面の側でするので止めておく。
// 和欧間のスペースも取り除かない（原稿に戻したときに、書いたとおりの空白を残す。サイトでは組むときに取り除く）。
// 文書の形（スキーマ）と、文書から原稿に戻す処理は tools/editor/wysiwyg.js にある。
//
// 文書の形
//   doc        本文の塊のあとに、注（note_def）を並べる
//   塊         paragraph / heading / blockquote / horizontal_rule / bullet_list / ordered_list
//   文の中     text（傍点は em の印、注の中のリンクは link の印）/ ruby / tcy / note_ref / image / softbreak

import { createMarkdown } from '../../lib/markdown.js';

const md = createMarkdown();
md.core.ruler.disable(['wa-space', 'notes-and-figures', 'heading-number', 'list-marks']);

export function toDoc(src) {
  const tokens = md.parse(String(src || ''), {});
  const defs = new Map(); // 名前 → 注の中身
  const pos = { i: 0 };
  const blocks = readBlocks(tokens, pos, null, defs);
  const refs = [];
  collectRefs(blocks, refs);

  // 中身の無い注番号は書いたとおりの文字に戻す
  const known = new Set(defs.keys());
  unknownRefsToText(blocks, known);

  // 注は本文で初めて参照した順に並べ、参照されていない注はその後ろに置く
  const notes = [];
  const seen = new Set();
  for (const label of refs) {
    if (!known.has(label) || seen.has(label)) continue;
    seen.add(label);
    notes.push(note(label, defs.get(label)));
  }
  for (const [label, content] of defs) if (!seen.has(label)) notes.push(note(label, content));

  if (!blocks.length) blocks.push({ type: 'paragraph' });
  return { type: 'doc', content: [...blocks, ...notes] };
}

function note(label, content) {
  return content.length ? { type: 'note_def', attrs: { label }, content } : { type: 'note_def', attrs: { label } };
}

const CLOSE = {
  paragraph_open: 'paragraph_close',
  heading_open: 'heading_close',
  blockquote_open: 'blockquote_close',
  bullet_list_open: 'bullet_list_close',
  ordered_list_open: 'ordered_list_close',
  list_item_open: 'list_item_close',
};

function readBlocks(tokens, pos, close, defs) {
  const out = [];
  while (pos.i < tokens.length) {
    const t = tokens[pos.i++];
    if (t.type === close) break;
    switch (t.type) {
      case 'paragraph_open':
      case 'heading_open': {
        const inline = tokens[pos.i].type === 'inline' ? tokens[pos.i++] : null;
        pos.i++; // _close
        const content = inline ? readInline(inline.children, false) : [];
        const node = { type: t.type === 'heading_open' ? 'heading' : 'paragraph' };
        if (content.length) node.content = content;
        out.push(node);
        break;
      }
      case 'blockquote_open': {
        const content = readBlocks(tokens, pos, CLOSE[t.type], defs);
        out.push({ type: 'blockquote', content: content.length ? content : [{ type: 'paragraph' }] });
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const items = readBlocks(tokens, pos, CLOSE[t.type], defs);
        // 項目の中の段落が隠されている（hidden）一覧は、詰めて書く一覧
        const node = { type: t.type === 'bullet_list_open' ? 'bullet_list' : 'ordered_list', attrs: { tight: isTight(tokens, t) }, content: items };
        if (node.type === 'ordered_list') node.attrs.order = Number(t.attrGet('start') || 1);
        out.push(node);
        break;
      }
      case 'list_item_open': {
        const content = readBlocks(tokens, pos, CLOSE[t.type], defs);
        if (!content.length || content[0].type !== 'paragraph') content.unshift({ type: 'paragraph' });
        out.push({ type: 'list_item', content });
        break;
      }
      case 'hr':
        out.push({ type: 'horizontal_rule' });
        break;
      case 'note_def_open': {
        const inline = tokens[pos.i++];
        pos.i++; // note_def_close
        if (!defs.has(t.meta.label)) defs.set(t.meta.label, readInline(inline.children, true));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function isTight(tokens, open) {
  const level = open.level + 2;
  for (let i = tokens.indexOf(open) + 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.level < open.level + 1 && t.type.endsWith('_close')) break;
    if (t.type === 'paragraph_open' && t.level === level) return !!t.hidden;
  }
  return true;
}

function readInline(children, inNote) {
  const out = [];
  const marks = [];
  const add = (node) => {
    if (marks.length) node.marks = marks.map((m) => ({ ...m }));
    out.push(node);
  };
  const text = (s) => { if (s) add({ type: 'text', text: s }); };
  const drop = (type) => {
    const k = marks.findLastIndex((m) => m.type === type);
    if (k >= 0) marks.splice(k, 1);
  };
  for (const t of children || []) {
    switch (t.type) {
      case 'text':
      case 'text_special':
        text(t.content);
        break;
      case 'em_open':
      case 'strong_open':
        marks.push({ type: 'em' });
        break;
      case 'em_close':
      case 'strong_close':
        drop('em');
        break;
      // リンクは注の中でだけ読まれる
      case 'link_open':
        marks.push({ type: 'link', attrs: { href: t.attrGet('href') || '' } });
        break;
      case 'link_close':
        drop('link');
        break;
      case 'softbreak':
      case 'hardbreak':
        add({ type: 'softbreak' });
        break;
      case 'ruby':
        add({ type: 'ruby', attrs: { base: t.meta.base, reads: t.meta.reads.join('|') } });
        break;
      case 'tcy':
        add({ type: 'tcy', attrs: { text: t.content } });
        break;
      case 'note_ref':
        if (inNote) text(`[^${t.meta.label}]`);
        else add({ type: 'note_ref', attrs: { label: t.meta.label } });
        break;
      case 'image':
        if (inNote) text(t.content || '');
        else add({ type: 'image', attrs: { src: t.attrGet('src') || '', alt: t.content || '' } });
        break;
      default:
        text(t.content);
        break;
    }
  }
  // *語* の中の **語** のような重なりは一つにする
  for (const n of out) {
    if (!n.marks) continue;
    const seen = new Set();
    n.marks = n.marks.filter((m) => !seen.has(m.type) && seen.add(m.type));
  }
  return out;
}

function collectRefs(nodes, refs) {
  for (const n of nodes) {
    if (n.type === 'note_ref') refs.push(n.attrs.label);
    if (n.content) collectRefs(n.content, refs);
  }
}

function unknownRefsToText(nodes, known) {
  for (const n of nodes) {
    if (!n.content) continue;
    n.content = n.content.map((c) => (c.type === 'note_ref' && !known.has(c.attrs.label)
      ? { type: 'text', text: `[^${c.attrs.label}]` } : c));
    unknownRefsToText(n.content, known);
  }
}
