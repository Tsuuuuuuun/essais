// 執筆画面の見たままの編集（ProseMirror）。
// 原稿（Markdown）から文書への変換はサーバー（tools/editor/doc.js）が、文書から原稿への変換はここの toMarkdown がする。
// 見出し、傍点、ルビ、縦中横、引用、箇条書き、注、図は、記号を書かずに編集画面の上で付け外しする。
// 原稿の記号として打った * や { は、原稿に戻すときに逆斜線で打ち消し、書いたとおりの文字として残す。

import { Schema, Fragment, Slice } from 'prosemirror-model';
import { EditorState, Plugin, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView, Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, chainCommands, setBlockType, wrapIn, lift } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { inputRules, InputRule, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list';
import { kanjiNumber } from '/lib/kanji.js';

// ---- 文書の形 ----
// 注の中身（note_def）は本文の後ろにまとめて置く。注番号（note_ref）と図（image）は本文にだけ置ける
export const schema = new Schema({
  nodes: {
    doc: { content: 'block+ note_def*' },
    paragraph: {
      group: 'block', content: '(inline | anchor)*', marks: 'em',
      parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0],
    },
    heading: {
      group: 'block', content: '(inline | anchor)*', marks: 'em', defining: true,
      parseDOM: [1, 2, 3, 4, 5, 6].map((n) => ({ tag: 'h' + n })), toDOM: () => ['h2', 0],
    },
    blockquote: {
      group: 'block', content: 'block+', defining: true,
      parseDOM: [{ tag: 'blockquote' }], toDOM: () => ['blockquote', 0],
    },
    horizontal_rule: {
      group: 'block',
      parseDOM: [{ tag: 'hr' }, { tag: 'div.ed-hr' }], toDOM: () => ['div', { class: 'ed-hr' }, '＊'],
    },
    bullet_list: {
      group: 'block', content: 'list_item+', attrs: { tight: { default: true } },
      parseDOM: [{ tag: 'ul' }], toDOM: () => ['ul', 0],
    },
    ordered_list: {
      group: 'block', content: 'list_item+', attrs: { order: { default: 1 }, tight: { default: true } },
      parseDOM: [{ tag: 'ol', getAttrs: (d) => ({ order: Number(d.getAttribute('start')) || 1 }) }],
      toDOM: (n) => ['ol', n.attrs.order === 1 ? {} : { start: n.attrs.order }, 0],
    },
    list_item: {
      content: 'paragraph block*', defining: true,
      parseDOM: [{ tag: 'li' }], toDOM: () => ['li', 0],
    },
    note_def: {
      content: 'inline*', marks: 'em link', attrs: { label: {} }, defining: true, isolating: true,
      parseDOM: [{ tag: 'div.ed-note', getAttrs: (d) => (d.dataset.label ? { label: d.dataset.label } : false) }],
      toDOM: (n) => ['div', { class: 'ed-note', 'data-label': n.attrs.label }, 0],
    },
    text: { group: 'inline' },
    softbreak: {
      group: 'inline', inline: true, selectable: false,
      parseDOM: [{ tag: 'br' }], toDOM: () => ['br'],
    },
    ruby: {
      group: 'inline', inline: true, atom: true, attrs: { base: {}, reads: { default: '' } },
      parseDOM: [{ tag: 'ruby', getAttrs: rubyAttrs }], toDOM: rubyDOM,
    },
    tcy: {
      group: 'inline', inline: true, atom: true, attrs: { text: {} },
      parseDOM: [{ tag: 'span.ed-tcy', getAttrs: (d) => ({ text: d.textContent }) }],
      toDOM: (n) => ['span', { class: 'ed-tcy' }, n.attrs.text],
    },
    note_ref: {
      group: 'anchor', inline: true, atom: true, attrs: { label: {} },
      parseDOM: [{ tag: 'span.ed-fnref', getAttrs: (d) => (d.dataset.label ? { label: d.dataset.label } : false) }],
      toDOM: (n) => ['span', { class: 'ed-fnref', 'data-label': n.attrs.label }],
    },
    image: {
      group: 'anchor', inline: true, atom: true, draggable: true, attrs: { src: {}, alt: { default: '' } },
      parseDOM: [{ tag: 'span.ed-fig', getAttrs: (d) => (d.dataset.src ? { src: d.dataset.src, alt: d.dataset.alt || '' } : false) }],
      toDOM: (n) => ['span', { class: 'ed-fig', 'data-src': n.attrs.src, 'data-alt': n.attrs.alt, title: n.attrs.alt }],
    },
  },
  marks: {
    em: {
      parseDOM: [{ tag: 'em' }, { tag: 'i' }, { tag: 'strong' }, { tag: 'b' }],
      toDOM: () => ['em', 0],
    },
    // リンクは注の中でだけ使える（本文の [文](URL) はサイトでもリンクにしない）
    link: {
      attrs: { href: {} }, inclusive: false,
      parseDOM: [{ tag: 'a[href]', getAttrs: (d) => ({ href: d.getAttribute('href') }) }],
      toDOM: (m) => ['a', { href: m.attrs.href, title: m.attrs.href }, 0],
    },
  },
});
const N = schema.nodes;
const M = schema.marks;

