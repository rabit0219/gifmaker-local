// src/ 의 조각들을 이어붙여 ../index.html 을 만든다.
//   node src/build.js
// 조각을 나눠 둔 이유: part-wasm.js 가 414KB(libwebp base64)라 한 파일로 두면
// 편집기에서 다루기 힘들고, 갤러리용 모듈(build-module.js)도 같은 조각을 재사용한다.
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const OUT = path.join(SRC, '..', 'index.html');
const PARTS = [
  'part1.html',      // <head> + CSS + 마크업 + <script> 열기 + gifenc IIFE 열기
  'gifenc.js',       // gifenc 1.0.3 (MIT)
  'part-wasm.js',    // gifenc IIFE 닫기 + libwebp wasm(base64) + 글루
  'part2.html',      // function gmInit(root, opts) { ... }
  'part-host.js',    // 단독 페이지: gmInit(document)
  'part-tail.html',  // </script></body></html>
];

const html = PARTS.map(function (f) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) throw new Error('조각 없음: ' + f);
  return fs.readFileSync(p, 'utf8');
}).join('');

/* 조립 결과가 온전한지 기계 검사 */
const checks = [
  [/^<!DOCTYPE html>/, 'DOCTYPE'],
  [/<\/html>\s*$/, '닫는 html'],
  [/function gmInit\(root, opts\)/, 'gmInit 정의'],
  [/\ngmInit\(document\);/, 'gmInit(document) 호출'],
  [/var __webpWasmB64 = "[A-Za-z0-9+/=]{100000,}"/, 'libwebp base64'],
  [/var gifenc = \(function \(\) \{ var exports = \{\};/, 'gifenc 번들'],
  [/id="btnAttach"/, '첨부 버튼'],
];
for (const [re, name] of checks) {
  if (!re.test(html)) throw new Error('조립 검증 실패: ' + name);
}
if (/<\/script>[\s\S]*<\/script>/.test(html.replace(/<\/script>\s*<\/body>/, ''))) {
  throw new Error('script 태그가 두 번 닫힘 — 조각 순서를 확인하세요');
}

fs.writeFileSync(OUT, html);
console.log('index.html:', fs.statSync(OUT).size, 'bytes');
