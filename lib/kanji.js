// 漢数字の変換。日付は奥付に、番号は縦組の注番号・図番号に使う。

const DIGITS = '〇一二三四五六七八九';

/** 一桁ずつ置き換える（二〇二六 のような年の書き方） */
export function kanjiDigits(n) {
  return String(n).replace(/[0-9]/g, (d) => DIGITS[+d]);
}

/** 十を使う書き方（十、二十四）。百以上は一桁ずつに戻す */
export function kanjiNumber(n) {
  n = Number(n);
  if (n < 10) return DIGITS[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return (t > 1 ? DIGITS[t] : '') + '十' + (o ? DIGITS[o] : '');
  }
  return kanjiDigits(n);
}

/** 2026-10-24 → 二〇二六年十月二十四日 */
export function kanjiDate(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return (
    kanjiDigits(d.getUTCFullYear()) + '年' +
    kanjiNumber(d.getUTCMonth() + 1) + '月' +
    kanjiNumber(d.getUTCDate()) + '日'
  );
}