function rubyDOM(node) {
  const { base, reads } = node.attrs;
  const r = reads.split('|');
  const chars = Array.from(base);
  const out = ['ruby', { class: 'ed-ruby' }];
  if (r.length > 1 && r.length === chars.length) chars.forEach((c, i) => out.push(c, ['rt', r[i]]));
  else out.push(base, ['rt', r.join('')]);
  return out;
}
function rubyAttrs(dom) {
  let base = '';
  const rts = [];
  dom.childNodes.forEach((n) => {
    if (n.nodeName === 'RT') rts.push(n.textContent);
    else if (n.nodeName !== 'RP') base += n.textContent;
  });
  if (!base) return false;
  return { base, reads: rts.length > 1 && rts.length === Array.from(base).length ? rts.join('|') : rts.join('') };
}

// ---- 全角と半角（英数字だけ） ----
const toZen = (s) => s.replace(/[0-9A-Za-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
const toHan = (s) => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// ---- 文書から原稿へ ----
const SOURCE_LINE = /^(――|——|─|--)/;
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[A-Za-z0-9]/;

// 記号として読まれてしまう文字を逆斜線で打ち消す
function escapeText(s, inNote) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const rest = s.slice(i);
    if (c === '\\' && (i === s.length - 1 || ASCII_PUNCT.test(s[i + 1]))) out += '\\\\';
    else if (c === '*') out += '\\*';
    else if (c === '_' && !(ALNUM.test(s[i - 1] || '') && ALNUM.test(s[i + 1] || ''))) out += '\\_';
    else if (c === '{' && /^\{[^{}\n]*\|[^{}\n]*\}/.test(rest)) out += '\\{';
    else if (c === '^' && /^\^[0-9A-Za-z!?]{1,3}\^/.test(rest)) out += '\\^';
    else if (c === '[' && (rest.startsWith('[^') || (inNote && /^\[[^\]]*\]\(/.test(rest)))) out += '\\[';
    else if (c === '!' && s[i + 1] === '[') out += '\\!';
    else if (c === '&' && /^&(?:#\d+|#x[0-9a-f]+|\w+);/i.test(rest)) out += '\\&';
    else out += c;
  }
  return out;
}

// 行頭で見出し・引用・箇条書き・場面の区切りに読まれる形を打ち消す
function escapeLine(line) {
  return line
    .replace(/^(#{1,6})(?=[ \t]|$)/, '\\$1')
    .replace(/^>/, '\\>')
    .replace(/^([-+])(?=[ \t]|$)/, '\\$1')
    .replace(/^-(?=(?:[ \t]*-){2,}[ \t]*$)/, '\\-')
    .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2');
}

const RANK = { link: 0, em: 1 };
function inlineMd(node, inNote) {
  let out = '';
  const active = [];
  const close = (k) => {
    while (active.length > k) {
      const m = active.pop();
      out += m.type === M.em ? '*' : `](${m.attrs.href.replace(/[\s()]/g, encodeURIComponent)})`;
    }
  };
  node.forEach((child) => {
    const marks = child.marks.filter((m) => inNote || m.type !== M.link).sort((a, b) => RANK[a.type.name] - RANK[b.type.name]);
    let k = 0;
    while (k < active.length && k < marks.length && active[k].eq(marks[k])) k++;
    close(k);
    for (; k < marks.length; k++) {
      out += marks[k].type === M.em ? '*' : '[';
      active.push(marks[k]);
    }
    out += leafMd(child, inNote);
  });
  close(0);
  return out;
}

function leafMd(node, inNote) {
  const a = node.attrs;
  switch (node.type) {
    case N.text: return escapeText(node.text, inNote);
    case N.softbreak: return '\n';
    case N.ruby: return a.reads ? `{${a.base}|${a.reads}}` : escapeText(a.base, inNote);
    case N.tcy: return `^${a.text}^`;
    case N.note_ref: return `[^${a.label}]`;
    case N.image: return `![${a.alt.replace(/[[\]\\]/g, '\\$&')}](${a.src.replace(/[\s()]/g, encodeURIComponent)})`;
    default: return '';
  }
}

// 段落の中身を行に分ける。行頭と行末の空白は原稿では意味を持たないので落とす
function lines(node, inNote) {
  return inlineMd(node, inNote).split('\n')
    .map((l) => escapeLine(l.replace(/^[ \t]+|[ \t]+$/g, '')))
    .filter(Boolean);
}

function blockMd(node) {
  switch (node.type) {
    case N.paragraph: {
      const ls = lines(node, false);
      return ls.length ? ls.join('\n') : null;
    }
    case N.heading: {
      const s = lines(node, false).join('');
      return s ? '## ' + s : null;
    }
    case N.horizontal_rule:
      return '---';
    case N.blockquote: {
      let inner = '';
      let prev = null;
      node.forEach((child) => {
        const s = blockMd(child);
        if (s === null) return;
        // 出典の行は前の段落に続けて書く（「> 文」の次の行に「> ――出典」）
        const src = prev && prev.type === N.paragraph && child.type === N.paragraph && SOURCE_LINE.test(child.textContent);
        inner += (inner ? (src ? '\n' : '\n\n') : '') + s;
        prev = child;
      });
      return inner ? inner.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n') : null;
    }
    case N.bullet_list:
    case N.ordered_list: {
      const tight = node.attrs.tight;
      const items = [];
      node.forEach((item, _, i) => {
        const mark = node.type === N.bullet_list ? '- ' : `${node.attrs.order + i}. `;
        const pad = ' '.repeat(mark.length);
        let body = '';
        item.forEach((child) => {
          const s = blockMd(child);
          if (s === null) return;
          const isList = child.type === N.bullet_list || child.type === N.ordered_list;
          body += (body ? (tight && isList ? '\n' : '\n\n') : '') + s;
        });
        const ls = body.split('\n');
        items.push((mark + ls[0]).trimEnd() + ls.slice(1).map((l) => '\n' + (l ? pad + l : '')).join(''));
      });
      return items.join(tight ? '\n' : '\n\n');
    }
    default:
      return null;
  }
}

export function toMarkdown(doc) {
  const used = new Set();
  doc.descendants((n) => { if (n.type === N.note_ref) used.add(n.attrs.label); });
  const blocks = [];
  const notes = [];
  const seen = new Set();
  // 段落と段落の間の空の段落は、その数だけ空行を重ねて残す（頭と末尾、見出しや引用の前後の空の段落は落とす）
  let blank = 0;
  let afterParagraph = false;
  doc.forEach((n) => {
    if (n.type !== N.note_def) {
      const s = blockMd(n);
      if (s === null) {
        if (n.type === N.paragraph) blank++;
        return;
      }
      const isParagraph = n.type === N.paragraph;
      blocks.push((afterParagraph && isParagraph ? '\n'.repeat(blank) : '') + s);
      blank = 0;
      afterParagraph = isParagraph;
      return;
    }
    const { label } = n.attrs;
    // 参照されていない空の注は書き出さない
    if (seen.has(label) || (!used.has(label) && !n.content.size)) return;
    seen.add(label);
    notes.push(`[^${label}]: ` + lines(n, true).join('\n'));
  });
  return [blocks.join('\n\n'), notes.join('\n')].filter(Boolean).join('\n\n');
}

// ---- 番号（見出し・注・図）と、引用の出典 ----
// 番号は縦組の漢数字と横組の算用数字を両方持たせ、CSS で出し分ける
const numAttrs = (n) => ({ 'data-nk': kanjiNumber(n), 'data-na': String(n) });

function notesInfo(doc) {
  const defs = new Map();
  const order = [];
  let start = doc.content.size;
  doc.forEach((n, off) => {
    if (n.type !== N.note_def) return;
    if (start === doc.content.size) start = off;
    if (!defs.has(n.attrs.label)) defs.set(n.attrs.label, off);
  });
  const numbers = new Map();
  doc.descendants((n) => {
    if (n.type === N.note_def) return false;
    if (n.type === N.note_ref && defs.has(n.attrs.label) && !numbers.has(n.attrs.label)) {
      numbers.set(n.attrs.label, numbers.size + 1);
      order.push(n.attrs.label);
    }
  });
  return { defs, numbers, order, start };
}

function decorate(doc) {
  const decos = [];
  const { defs, numbers } = notesInfo(doc);
  const defSeen = new Set();
  let h = 0;
  let f = 0;
  doc.descendants((node, pos, parent) => {
    const end = pos + node.nodeSize;
    switch (node.type) {
      case N.heading:
        decos.push(Decoration.node(pos, end, numAttrs(++h)));
        break;
      case N.image:
        decos.push(Decoration.node(pos, end, numAttrs(++f)));
        break;
      case N.note_ref: {
        const n = numbers.get(node.attrs.label);
        decos.push(Decoration.node(pos, end, n ? numAttrs(n) : { class: 'missing', 'data-nk': '？', 'data-na': '?' }));
        break;
      }
      case N.note_def: {
        const { label } = node.attrs;
        const n = numbers.get(label);
        const dup = defSeen.has(label);
        defSeen.add(label);
        const cls = dup ? 'dup' : n ? '' : 'orphan';
        if (cls) decos.push(Decoration.node(pos, end, { class: cls }));
        decos.push(Decoration.widget(pos + 1, (view) => noteNumber(view, label, n), { side: -1, key: `no:${label}:${n || '-'}`, ignoreSelection: true }));
        return false;
      }
      case N.paragraph:
        if (parent.type === N.blockquote && SOURCE_LINE.test(node.textContent)) decos.push(Decoration.node(pos, end, { class: 'src' }));
        break;
      default:
        break;
    }
  });
  return DecorationSet.create(doc, decos);
}

// 注の頭の番号。押すと本文の注番号に戻る
function noteNumber(view, label, n) {
  const el = document.createElement('span');
  el.className = 'ed-note-no';
  if (n) {
    el.innerHTML = `<span class="nk">${kanjiNumber(n)}</span><span class="na">${n}</span>`;
    el.title = '本文の注番号へ戻る';
  } else {
    el.textContent = '—';
    el.title = '本文から参照されていない注（中身を消すと原稿からも消えます）';
  }
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (n) jumpToRef(view, label);
  });
  return el;
}

function jumpToRef(view, label) {
  let at = null;
  view.state.doc.descendants((n, pos) => {
    if (at !== null) return false;
    if (n.type === N.note_ref && n.attrs.label === label) at = pos;
  });
  if (at === null) return;
  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)).scrollIntoView());
  view.focus();
}
function jumpToNote(view, label) {
  const { defs } = notesInfo(view.state.doc);
  if (!defs.has(label)) return;
  const node = view.state.doc.nodeAt(defs.get(label));
  const at = defs.get(label) + 1 + node.content.size;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)).scrollIntoView());
  view.focus();
}

