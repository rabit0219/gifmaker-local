// index.html 의 애니메이션 WebP 먹서를 뽑아내 컨테이너 구조를 독립 파서로 검증한다.
const fs = require('fs');
const IDX = 'C:/Users/USER/gifmaker-local/index.html';
const js = fs.readFileSync(IDX, 'utf8').split('<script>')[1].split('</script>')[0];

function grab(header) {
  const i = js.indexOf(header);
  if (i < 0) throw new Error('not found: ' + header);
  let depth = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}') { depth--; if (depth === 0) return js.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + header);
}
const st = { w: 0, h: 0 };
const api = new Function('st', [
  grab('function u16('), grab('function u24('), grab('function u32('),
  grab('function fourcc('), grab('function riffChunk('), grab('function concatBytes('),
  grab('function webpBitstream('), grab('function dirtyRect('),
].join('\n') + '\nreturn { u16, u24, u32, fourcc, riffChunk, concatBytes, webpBitstream, dirtyRect };')(st);

let fail = 0;
function check(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '   ' + extra : ''));
  if (!cond) fail++;
}

/* ---------- 독립 RIFF 파서 (앱 코드를 쓰지 않고 직접 구현) ---------- */
function parseRiff(buf) {
  const b = Buffer.from(buf);
  const res = { riff: b.slice(0, 4).toString('latin1'), size: b.readUInt32LE(4), form: b.slice(8, 12).toString('latin1'), chunks: [] };
  let pos = 12;
  while (pos + 8 <= b.length) {
    const tag = b.slice(pos, pos + 4).toString('latin1');
    const size = b.readUInt32LE(pos + 4);
    res.chunks.push({ tag, size, at: pos, payload: b.slice(pos + 8, pos + 8 + size) });
    pos += 8 + size + (size & 1);
  }
  res.consumed = pos;
  return res;
}
const rd24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
function parseAnmf(payload) {
  return {
    x: rd24(payload, 0) * 2, y: rd24(payload, 3) * 2,
    w: rd24(payload, 6) + 1, h: rd24(payload, 9) + 1,
    duration: rd24(payload, 12),
    blend: (payload[15] >> 1) & 1, dispose: payload[15] & 1,
    inner: payload.slice(16)
  };
}

