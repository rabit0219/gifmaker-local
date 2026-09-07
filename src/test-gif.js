// index.html 에 실제로 들어간 코드를 그대로 뽑아내 node 에서 검증한다.
// 프레임 저장소는 canvas 의존이라 frameData 만 스텁으로 대체한다.
const fs = require('fs');
const IDX = 'C:/Users/USER/gifmaker-local/index.html';
const js = fs.readFileSync(IDX, 'utf8').split('<script>')[1].split('</script>')[0];

const gifencSrc = fs.readFileSync(__dirname + '/gifenc.js', 'utf8');
const gifenc = (function () { const exports = {}; eval(gifencSrc); return exports; })();

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
const bayerSrc = js.slice(js.indexOf('var BAYER = ['), js.indexOf('];', js.indexOf('var BAYER = [')) + 2);

// 테스트 전용 frameData: st.frames[i].img 를 그대로 돌려준다 (실제 앱은 blob 디코딩)
const PRELUDE = 'function frameData(i){ return Promise.resolve(st.frames[i].img); }';

const st = { mode: 'normal', w: 0, h: 0, vw: 0, vh: 0, frames: [], cropMode: 'off', ratio: 0, crop: { x: 0, y: 0, w: 1, h: 1 } };

function build(coarse) {
  const parts = [
    PRELUDE, bayerSrc,
    grab('function clamp('), grab('function baseDelay('),
    grab('function isCoarse('), grab('function memBudget('),
    grab('function sameBytes('),
    grab('function parseRatio('), grab('function ratioBox('), grab('function cropPx('),
    grab('function lockRatio('), grab('function seqOf('),
    grab('async function buildPalette('),
    grab('function ditherBayer('), grab('function ditherFS('),
  ];
  return new Function('gifenc', 'st', 'matchMedia', parts.join('\n') +
    '\nreturn { clamp, baseDelay, isCoarse, memBudget, sameBytes, parseRatio, ratioBox,' +
    ' cropPx, lockRatio, seqOf, buildPalette, ditherBayer, ditherFS };'
  )(gifenc, st, coarse ? function () { return { matches: true }; } : undefined);
}
const api = build(false);
const mobApi = build(true);

let fail = 0;
function check(label, cond, extra) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + label + (extra !== undefined ? '   ' + extra : ''));
  if (!cond) fail++;
}

function makeFrames(w, h, n, opt) {
  opt = opt || {};
  const out = [];
  for (let f = 0; f < n; f++) {
    const d = new Uint8ClampedArray(w * h * 4);
    const bx = opt.static ? 5 : Math.round((w - 20) * f / Math.max(1, n - 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let r = Math.round(255 * x / w), g = Math.round(255 * y / h), b = 128;
        if (x >= bx && x < bx + 20 && y > h / 3 && y < h * 2 / 3) { r = 250; g = 40; b = 40; }
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    out.push({ img: { data: d, width: w, height: h }, delay: opt.delay || 100 });
  }
  return out;
}

/* index.html exportGif 인코딩 루프와 동일 (frameData 만 스텁) */
async function encode(colors, dith) {
  const pal = await api.buildPalette(colors);
  const seq = api.seqOf(st.frames.length);
  const idx = new Array(st.frames.length);
  const enc = gifenc.GIFEncoder();
  for (let k = 0; k < seq.length; k++) {
    const fi = seq[k], f = st.frames[fi];
    let ix = idx[fi];
    if (!ix) {
      const im = st.frames[fi].img;
      if (dith === 'fs') ix = api.ditherFS(im, pal);
      else if (dith === 'bayer') ix = gifenc.applyPalette(api.ditherBayer(im, colors), pal, 'rgb565');
      else ix = gifenc.applyPalette(im.data, pal, 'rgb565');
      idx[fi] = ix;
    }
    const opts = { delay: f.delay };
    if (k === 0) { opts.palette = pal; opts.repeat = 0; }
    enc.writeFrame(ix, st.w, st.h, opts);
  }
  enc.finish();
  return { bytes: Buffer.from(enc.bytesView()), seq, pal };
}

function inspect(buf) {
  let imgs = 0, localTables = 0;
  const delays = [];
  for (let i = 0; i < buf.length - 12; i++) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xF9 && buf[i + 2] === 0x04 && buf[i + 8] === 0x2C) {
      imgs++;
      delays.push(buf.readUInt16LE(i + 4) * 10);
      if (buf[i + 8 + 9] & 0x80) localTables++;
    }
  }
  return {
    sig: buf.slice(0, 6).toString('latin1'), imgs, localTables, delays,
    netscape: buf.includes(Buffer.from('NETSCAPE2.0', 'latin1')),
    trailer: buf[buf.length - 1] === 0x3B, size: buf.length,
    w: buf.readUInt16LE(6), h: buf.readUInt16LE(8)
  };
}