const numbering = new Plugin({
  state: {
    init: (_, state) => decorate(state.doc),
    apply: (tr, set) => (tr.docChanged ? decorate(tr.doc) : set),
  },
  props: {
    decorations(state) { return this.getState(state); },
  },
});

// ---- 書き換えのあとの片付け ----
// ・読みの無いルビは、選択を外れたら親字だけの文字に戻す
// ・注の中身は、本文で参照する順に並べ替える（注の中を書いている間は動かさない）
const tidy = new Plugin({
  appendTransaction(trs, _, state) {
    if (!trs.some((t) => t.docChanged || t.selectionSet)) return null;
    const tr = state.tr;
    const sel = state.selection;
    const bare = [];
    state.doc.descendants((n, pos) => {
      if (n.type === N.note_def) return false;
      if (n.type === N.ruby && !n.attrs.reads && !(sel instanceof NodeSelection && sel.from === pos)) bare.push([pos, n]);
    });
    for (const [pos, n] of bare.reverse()) tr.replaceWith(pos, pos + 1, schema.text(n.attrs.base, n.marks));

    const doc = tr.doc;
    const { order, start } = notesInfo(doc);
    if (start < doc.content.size && !(tr.selection.from >= start)) {
      const notes = [];
      doc.forEach((n, off) => { if (off >= start) notes.push(n); });
      const rank = (n) => { const i = order.indexOf(n.attrs.label); return i < 0 ? Infinity : i; };
      const sorted = notes.map((n, i) => [n, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
      if (sorted.some((n, i) => n !== notes[i])) tr.replaceWith(start, doc.content.size, sorted);
    }
    return tr.docChanged ? tr : null;
  },
});

// ---- 選んだルビ・縦中横・図を直す小窓 ----
const FIELDS = {
  ruby: [
    ['base', '親字'],
    ['reads', '読み', '一字ずつ振るときは｜か | で区切る（とう|きょう）'],
  ],
  tcy: [['text', '縦中横', '半角の英数字三字まで']],
  image: [['alt', '説明']],
};
const REMOVE = { ruby: 'ルビを外す', tcy: '縦中横を外す', image: '図を外す' };

function cleanAttr(type, key, v) {
  if (type === 'ruby' && key === 'base') return v.replace(/[{}|｜\n]/g, '');
  if (type === 'ruby' && key === 'reads') return v.replace(/｜/g, '|').replace(/[{}\n]/g, '');
  if (type === 'tcy') return toHan(v).replace(/[^0-9A-Za-z!?]/g, '').slice(0, 3);
  return v.replace(/\n/g, ' ');
}

class Inspector {
  constructor(view, opts) {
    this.view = view;
    this.opts = opts;
    this.el = document.createElement('div');
    this.el.className = 'ed-inspect';
    this.el.hidden = true;
    this.el.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(this.el);
    this.key = null;
    this.reposition = () => this.place();
    window.addEventListener('scroll', this.reposition, true);
    window.addEventListener('resize', this.reposition);
  }
  update(view) {
    const sel = view.state.selection;
    const node = sel instanceof NodeSelection ? sel.node : null;
    if (!node || !FIELDS[node.type.name]) { this.hide(); return; }
    this.pos = sel.from;
    const key = node.type.name + ':' + sel.from;
    if (key !== this.key) this.build(node);
    else this.sync(node);
    this.place();
  }
  build(node) {
    const type = node.type.name;
    this.key = type + ':' + this.pos;
    this.el.innerHTML = '';
    this.inputs = {};
    if (type === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.src = /^(?:[a-z]+:|\/)/i.test(node.attrs.src) ? node.attrs.src : this.opts.imageBase() + node.attrs.src;
      this.el.appendChild(img);
    }
    for (const [key, label, hint] of FIELDS[type]) {
      const l = document.createElement('label');
      const s = document.createElement('span');
      s.textContent = label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = node.attrs[key];
      input.spellcheck = false;
      input.addEventListener('input', () => this.set(key, input.value));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); this.done(); }
      });
      l.append(s, input);
      this.el.appendChild(l);
      if (hint) {
        const h = document.createElement('small');
        h.textContent = hint;
        this.el.appendChild(h);
      }
      this.inputs[key] = input;
    }
    if (type === 'image') {
      const s = document.createElement('small');
      s.className = 'mono';
      s.textContent = node.attrs.src;
      this.el.appendChild(s);
    }
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = REMOVE[type];
    rm.addEventListener('click', () => this.remove());
    this.el.appendChild(rm);
    this.el.hidden = false;
    // 付けたばかりのルビは、すぐに読みを打てるようにする
    if (type === 'ruby' && !node.attrs.reads) requestAnimationFrame(() => this.inputs.reads.focus());
  }
  sync(node) {
    for (const k in this.inputs) {
      const input = this.inputs[k];
      if (document.activeElement !== input && input.value !== node.attrs[k]) input.value = node.attrs[k];
    }
  }
  set(key, raw) {
    const { state } = this.view;
    const node = state.doc.nodeAt(this.pos);
    if (!node) return;
    const v = cleanAttr(node.type.name, key, raw);
    if (!v && key !== 'reads' && key !== 'alt') return;
    if (v === node.attrs[key]) return;
    const tr = state.tr.setNodeMarkup(this.pos, null, { ...node.attrs, [key]: v });
    tr.setSelection(NodeSelection.create(tr.doc, this.pos));
    this.view.dispatch(tr);
  }
  done() {
    const { state } = this.view;
    this.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, this.pos + 1)));
    this.view.focus();
  }
  remove() {
    const { state } = this.view;
    const node = state.doc.nodeAt(this.pos);
    const tr = state.tr;
    if (node.type === N.image) tr.delete(this.pos, this.pos + 1);
    else tr.replaceWith(this.pos, this.pos + 1, schema.text(node.type === N.ruby ? node.attrs.base : node.attrs.text, node.marks));
    this.view.dispatch(tr);
    this.view.focus();
  }
  place() {
    if (this.el.hidden) return;
    const dom = this.view.nodeDOM(this.pos);
    if (!dom || !dom.getBoundingClientRect) return;
    const r = dom.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const tate = getComputedStyle(this.view.dom).writingMode.startsWith('vertical');
    // 縦組では文字の左、横組では文字の下に出す
    let x = tate ? r.left - w - 10 : r.left;
    let y = tate ? r.top : r.bottom + 10;
    if (tate && x < 8) x = r.right + 10;
    if (!tate && y + h > innerHeight - 8) y = r.top - h - 10;
    this.el.style.left = Math.max(8, Math.min(x, innerWidth - w - 8)) + 'px';
    this.el.style.top = Math.max(8, Math.min(y, innerHeight - h - 8)) + 'px';
  }
  hide() {
    this.el.hidden = true;
    this.key = null;
  }
  destroy() {
    window.removeEventListener('scroll', this.reposition, true);
    window.removeEventListener('resize', this.reposition);
    this.el.remove();
  }
}