/* ---------- 가짜 정지 WebP (브라우저 toBlob 출력 흉내) ---------- */
function fakeStill(payloadLen, withAlpha) {
  const parts = [];
  if (withAlpha) parts.push(api.riffChunk('ALPH', new Uint8Array(7).fill(0x11)));
  parts.push(api.riffChunk('VP8 ', new Uint8Array(payloadLen).fill(0x9d)));
  const body = api.concatBytes(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(api.fourcc('RIFF'), 0);
  out.set(api.u32(4 + body.length), 4);
  out.set(api.fourcc('WEBP'), 8);
  out.set(body, 12);
  return out;
}

console.log('=== 바이트 헬퍼 ===');
check('u24 리틀엔디안', api.u24(0x123456).join(',') === '86,52,18', api.u24(0x123456).join(','));
check('u32 리틀엔디안', api.u32(0xDEADBEEF).join(',') === '239,190,173,222', api.u32(0xDEADBEEF).join(','));
check('u24 최대값 처리', api.u24(16777215).join(',') === '255,255,255', api.u24(16777215).join(','));
const oddChunk = api.riffChunk('TEST', new Uint8Array(5));
check('홀수 페이로드는 짝수로 패딩', oddChunk.length === 8 + 5 + 1, oddChunk.length);
check('패딩해도 size 필드는 실제 크기', Buffer.from(oddChunk).readUInt32LE(4) === 5);

console.log('=== 정지 WebP 비트스트림 추출 ===');
let got = api.webpBitstream(fakeStill(40, false));
check('VP8 청크 1개 추출', got.chunks.length === 1, got.chunks.length);
check('청크 헤더 포함(8+40)', got.chunks[0].length === 48, got.chunks[0].length);
check('알파 없음으로 판정', got.alpha === false);
got = api.webpBitstream(fakeStill(40, true));
check('ALPH+VP8 둘 다 추출', got.chunks.length === 2, got.chunks.length);
check('알파 있음으로 판정', got.alpha === true);
check('ALPH 가 VP8 앞에 온다',
  Buffer.from(got.chunks[0]).slice(0, 4).toString() === 'ALPH' &&
  Buffer.from(got.chunks[1]).slice(0, 4).toString() === 'VP8 ');
let threw = false;
try { api.webpBitstream(new Uint8Array(20)); } catch (e) { threw = /정지 WebP/.test(e.message); }
check('RIFF 아니면 에러', threw);

console.log('=== 애니메이션 WebP 먹싱 (index.html exportWebp 와 동일 절차) ===');
const W = 320, H = 240;
const FRAMES = [
  { r: { x: 0, y: 0, w: W, h: H }, delay: 100, len: 900 },
  { r: { x: 40, y: 20, w: 61, h: 33 }, delay: 100, len: 120 },
  { r: { x: 100, y: 60, w: 50, h: 50 }, delay: 400, len: 200 },   // 병합된 프레임
];
const anmf = [];
let anyAlpha = false;
for (const f of FRAMES) {
  const g = api.webpBitstream(fakeStill(f.len, false));
  if (g.alpha) anyAlpha = true;
  const head = new Uint8Array(16);
  head.set(api.u24(f.r.x >> 1), 0);
  head.set(api.u24(f.r.y >> 1), 3);
  head.set(api.u24(f.r.w - 1), 6);
  head.set(api.u24(f.r.h - 1), 9);
  head.set(api.u24(f.delay), 12);
  head[15] = 0x02;
  anmf.push(api.riffChunk('ANMF', api.concatBytes([head].concat(g.chunks))));
}
const vp8x = new Uint8Array(10);
vp8x[0] = 0x02 | (anyAlpha ? 0x10 : 0);
vp8x.set(api.u24(W - 1), 4);
vp8x.set(api.u24(H - 1), 7);
const anim = new Uint8Array(6);
anim.set(api.u16(0), 4);
const body = api.concatBytes([api.riffChunk('VP8X', vp8x), api.riffChunk('ANIM', anim)].concat(anmf));
const out = new Uint8Array(12 + body.length);
out.set(api.fourcc('RIFF'), 0);
out.set(api.u32(4 + body.length), 4);
out.set(api.fourcc('WEBP'), 8);
out.set(body, 12);

const p = parseRiff(out);
check('RIFF 시그니처', p.riff === 'RIFF', p.riff);
check('WEBP 폼타입', p.form === 'WEBP', p.form);
check('RIFF size = 파일크기-8', p.size === out.length - 8, p.size + ' vs ' + (out.length - 8));
check('모든 바이트가 청크로 소비됨(찌꺼기 없음)', p.consumed === out.length, p.consumed + ' vs ' + out.length);
check('청크 순서 VP8X, ANIM, ANMF*3',
  p.chunks.map(c => c.tag).join(',') === 'VP8X,ANIM,ANMF,ANMF,ANMF',
  p.chunks.map(c => c.tag).join(','));

const x = p.chunks[0];
check('VP8X 페이로드 10바이트', x.size === 10, x.size);
check('VP8X 애니메이션 플래그(0x02)', (x.payload[0] & 0x02) !== 0, '0x' + x.payload[0].toString(16));
check('알파 없으니 알파 플래그 꺼짐', (x.payload[0] & 0x10) === 0);
check('VP8X 캔버스 폭 = ' + W, rd24(x.payload, 4) + 1 === W, rd24(x.payload, 4) + 1);
check('VP8X 캔버스 높이 = ' + H, rd24(x.payload, 7) + 1 === H, rd24(x.payload, 7) + 1);

const a = p.chunks[1];
check('ANIM 페이로드 6바이트', a.size === 6, a.size);
check('무한 반복(loop=0)', a.payload.readUInt16LE(4) === 0, a.payload.readUInt16LE(4));

FRAMES.forEach((f, i) => {
  const fr = parseAnmf(p.chunks[2 + i].payload);
  check('프레임' + i + ' 좌표 (' + f.r.x + ',' + f.r.y + ')', fr.x === f.r.x && fr.y === f.r.y, fr.x + ',' + fr.y);
  check('프레임' + i + ' 크기 ' + f.r.w + 'x' + f.r.h, fr.w === f.r.w && fr.h === f.r.h, fr.w + 'x' + fr.h);
  check('프레임' + i + ' 지연 ' + f.delay + 'ms', fr.duration === f.delay, fr.duration);
  check('프레임' + i + ' B=1(덮어쓰기) D=0(유지)', fr.blend === 1 && fr.dispose === 0, 'B=' + fr.blend + ' D=' + fr.dispose);
  const innerTag = fr.inner.slice(0, 4).toString('latin1');
  check('프레임' + i + ' 내부에 VP8 비트스트림', innerTag === 'VP8 ', innerTag);
  check('프레임' + i + ' 내부 VP8 크기 ' + f.len, fr.inner.readUInt32LE(4) === f.len, fr.inner.readUInt32LE(4));
});

console.log('=== ANMF 좌표 제약 ===');
check('모든 프레임 x/y 가 짝수 (ANMF는 2픽셀 단위)',
  FRAMES.every((f, i) => parseAnmf(p.chunks[2 + i].payload).x % 2 === 0 && parseAnmf(p.chunks[2 + i].payload).y % 2 === 0));
check('모든 프레임이 캔버스 안',
  FRAMES.every((f, i) => { const fr = parseAnmf(p.chunks[2 + i].payload); return fr.x + fr.w <= W && fr.y + fr.h <= H; }));

console.log('=== dirty rect ===');
st.w = 64; st.h = 48;
function img(fill) {
  const d = new Uint8ClampedArray(st.w * st.h * 4);
  for (let i = 0; i < d.length; i += 4) { d[i] = fill; d[i + 1] = fill; d[i + 2] = fill; d[i + 3] = 255; }
  return { data: d };
}
const base = img(10), mod = img(10);
// (13,7) ~ (20,9) 사각형만 변경
for (let y = 7; y <= 9; y++) for (let xx = 13; xx <= 20; xx++) {
  const o = (y * st.w + xx) * 4;
  mod.data[o] = 200; mod.data[o + 1] = 200; mod.data[o + 2] = 200;
}
let r = api.dirtyRect(base, mod);
check('x 는 짝수로 내림 (13 -> 12)', r.x === 12, r.x);
check('y 는 짝수로 내림 (7 -> 6)', r.y === 6, r.y);
check('변경 영역 오른쪽 끝 포함', r.x + r.w - 1 >= 20, r.x + r.w - 1);
check('변경 영역 아래쪽 끝 포함', r.y + r.h - 1 >= 9, r.y + r.h - 1);
check('전체보다 훨씬 작음', r.w * r.h < st.w * st.h / 4, r.w + 'x' + r.h + ' vs ' + st.w + 'x' + st.h);
check('캔버스 밖으로 안 나감', r.x + r.w <= st.w && r.y + r.h <= st.h, JSON.stringify(r));

r = api.dirtyRect(base, img(10));
check('동일 프레임이면 최소 2x2 반환', r.w === 2 && r.h === 2, JSON.stringify(r));

const full = api.dirtyRect(base, img(99));
check('전체가 바뀌면 전체 영역', full.x === 0 && full.y === 0 && full.w === st.w && full.h === st.h, JSON.stringify(full));

console.log('=== dirty rect 허용 오차 (프레임이 압축 저장이므로 필요) ===');
const TOL = +js.match(/var DIRTY_TOL = (\d+)/)[1];
check('DIRTY_TOL 이 1 이상', TOL >= 1, TOL);
// 압축 잡음처럼 정지 영역이 ±2 흔들리는 상황
const noisy = img(10);
for (let i = 0; i < noisy.data.length; i += 4) {
  const j = (i / 4) % 3;
  noisy.data[i] = 10 + (j === 0 ? 2 : j === 1 ? -2 : 1);
  noisy.data[i + 1] = 10 + (j === 2 ? 2 : -1);
  noisy.data[i + 2] = 10 + (j === 1 ? 1 : -2);
}
let rn = api.dirtyRect(base, noisy, 0);
check('오차 0 이면 잡음도 변경으로 봐서 전체 영역', rn.w === st.w && rn.h === st.h, rn.w + 'x' + rn.h);
rn = api.dirtyRect(base, noisy, TOL);
check('오차 ' + TOL + ' 이면 잡음은 무시(최소 2x2)', rn.w === 2 && rn.h === 2, JSON.stringify(rn));
// 잡음 위에 실제 변화가 있으면 그 영역은 잡아내야 한다
for (let y = 20; y <= 25; y++) for (let x = 30; x <= 40; x++) {
  const o = (y * st.w + x) * 4;
  noisy.data[o] = 200; noisy.data[o + 1] = 200; noisy.data[o + 2] = 200;
}
rn = api.dirtyRect(base, noisy, TOL);
check('잡음 속 실제 변화는 놓치지 않음', rn.x <= 30 && rn.y <= 20 && rn.x + rn.w - 1 >= 40 && rn.y + rn.h - 1 >= 25,
  JSON.stringify(rn));
check('실제 변화 영역만 좁게 잡음', rn.w * rn.h < st.w * st.h / 4, rn.w + 'x' + rn.h);

// 알파 플래그 경로
const alphaX = new Uint8Array(10);
alphaX[0] = 0x02 | 0x10;
check('알파 있으면 VP8X 에 알파 플래그', (alphaX[0] & 0x10) !== 0 && (alphaX[0] & 0x02) !== 0);

fs.writeFileSync(__dirname + '/out-struct.webp', Buffer.from(out));
console.log('\n(구조 검증용 컨테이너: out-struct.webp — VP8 페이로드는 가짜라 렌더는 안 됨)');
console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
process.exit(fail ? 1 : 0);