(async function () {
  const W = 160, H = 100, N = 10;
  st.w = W; st.h = H; st.frames = makeFrames(W, H, N);

  console.log('=== GIF 인코딩 (일반 모드) ===');
  st.mode = 'normal';
  for (const [colors, dith] of [[256, 'fs'], [128, 'bayer'], [64, 'none']]) {
    const t = Date.now();
    const { bytes, seq, pal } = await encode(colors, dith);
    const r = inspect(bytes);
    console.log(`- ${colors}색 / ${dith}: ${r.size} bytes, 팔레트 ${pal.length}색, ${Date.now() - t}ms`);
    check('GIF89a', r.sig === 'GIF89a', r.sig);
    check('논리 화면 크기 = ' + W + 'x' + H, r.w === W && r.h === H, r.w + 'x' + r.h);
    check('프레임 수 = ' + seq.length, r.imgs === seq.length, 'actual ' + r.imgs);
    check('글로벌 팔레트만 사용', r.localTables === 0, 'actual ' + r.localTables);
    check('NETSCAPE 무한루프', r.netscape);
    check('트레일러 0x3B', r.trailer);
    check('팔레트 <= ' + colors, pal.length <= colors, 'actual ' + pal.length);
  }

  console.log('=== 부메랑 ===');
  st.mode = 'boomerang';
  const seqB = api.seqOf(N);
  check('시퀀스 길이 = 2N-2', seqB.length === 2 * N - 2, seqB.length);
  check('왕복 순서', seqB.join(',') === '0,1,2,3,4,5,6,7,8,9,8,7,6,5,4,3,2,1', seqB.join(','));
  const rb = await encode(256, 'fs');
  const ib = inspect(rb.bytes);
  console.log('- 부메랑 GIF: ' + ib.size + ' bytes');
  check('프레임 수 = ' + seqB.length, ib.imgs === seqB.length, ib.imgs);
  check('유효 GIF', ib.sig === 'GIF89a' && ib.trailer);
  fs.writeFileSync(__dirname + '/out-boomerang.gif', rb.bytes);
  check('프레임 2장 -> 부메랑 미적용', api.seqOf(2).join(',') === '0,1', api.seqOf(2).join(','));
  check('프레임 3장 -> 0,1,2,1', api.seqOf(3).join(',') === '0,1,2,1', api.seqOf(3).join(','));

  console.log('=== 프레임별 지연(배속 중복 병합) ===');
  st.mode = 'normal';
  st.frames = makeFrames(W, H, 4);
  st.frames[1].delay = 400;
  const rd = inspect((await encode(64, 'none')).bytes);
  check('GIF 지연값이 프레임별로 기록됨', rd.delays.join(',') === '100,400,100,100', rd.delays.join(','));

  console.log('=== 중복 판정 (인코딩 바이트 비교) ===');
  const a = new Uint8Array([1, 2, 3, 4, 5]);
  check('같은 바이트열 -> 동일', api.sameBytes(a, new Uint8Array([1, 2, 3, 4, 5])));
  check('길이 다르면 다름', !api.sameBytes(a, new Uint8Array([1, 2, 3, 4])));
  check('끝 1바이트만 달라도 다름', !api.sameBytes(a, new Uint8Array([1, 2, 3, 4, 9])));
  const big1 = new Uint8Array(500), big2 = new Uint8Array(500);
  big2[50] = 7;   // 97바이트 성긴 비교를 지나치는 위치
  check('성긴 비교를 지나쳐도 전체 비교로 잡아냄', !api.sameBytes(big1, big2));
  check('큰 동일 배열 -> 동일', api.sameBytes(new Uint8Array(500), new Uint8Array(500)));

  console.log('=== 크롭 좌표 ===');
  st.vw = 1920; st.vh = 1080; st.cropMode = 'off';
  let c = api.cropPx();
  check('크롭 끄면 원본 전체', c.sx === 0 && c.sy === 0 && c.sw === 1920 && c.sh === 1080, JSON.stringify(c));
  st.cropMode = '1:1'; st.ratio = api.parseRatio('1:1');
  st.crop = api.ratioBox(st.ratio, 0.5, 0.5);
  c = api.cropPx();
  check('1:1 크롭은 정사각', c.sw === c.sh, c.sw + 'x' + c.sh);
  check('1:1 크롭은 짧은 변에 맞춤', c.sh === 1080, c.sh);
  check('1:1 크롭 가운데 정렬', c.sx === (1920 - 1080) / 2, c.sx);
  st.cropMode = '9:16'; st.ratio = api.parseRatio('9:16');
  st.crop = api.ratioBox(st.ratio, 0.5, 0.5);
  c = api.cropPx();
  check('9:16 비율 정확', Math.abs(c.sw / c.sh - 9 / 16) < 0.01, (c.sw / c.sh).toFixed(4) + ' -> ' + c.sw + 'x' + c.sh);
  check('9:16 은 화면 밖으로 안 나감', c.sx >= 0 && c.sy >= 0 && c.sx + c.sw <= 1920 && c.sy + c.sh <= 1080, JSON.stringify(c));
  st.vw = 1080; st.vh = 1920;
  st.cropMode = '16:9'; st.ratio = api.parseRatio('16:9');
  st.crop = api.ratioBox(st.ratio, 0.5, 0.5);
  c = api.cropPx();
  check('세로 영상 16:9 크롭 비율', Math.abs(c.sw / c.sh - 16 / 9) < 0.02, (c.sw / c.sh).toFixed(3) + ' -> ' + c.sw + 'x' + c.sh);

  console.log('=== 비율 고정 리사이즈 ===');
  st.vw = 1920; st.vh = 1080; st.ratio = 1;
  let b = api.lockRatio({ x: 0.1, y: 0.1, w: 0.5, h: 0.9 }, 'se', 1);
  check('se 드래그 후에도 1:1 유지', Math.abs((b.w * 1920) / (b.h * 1080) - 1) < 0.02,
    (b.w * 1920).toFixed(0) + 'x' + (b.h * 1080).toFixed(0));
  check('결과가 프레임 안', b.x >= 0 && b.y >= 0 && b.x + b.w <= 1.0001 && b.y + b.h <= 1.0001);
  b = api.lockRatio({ x: 0.4, y: 0.4, w: 0.5, h: 0.2 }, 'n', 1);
  check('n 드래그도 1:1 유지', Math.abs((b.w * 1920) / (b.h * 1080) - 1) < 0.02);

  console.log('=== 배속 → 프레임 수 ===');
  const HARD_MAX = +js.match(/var HARD_MAX = (\d+)/)[1];
  check('HARD_MAX 가 넉넉함 (1000장 이상)', HARD_MAX >= 1000, HARD_MAX + '장');
  function planN(span, fps, speed) {
    const want = Math.max(2, Math.round(span / speed * fps));
    return { want, n: Math.min(want, HARD_MAX) };
  }
  for (const sp of [0.25, 0.5, 1, 2, 5]) {
    console.log(`- 4초 15fps ${sp}x -> ${planN(4, 15, sp).n}장`);
  }
  check('0.25x 는 1x 보다 많음', planN(4, 15, 0.25).want > planN(4, 15, 1).want);
  check('5x 는 1x 보다 적음', planN(4, 15, 5).want < planN(4, 15, 1).want);
  check('5x 최소 2장 보장', planN(0.2, 8, 5).n >= 2);
  check('4초 15fps(60장) 상한에 안 걸림', planN(4, 15, 1).n === 60, planN(4, 15, 1).n);
  check('30초 15fps(450장) 상한에 안 걸림', planN(30, 15, 1).n === 450, planN(30, 15, 1).n);
  check('60초 25fps(1500장) 상한에 안 걸림', planN(60, 25, 1).n === 1500, planN(60, 25, 1).n);
  check('baseDelay(15fps)=70ms', api.baseDelay(15) === 70, api.baseDelay(15));
  check('baseDelay(25fps)=40ms', api.baseDelay(25) === 40, api.baseDelay(25));

  console.log('=== 메모리 예산 (장수 상한 대신 누적 바이트) ===');
  check('coarse 감지', mobApi.isCoarse() === true && api.isCoarse() === false);
  check('모바일 예산 120MB', mobApi.memBudget() === 120e6, (mobApi.memBudget() / 1e6) + 'MB');
  check('데스크톱 예산 320MB', api.memBudget() === 320e6, (api.memBudget() / 1e6) + 'MB');
  const perFrame = 70e3;                       // 480x854 압축 스틸 대략치
  const mobFrames = Math.floor(mobApi.memBudget() / perFrame);
  const rawFrames = Math.floor(mobApi.memBudget() / (480 * 854 * 4));
  console.log('- 480x854 (스틸 70KB 가정): 모바일 ' + mobFrames + '장 / 데스크톱 ' +
    Math.floor(api.memBudget() / perFrame) + '장  (raw 저장이면 ' + rawFrames + '장)');
  check('모바일에서 기존 42장을 크게 넘김', mobFrames > 1000, mobFrames + '장');
  check('raw 저장 대비 15배 이상', mobFrames / rawFrames > 15, (mobFrames / rawFrames).toFixed(0) + '배');

  console.log('=== 디더링 ===');
  st.w = W; st.h = H; st.frames = makeFrames(W, H, 3);
  const pal64 = await api.buildPalette(64);
  const u = (arr) => new Set(arr).size;
  const noneIdx = gifenc.applyPalette(st.frames[0].img.data, pal64, 'rgb565');
  const fsIdx = api.ditherFS(st.frames[0].img, pal64);
  const bayerIdx = gifenc.applyPalette(api.ditherBayer(st.frames[0].img, 64), pal64, 'rgb565');
  console.log('- 사용 색 수: none=' + u(noneIdx) + ' bayer=' + u(bayerIdx) + ' fs=' + u(fsIdx));
  check('FS 가 팔레트를 더 활용', u(fsIdx) >= u(noneIdx));
  check('Bayer 가 팔레트를 더 활용', u(bayerIdx) >= u(noneIdx));
  check('FS 인덱스 길이 = 픽셀 수', fsIdx.length === W * H, fsIdx.length);
  check('buildPalette(async) 가 프레임을 디코딩해 팔레트 생성', pal64.length > 1 && pal64.length <= 64, pal64.length + '색');

  console.log(fail === 0 ? '\nALL PASS' : '\n' + fail + ' FAILED');
  process.exit(fail ? 1 : 0);
})();