// ---- 命令 ----
const inNote = (state) => state.selection.$from.node(1)?.type === N.note_def;
const EDGE = /[\s\p{P}]/u;

// 傍点。選んだ範囲の端の句読点や括弧には付けない（原稿で *「語」* と書くと強調にならないため）
function toggleEm(state, dispatch) {
  const { from, to, empty } = state.selection;
  if (empty) {
    if (dispatch) {
      const marks = state.storedMarks || state.selection.$from.marks();
      dispatch(M.em.isInSet(marks) ? state.tr.removeStoredMark(M.em) : state.tr.addStoredMark(M.em.create()));
    }
    return true;
  }
  let a = from;
  let b = to;
  const at = (p) => state.doc.textBetween(p, p + 1, '\n', '\ufffc');
  while (a < b && EDGE.test(at(a))) a++;
  while (b > a && EDGE.test(at(b - 1))) b--;
  if (a === b) return false;
  if (dispatch) {
    const has = state.doc.rangeHasMark(a, b, M.em);
    dispatch((has ? state.tr.removeMark(from, to, M.em) : state.tr.addMark(a, b, M.em.create())).scrollIntoView());
  }
  return true;
}

function toggleHeading(state, dispatch) {
  const { $from } = state.selection;
  if ($from.parent.type === N.heading) return setBlockType(N.paragraph)(state, dispatch);
  return setBlockType(N.heading)(state, dispatch);
}

