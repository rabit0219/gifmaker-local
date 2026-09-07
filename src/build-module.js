// 움짤 메이커 part 파일들 -> 갤러리(dc-board-local)에 심을 모듈 블록 생성.
// 갤러리 index.html 의 GIFMAKER:BEGIN/END 마커 사이만 교체하므로 몇 번 돌려도 안전하다.
// 움짤 메이커를 고친 뒤 이 스크립트를 다시 돌리면 갤러리에도 그대로 반영된다.
const fs = require('fs');
const path = require('path');

const SP = __dirname;                                 // src/
const GALLERY = 'C:/Users/USER/dc-board-local/index.html';
const BEGIN = '<!-- GIFMAKER:BEGIN -->';
const END = '<!-- GIFMAKER:END -->';

const read = (f) => fs.readFileSync(path.join(SP, f), 'utf8');

/* ---------- part1.html 에서 CSS 와 마크업 분리 ---------- */
const p1 = read('part1.html');

const css = p1.slice(p1.indexOf('<style>') + 7, p1.indexOf('</style>')).trim();
if (!css) throw new Error('CSS 추출 실패');

const bodyStart = p1.indexOf('<body>') + 6;
const bodyEnd = p1.indexOf('<script>');
if (bodyStart < 6 || bodyEnd < 0) throw new Error('마크업 추출 실패');
const markup = p1.slice(bodyStart, bodyEnd).trim();
if (!/id="drop"/.test(markup) || !/id="btnAttach"/.test(markup)) throw new Error('마크업 내용 이상');

/* shadow root 안에서 돌리므로 선택자는 그대로 두고 body 규칙만 래퍼로 옮긴다 */
if (!/^body \{/m.test(css)) throw new Error('body 규칙을 찾지 못함');
const scopedCss = ':host { display: block; }\n' + css.replace(/^body \{/m, '.gm-page {');
if (/^body \{/m.test(scopedCss)) throw new Error('body 규칙 치환 실패');

/* ---------- JS: gifenc + wasm + gmInit ---------- */
const gifencOpen = 'var gifenc = (function () { var exports = {};';
const js = [
  gifencOpen,
  read('gifenc.js'),
  read('part-wasm.js'),      // "return exports; })();" 로 시작해 위 IIFE 를 닫는다
  read('part2.html'),        // function gmInit(root, opts) { ... }
].join('\n');

if (!/function gmInit\(root, opts\)/.test(js)) throw new Error('gmInit 를 찾지 못함');
if (/document\.getElementById\(id\)/.test(js)) throw new Error('$ 헬퍼가 아직 document 를 씀');

/* ---------- 모듈 블록 ---------- */
const block = `${BEGIN}
<!-- 이 블록은 build-module.js 가 gifmaker-local 소스에서 생성합니다. 직접 고치지 마세요.
     움짤 메이커를 수정했으면 build-module.js 를 다시 실행하세요. -->
<template id="gm-tpl">
<style>
${scopedCss}
</style>
<div class="gm-page">
${markup}
</div>
</template>
<script>
/* 움짤 메이커를 shadow DOM 안에서 돌린다. 갤러리와 CSS·ID 가 섞이지 않는다. */
window.GifMaker = (function () {
'use strict';

${js}

var ov = null, mount = null, root = null, api = null, resolveOpen = null;

/* 오버레이 껍데기는 모듈이 직접 만든다 (호스트는 버튼 하나만 붙이면 된다).
   gm- 접두사라 갤러리 클래스와 겹치지 않는다. */
var OV_CSS =
  '.gm-ov{position:fixed;inset:0;z-index:500;background:#14161a;display:flex;flex-direction:column}' +
  '.gm-ov[hidden]{display:none}' +
  '.gm-bar{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:10px;' +
  'padding:12px 14px;background:#1c1f26;border-bottom:1px solid #262a33;color:#e6e8ec;' +
  'font:600 15px/1.4 "Malgun Gothic",-apple-system,"Segoe UI",sans-serif}' +
  '.gm-close{background:#262b34;color:#c3c9d4;border:0;border-radius:8px;padding:9px 16px;' +
  'font:600 14px/1 inherit;cursor:pointer}' +
  '.gm-close:hover{background:#303643}' +
  '.gm-mount{flex:1 1 auto;overflow-y:auto;-webkit-overflow-scrolling:touch}';

function ensure() {
  if (root) return;
  var st = document.createElement('style');
  st.textContent = OV_CSS;
  document.head.appendChild(st);

  ov = document.createElement('div');
  ov.className = 'gm-ov';
  ov.hidden = true;
  ov.innerHTML =
    '<div class="gm-bar"><span>움짤 만들어 첨부</span>' +
    '<button type="button" class="gm-close">닫기</button></div>' +
    '<div class="gm-mount"></div>';
  document.body.appendChild(ov);
  ov.querySelector('.gm-close').addEventListener('click', function () { done(null); });

  mount = ov.querySelector('.gm-mount');
  root = mount.attachShadow({ mode: 'open' });
  root.appendChild(document.getElementById('gm-tpl').content.cloneNode(true));
  api = gmInit(root, {
    compact: true,
    onAttach: function (r) { done(r); }
  });
}

function onKey(e) { if (e.key === 'Escape') done(null); }

function done(result) {
  if (ov) ov.hidden = true;
  document.documentElement.style.overflow = '';
  document.removeEventListener('keydown', onKey);
  if (api) api.stopPreview();
  var fn = resolveOpen; resolveOpen = null;
  if (fn) fn(result || null);
}

return {
  /* 오버레이를 띄우고 [게시물에 첨부] 를 누를 때까지 기다린다.
     닫으면 null, 첨부하면 { blob, name, mime } */
  open: function () {
    return new Promise(function (resolve) {
      try { ensure(); } catch (e) { resolve(null); throw e; }
      if (api && api.reset) api.reset();
      resolveOpen = resolve;
      ov.hidden = false;
      document.documentElement.style.overflow = 'hidden';
      document.addEventListener('keydown', onKey);
      mount.scrollTop = 0;
    });
  },
  cancel: function () { done(null); }
};
})();
</script>
${END}`;

/* ---------- 갤러리에 주입 ---------- */
let g = fs.readFileSync(GALLERY, 'utf8');
let mode;
if (g.includes(BEGIN) && g.includes(END)) {
  const a = g.indexOf(BEGIN), b = g.indexOf(END) + END.length;
  g = g.slice(0, a) + block + g.slice(b);
  mode = '교체';
} else {
  const anchor = '</body>';
  const at = g.lastIndexOf(anchor);
  if (at < 0) throw new Error('</body> 를 찾지 못함');
  g = g.slice(0, at) + block + '\n' + g.slice(at);
  mode = '신규 삽입';
}
fs.writeFileSync(GALLERY, g);

console.log('CSS      :', scopedCss.length, 'bytes');
console.log('마크업   :', markup.length, 'bytes');
console.log('JS       :', js.length, 'bytes');
console.log('블록     :', block.length, 'bytes');
console.log('갤러리   :', mode, '->', fs.statSync(GALLERY).size, 'bytes');
