// 組方の切り替え、縦組の横スクロール、全角英数字の出し分け、注と図の操作。
// 執筆画面のプレビュー（html に data-preview）でも同じものを使う。
(function () {
  var root = document.documentElement;
  var main = document.getElementById('scroller');
  var ico = document.getElementById('kumi-ico');
  var preview = root.hasAttribute('data-preview');

  function mode() { return root.classList.contains('tate') ? 'tate' : 'yoko'; }

  // 縦組は右端が冒頭。ブラウザによって scrollLeft の向きが違うので、大きな値を入れて右端に寄せる
  function toStart() {
    window.scrollTo(0, 0);
    if (!main) return;
    main.scrollTop = 0;
    main.scrollLeft = mode() === 'tate' ? main.scrollWidth : 0;
  }

  // 全角英数字は縦組で正立させるためのもの。横組では半角に戻して出す
  function zen() {
    var yoko = mode() === 'yoko';
    document.querySelectorAll('.zen').forEach(function (el) {
      if (!el.dataset.zen) el.dataset.zen = el.textContent;
      el.textContent = yoko ? el.dataset.han : el.dataset.zen;
    });
  }

  // 頁をまたいで組方を引き継ぐ。リンクに #tate / #yoko を付け、選択は端末にも覚えておく
  function sync() {
    var m = mode();
    if (ico) {
      var t = m === 'tate' ? '横組に切り替える' : '縦組に切り替える';
      ico.setAttribute('aria-label', t);
      ico.dataset.tip = t;
    }
    if (preview) return;
    document.querySelectorAll('a[data-kumi]').forEach(function (a) {
      a.setAttribute('href', a.getAttribute('href').split('#')[0] + '#' + m);
    });
    try { history.replaceState(null, '', '#' + m); } catch (e) {}
  }

  if (ico) {
    ico.addEventListener('click', function () {
      root.classList.toggle('tate');
      try { localStorage.setItem('kumi', mode()); } catch (e) {}
      sync();
      zen();
      toStart();
    });
  }

  // 縦組ではホイールの縦の動きを横送りにする
  if (main) {
    main.addEventListener('wheel', function (e) {
      if (mode() !== 'tate') return;
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { main.scrollLeft -= e.deltaY; e.preventDefault(); }
    }, { passive: false });
  }

  // ---- 図の窓 ----
  var lb = null, lbImg, lbCap, lbClose, opener = null;
  function buildLightbox() {
    lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.hidden = true;
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.innerHTML =
      '<button type="button" class="lb-close" aria-label="閉じる" title="閉じる"><svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l9 9M13.5 4.5l-9 9"/></svg></button>' +
      '<figure class="lb-fig"><img alt=""><figcaption></figcaption></figure>';
    document.body.appendChild(lb);
    lbImg = lb.querySelector('img');
    lbCap = lb.querySelector('figcaption');
    lbClose = lb.querySelector('.lb-close');
    lb.addEventListener('click', closeFig);
  }
  function openFig(id, from) {
    var fig = document.getElementById(id);
    if (!fig) return;
    if (!lb) buildLightbox();
    var img = fig.querySelector('img');
    var cap = fig.querySelector('figcaption');
    opener = from;
    lbImg.src = img.currentSrc || img.src;
    lbImg.alt = img.alt;
    lbCap.innerHTML = cap ? cap.innerHTML : '';
    lb.setAttribute('aria-label', img.alt || '図');
    lb.hidden = false;
    lbClose.focus();
  }
  function closeFig() {
    if (!lb || lb.hidden) return;
    lb.hidden = true;
    lbImg.removeAttribute('src');
    if (opener) opener.focus({ preventScroll: true });
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeFig(); });

  // ---- 注番号と注、図の参照 ----
  document.addEventListener('click', function (e) {
    var f = e.target.closest('a.figref');
    if (f) {
      e.preventDefault();
      openFig(f.getAttribute('href').slice(1), f);
      return;
    }
    var a = e.target.closest('a.fnref, a.fnback');
    if (a) {
      // 縦組の横スクロールの中でも位置が合うように、自分で寄せる
      var t = document.getElementById(a.getAttribute('href').slice(1));
      if (!t) return;
      e.preventDefault();
      var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
      t.scrollIntoView({ block: 'center', inline: 'center', behavior: reduce ? 'auto' : 'smooth' });
    }
  });

  // 執筆画面のプレビューから呼ぶ
  window.hon = {
    refresh: function () { zen(); },
    toStart: toStart,
  };

  sync();
  zen();
  toStart();
  requestAnimationFrame(toStart);
  window.addEventListener('load', toStart);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(toStart);
})();