function toggleQuote(state, dispatch) {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === N.blockquote) return lift(state, dispatch);
  return wrapIn(N.blockquote)(state, dispatch);
}

function toggleList(type) {
  return (state, dispatch) => {
    const { $from } = state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type === type) return liftListItem(N.list_item)(state, dispatch);
      if (n.type === N.bullet_list || n.type === N.ordered_list) {
        if (dispatch) dispatch(state.tr.setNodeMarkup($from.before(d), type, type === N.ordered_list ? { order: 1, tight: n.attrs.tight } : { tight: n.attrs.tight }));
        return true;
      }
    }
    return wrapInList(type)(state, dispatch);
  };
}

function insertRule(state, dispatch) {
  if (inNote(state)) return false;
  const { $from } = state.selection;
  if (dispatch) {
    const tr = state.tr;
    // 空の段落なら段落ごと区切りに置き換える。文の途中なら、そこで段落を分ける
    if ($from.parent.type === N.paragraph && !$from.parent.content.size) {
      tr.replaceWith($from.before(), $from.after(), [N.horizontal_rule.create(), N.paragraph.create()]);
      tr.setSelection(TextSelection.create(tr.doc, $from.before() + 2));
    } else {
      tr.replaceSelectionWith(N.horizontal_rule.create());
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function plainSelection(state) {
  const { from, to, empty, $from, $to } = state.selection;
  if (empty || !(state.selection instanceof TextSelection) || $from.parent !== $to.parent) return null;
  let plain = true;
  state.doc.nodesBetween(from, to, (n) => { if (n.isInline && !n.isText) plain = false; });
  return plain ? state.doc.textBetween(from, to) : null;
}

function makeRuby(state, dispatch) {
  if (state.selection instanceof NodeSelection && state.selection.node.type === N.ruby) return true;
  const text = plainSelection(state);
  if (!text || /[{}|\n]/.test(text)) return false;
  if (dispatch) {
    const { from, to, $from } = state.selection;
    const tr = state.tr.replaceWith(from, to, N.ruby.create({ base: text, reads: '' }, null, $from.marksAcross(state.selection.$to) || []));
    dispatch(tr.setSelection(NodeSelection.create(tr.doc, from)));
  }
  return true;
}

function makeTcy(state, dispatch) {
  if (state.selection instanceof NodeSelection && state.selection.node.type === N.tcy) return true;
  const text = plainSelection(state);
  const han = text && toHan(text);
  if (!han || !/^[0-9A-Za-z!?]{1,3}$/.test(han)) return false;
  if (dispatch) {
    const { from, to, $from } = state.selection;
    const tr = state.tr.replaceWith(from, to, N.tcy.create({ text: han }, null, $from.marksAcross(state.selection.$to) || []));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, from + 1)).scrollIntoView());
  }
  return true;
}

// 選んだ範囲の英数字を、半角が混じっていれば全角に、そうでなければ半角にする
function toggleWidth(state, dispatch) {
  const { from, to, empty } = state.selection;
  if (empty) return false;
  const text = state.doc.textBetween(from, to, '');
  const conv = /[0-9A-Za-z]/.test(text) ? toZen : toHan;
  if (conv(text) === text) return false;
  if (dispatch) {
    const tr = state.tr;
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (!node.isText) return;
      const a = Math.max(from, pos);
      const b = Math.min(to, pos + node.nodeSize);
      const s = node.text.slice(a - pos, b - pos);
      const c = conv(s);
      if (c !== s) tr.replaceWith(tr.mapping.map(a), tr.mapping.map(b), schema.text(c, node.marks));
    });
    tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(from, -1), tr.mapping.map(to)));
    dispatch(tr);
  }
  return true;
}

// 注。カーソルの位置に注番号を置き、末尾の注に中身の欄を作って、そこへ移る
function insertNote(state, dispatch) {
  if (inNote(state)) return false;
  if (dispatch) {
    const used = new Set();
    state.doc.descendants((n) => { if (n.type === N.note_ref || n.type === N.note_def) used.add(n.attrs.label); });
    let k = 1;
    while (used.has(String(k))) k++;
    const label = String(k);
    const tr = state.tr;
    tr.setSelection(TextSelection.create(tr.doc, state.selection.to));
    tr.replaceSelectionWith(N.note_ref.create({ label }), true);
    // 中身の欄は、本文で参照する順の位置に置く（参照されていない注よりは前）
    const order = [];
    tr.doc.descendants((n) => {
      if (n.type === N.note_def) return false;
      if (n.type === N.note_ref && !order.includes(n.attrs.label)) order.push(n.attrs.label);
    });
    const after = new Set(order.slice(order.indexOf(label) + 1));
    let at = tr.doc.content.size;
    let found = false;
    tr.doc.forEach((n, off) => {
      if (found || n.type !== N.note_def) return;
      if (after.has(n.attrs.label) || !order.includes(n.attrs.label)) { at = off; found = true; }
    });
    tr.insert(at, N.note_def.create({ label }));
    tr.setSelection(TextSelection.create(tr.doc, at + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
}

function insertSoftbreak(state, dispatch) {
  if (dispatch) dispatch(state.tr.replaceSelectionWith(N.softbreak.create()).scrollIntoView());
  return true;
}

// 注の中では、改行は段落を分けずに行を送る。注の頭で消しても前の注とつながらないようにする（空の注は消す）
function noteEnter(state, dispatch) {
  return inNote(state) ? insertSoftbreak(state, dispatch) : false;
}
function noteBackspace(state, dispatch) {
  const { $cursor } = state.selection;
  if (!$cursor || $cursor.parent.type !== N.note_def || $cursor.parentOffset > 0) return false;
  if (!$cursor.parent.content.size && dispatch) {
    const tr = state.tr.delete($cursor.before(), $cursor.after());
    dispatch(tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, $cursor.before() - 1)), -1)));
  }
  return true;
}
function noteDelete(state) {
  const { $cursor } = state.selection;
  if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size) return false;
  const top = $cursor.index(0);
  const next = state.doc.maybeChild(top + 1);
  return $cursor.depth === 1 ? !!next && next.type === N.note_def : $cursor.node(1).type === N.note_def;
}
function headingBackspace(state, dispatch) {
  const { $cursor } = state.selection;
  if (!$cursor || $cursor.parent.type !== N.heading || $cursor.parentOffset > 0) return false;
  return setBlockType(N.paragraph)(state, dispatch);
}

export const commands = {
  heading: toggleHeading,
  em: toggleEm,
  ruby: makeRuby,
  tcy: makeTcy,
  width: toggleWidth,
  quote: toggleQuote,
  bullet: toggleList(N.bullet_list),
  ordered: toggleList(N.ordered_list),
  rule: insertRule,
  note: insertNote,
};

// ---- 打ち方の約束（行頭の ## や > や - で、見出し・引用・箇条書きになる） ----
// 日本語入力のままでも効くように、全角の記号と全角の空白も受け付ける
function ruleRule() {
  return new InputRule(/^(?:---|ーーー|－－－|＊＊＊|\*\*\*)$/, (state, _m, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.parent.type !== N.paragraph || start !== $start.start() || end !== $start.end()) return null;
    const tr = state.tr.replaceWith($start.before(), $start.after(), [N.horizontal_rule.create(), N.paragraph.create()]);
    return tr.setSelection(TextSelection.create(tr.doc, $start.before() + 2));
  });
}
const rules = inputRules({
  rules: [
    textblockTypeInputRule(/^[#＃]{2}[ \u3000]$/, N.heading),
    wrappingInputRule(/^[>＞][ \u3000]$/, N.blockquote),
    wrappingInputRule(/^[-*+・－][ \u3000]$/, N.bullet_list),
    wrappingInputRule(/^([0-9０-９]+)[.．][ \u3000]$/, N.ordered_list,
      (m) => ({ order: Number(toHan(m[1])) }),
      (m, node) => node.childCount + node.attrs.order === Number(toHan(m[1]))),
    ruleRule(),
  ],
});

// 貼り付けた文字は、空行で段落を分け、一つの改行は段落の中の改行として読む。重ねた空行は空の段落にする
function parseClipboardText(text, $context) {
  const para = (s) => {
    const inline = [];
    s.split('\n').forEach((l, i) => {
      if (i) inline.push(N.softbreak.create());
      if (l) inline.push(schema.text(l));
    });
    return inline;
  };
  const parts = text.replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '').split(/(\n{2,})/);
  const chunks = parts.filter((_, i) => i % 2 === 0);
  if ($context.parent.type === N.note_def || $context.parent.type === N.heading) {
    return new Slice(Fragment.from(para(chunks.join('\n'))), 0, 0);
  }
  const paragraphs = parts.flatMap((c, i) => (i % 2 === 0
    ? [N.paragraph.create(null, para(c))]
    : Array.from({ length: c.length - 2 }, () => N.paragraph.create())));
  return new Slice(Fragment.from(paragraphs), 1, 1);
}

// ---- 編集画面 ----
// onChange: 文書が変わったとき。onUpdate: 選択が動いたときも（道具の押された状態を直す）
// onFiles: 画像を落としたり貼り付けたりしたとき。imageBase: 図の画像の置き場所
export function createEditor(mount, { onChange, onUpdate, onFiles, imageBase }) {
  let inspector = null;
  const plugins = [
    rules,
    keymap({
      'Mod-z': undo, 'Shift-Mod-z': redo, 'Mod-y': redo,
      'Mod-b': toggleEm, 'Mod-i': toggleEm,
      'Shift-Enter': insertSoftbreak,
      Enter: chainCommands(noteEnter, splitListItem(N.list_item)),
      Backspace: chainCommands(noteBackspace, headingBackspace),
      Delete: noteDelete,
      Tab: sinkListItem(N.list_item),
      'Shift-Tab': liftListItem(N.list_item),
    }),
    keymap(baseKeymap),
    history(),
    numbering,
    tidy,
    new Plugin({ view: (v) => (inspector = new Inspector(v, { imageBase })) }),
  ];
  const stateFor = (json) => EditorState.create({ doc: schema.nodeFromJSON(json), plugins });

  const view = new EditorView(mount, {
    state: stateFor({ type: 'doc', content: [{ type: 'paragraph' }] }),
    attributes: { 'aria-label': '本文', spellcheck: 'false' },
    clipboardTextParser: parseClipboardText,
    dispatchTransaction(tr) {
      view.updateState(view.state.apply(tr));
      if (tr.docChanged) onChange();
      onUpdate();
    },
    handleClickOn(v, _pos, node, _nodePos, _e, direct) {
      if (!direct || node.type !== N.note_ref) return false;
      jumpToNote(v, node.attrs.label);
      return true;
    },
    handlePaste(_v, e) {
      return onFiles(e.clipboardData && e.clipboardData.files);
    },
    handleDrop(v, e) {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return false;
      const at = v.posAtCoords({ left: e.clientX, top: e.clientY });
      if (at) v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, at.pos)));
      return onFiles(files);
    },
  });

  return {
    view,
    load(json) {
      view.updateState(stateFor(json));
      onUpdate();
    },
    markdown: () => toMarkdown(view.state.doc),
    run(name) {
      const ok = commands[name](view.state, view.dispatch, view);
      view.focus();
      return ok;
    },
    // 道具の押された状態
    active() {
      const { state } = view;
      const { $from } = state.selection;
      const has = (type) => { for (let d = $from.depth; d > 0; d--) if ($from.node(d).type === type) return true; return false; };
      let list = null;
      for (let d = $from.depth; d > 0 && !list; d--) {
        const t = $from.node(d).type;
        if (t === N.bullet_list || t === N.ordered_list) list = t;
      }
      const sel = state.selection;
      const em = sel.empty ? !!M.em.isInSet(state.storedMarks || $from.marks()) : state.doc.rangeHasMark(sel.from, sel.to, M.em);
      const node = sel instanceof NodeSelection ? sel.node.type : null;
      return {
        heading: $from.parent.type === N.heading,
        em,
        ruby: node === N.ruby,
        tcy: node === N.tcy,
        quote: has(N.blockquote),
        bullet: list === N.bullet_list,
        ordered: list === N.ordered_list,
        note: inNote(state),
      };
    },
    insertImage(src, alt) {
      const { state } = view;
      if (inNote(state)) return;
      view.dispatch(state.tr.replaceSelectionWith(N.image.create({ src, alt }), true).scrollIntoView());
    },
    focus: () => view.focus(),
    refresh: () => inspector && inspector.place(),
  };
}
