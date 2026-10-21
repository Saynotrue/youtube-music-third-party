const { ipcRenderer } = require('electron');

// ═════════════════════════════════════════════════════════════
//  1. 전역 상태 및 변수 관리
// ═════════════════════════════════════════════════════════════
let currentLyrics = [];
let lastTitle = '';
let lastArtist = '';
let isFetchingLyrics = false;
let lastLyricIdx = -1;
let isPausedDisplayed = false;
let lastLyricCheckTime = 0;

// 로컬 재생 상태 추적
let localProgress = 0;
let lastSyncTime = null;
let isPlaying = false;
let trackDuration = 0;

// 애니메이션/테마 상태
let fadeTimer = null;
let lastAlbumImg = null;

// ═════════════════════════════════════════════════════════════
//  2. 앱 설정 (Config) 초기화 및 관리
// ═════════════════════════════════════════════════════════════
let appConfig = {
    opacity: 1.0,
    autoFade: false,
    theme: 'auto',
    syncOffset: 0,
    alwaysOnTop: true,
    globalShortcut: true,
    widgetStyle: 'eq',
    trayIcon: 'player'
};

function initSettings() {
    const saved = localStorage.getItem('lyricsBarSettings');
    if (saved) {
        // 예전 버전에서 저장된 Pro/Spotify 설정값은 버림
        const { isPro, musicService, ...rest } = JSON.parse(saved);
        appConfig = { ...appConfig, ...rest };
    }

    applyConfigToUI();
    applyConfigToApp();
}

function saveSettings() {
    localStorage.setItem('lyricsBarSettings', JSON.stringify(appConfig));
    applyConfigToApp();
}

// ═════════════════════════════════════════════════════════════
//  3. 🎨 테마 및 색상 추출 (배경 그라데이션 적용)
// ═════════════════════════════════════════════════════════════
function extractColor(imgEl) {
    const canvas = document.createElement('canvas');
    canvas.width = 10; canvas.height = 10;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, 10, 10);
    const data = ctx.getImageData(0, 0, 10, 10).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const count = data.length / 4;
    return `${Math.floor(r / count)}, ${Math.floor(g / count)}, ${Math.floor(b / count)}`;
}

// 앨범 아트에서 서로 다른 대표 색 여러 개 추출 (많이 쓰인 색 + 채도 높은 색 우선, 비슷한 색은 제외)
function extractPalette(imgEl, count = 5) {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    const buckets = new Map();
    for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const key = (r >> 5) << 6 | (g >> 5) << 3 | (b >> 5);
        const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, n: 0 };
        bucket.r += r; bucket.g += g; bucket.b += b; bucket.n++;
        buckets.set(key, bucket);
    }

    const candidates = [...buckets.values()].map(({ r, g, b, n }) => {
        const c = [r / n, g / n, b / n];
        const max = Math.max(...c), min = Math.min(...c);
        const saturation = max === 0 ? 0 : (max - min) / max;
        return { c, score: n * (0.4 + saturation) };
    }).sort((a, b) => b.score - a.score);

    const picked = [];
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    for (const { c } of candidates) {
        if (picked.every(p => distance(p, c) > 48)) picked.push(c);
        if (picked.length >= count) break;
    }
    // 색이 단조로운 이미지는 밝기만 바꾼 변형으로 채움
    for (let i = 0; picked.length < count && picked.length > 0; i++) {
        const base = picked[i % picked.length];
        const k = i % 2 === 0 ? 0.7 : 1.25;
        picked.push(base.map(v => Math.min(255, v * k)));
    }
    return picked.map(c => c.map(Math.round).join(', '));
}

// isLight: 글자가 검정(true)/흰색(false)인지. 색 덩어리가 글자 뒤를 지나가도 읽히도록 밝기 범위를 제한
//  (예: 빨간 앨범의 흰색 로고 색이 흰 글자 뒤로 오면 글자가 사라짐)
function applyAmbientBackground(img, isLight) {
    let palette;
    try { palette = extractPalette(img, AmbientPaint.COLOR_COUNT); } catch (e) { return; }
    if (!palette.length) return;
    AmbientPaint.setColors(palette.map(c => {
        const [h, sat, l] = rgbToHsl(...c.split(',').map(Number));
        const light = isLight ? Math.max(l, 0.62) : Math.min(l, 0.42);
        return hslToRgb(h, sat, light);
    }));
}

function hslToRgb(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0) * 255, f(8) * 255, f(4) * 255];
}

// ─── 🎨 물감 배경 ───────────────────────────────────────────
// 색마다 하나씩 매끄러운 3D 노이즈(x, y, 시간)를 두고, 각 지점에서 노이즈 값이 큰 색일수록 많이 섞어 칠함.
// 좌표를 노이즈로 한 번 더 비틀어(domain warp) 원이 아닌 물감이 휘도는 듯한 불규칙한 영역을 만듦.
// 곡이 바뀌어도 시간(t)은 계속 흐르므로 모양은 이어지고, 색만 목표 색으로 서서히 바뀜.
const AmbientPaint = (() => {
    const COLOR_COUNT = 5;
    const W = 64, H = 40;            // 저해상도로 그린 뒤 CSS로 늘림 (성능)
    const SPEED = 0.06;              // 모양이 변하는 속도
    const SCALE = 1.6;               // 색 영역 크기 (작을수록 큰 덩어리)
    const SHARPNESS = 6;             // 색 영역 경계 선명도
    const COLOR_FADE_MS = 1500;      // 곡 전환 시 색이 바뀌는 시간
    const FRAME_MS = 1000 / 30;

    // 3D 값 노이즈 (부드러운 보간)
    const perm = new Uint8Array(512);
    const vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) { perm[i] = i; vals[i] = Math.random(); }
    for (let i = 255; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
    const fade = t => t * t * (3 - 2 * t);
    const lerp = (a, b, t) => a + (b - a) * t;
    const v = (x, y, z) => vals[perm[perm[perm[x & 255] + (y & 255)] + (z & 255)]];
    function noise(x, y, z) {
        const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
        const xf = fade(x - xi), yf = fade(y - yi), zf = fade(z - zi);
        return lerp(
            lerp(lerp(v(xi, yi, zi), v(xi + 1, yi, zi), xf), lerp(v(xi, yi + 1, zi), v(xi + 1, yi + 1, zi), xf), yf),
            lerp(lerp(v(xi, yi, zi + 1), v(xi + 1, yi, zi + 1), xf), lerp(v(xi, yi + 1, zi + 1), v(xi + 1, yi + 1, zi + 1), xf), yf),
            zf);
    }

    // 그릴 대상: 전체화면 배경, LP 위젯 배경 (무늬는 한 번만 계산해 보이는 쪽에만 그림)
    const TARGETS = [
        { id: 'ambient-canvas', visible: () => document.body.classList.contains('fullscreen-mode') },
        { id: 'lp-ambient-canvas', visible: () => !document.body.classList.contains('fullscreen-mode') && !!document.getElementById('lp-mode')?.classList.contains('mode-active') },
    ];
    let targets = [], image = null;
    let current = Array.from({ length: COLOR_COUNT }, () => [26, 26, 26]);
    let from = current.map(c => [...c]), target = current.map(c => [...c]);
    let fadeStart = 0;
    let t = Math.random() * 100;     // 시작 모양도 매번 랜덤
    let lastFrame = 0, rafId = null;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const weights = new Float32Array(COLOR_COUNT);

    function init() {
        targets = TARGETS.map(tg => ({ ...tg, canvas: document.getElementById(tg.id) })).filter(tg => tg.canvas);
        if (!targets.length) return false;
        targets.forEach(tg => { tg.canvas.width = W; tg.canvas.height = H; tg.ctx = tg.canvas.getContext('2d'); });
        image = targets[0].ctx.createImageData(W, H);
        return true;
    }

    function draw() {
        const data = image.data;
        const aspect = W / H;
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const nx = (x / W) * SCALE * aspect, ny = (y / H) * SCALE;
                // domain warp: 좌표를 노이즈로 비틀어 휘도는 물감 무늬
                const wx = nx + (noise(nx * 1.3, ny * 1.3, t * 0.7 + 50) - 0.5) * 1.8;
                const wy = ny + (noise(nx * 1.3 + 31, ny * 1.3, t * 0.7 + 80) - 0.5) * 1.8;
                let sum = 0;
                for (let i = 0; i < COLOR_COUNT; i++) {
                    const w = Math.exp(noise(wx + i * 17.3, wy - i * 9.1, t + i * 3.7) * SHARPNESS);
                    weights[i] = w; sum += w;
                }
                let r = 0, g = 0, b = 0;
                for (let i = 0; i < COLOR_COUNT; i++) {
                    const k = weights[i] / sum;
                    r += current[i][0] * k; g += current[i][1] * k; b += current[i][2] * k;
                }
                const o = (y * W + x) * 4;
                data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
            }
        }
        targets.forEach(tg => { if (tg.visible()) tg.ctx.putImageData(image, 0, 0); });
    }

    function updateColors(now) {
        const k = Math.min(1, (now - fadeStart) / COLOR_FADE_MS);
        const e = k * k * (3 - 2 * k);
        current = from.map((c, i) => c.map((ch, j) => ch + (target[i][j] - ch) * e));
        return k < 1;
    }

    function isVisible() {
        return targets.some(tg => tg.visible() && tg.canvas.offsetParent !== null);
    }

    function loop(now) {
        rafId = null;
        if (!isVisible()) return; // 전체화면/LP 모드가 아니면 멈춤 (start()로 재개)
        if (now - lastFrame >= FRAME_MS) {
            const dt = lastFrame ? Math.min(now - lastFrame, 100) : FRAME_MS;
            lastFrame = now;
            const fading = updateColors(now);
            if (!reduceMotion) t += SPEED * dt / 1000;
            draw();
            if (reduceMotion && !fading) return; // 동작 줄이기: 색 전환이 끝나면 정지
        }
        rafId = requestAnimationFrame(loop);
    }

    function start() {
        if (!targets.length && !init()) return;
        if (rafId === null) { lastFrame = 0; rafId = requestAnimationFrame(loop); }
    }

    function setColors(colors) {
        if (!colors.length) return;
        from = current.map(c => [...c]);
        target = Array.from({ length: COLOR_COUNT }, (_, i) => colors[i % colors.length]);
        fadeStart = performance.now();
        start();
    }

    // 전체화면 진입 감지 → 그리기 재개
    // 전체화면 진입 / LP 모드 전환 감지 → 그리기 재개
    const observer = new MutationObserver(() => { if (TARGETS.some(tg => tg.visible())) start(); });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    const lpModeEl = document.getElementById('lp-mode');
    if (lpModeEl) observer.observe(lpModeEl, { attributes: true, attributeFilter: ['class'] });

    return { COLOR_COUNT, setColors, start };
})();

// 바 모드 이퀄라이저: 앨범 아트의 여러 색을 막대마다 이어지는 그라데이션으로 칠함
function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
}

function applyEqPalette(img) {
    const bars = document.querySelectorAll('#equalizer .bar');
    if (!bars.length) return;
    let palette;
    // 전체화면 배경과 같은 색을 쓰도록 같은 팔레트에서 뽑음
    try { palette = extractPalette(img, AmbientPaint.COLOR_COUNT); } catch (e) { return; }
    if (!palette.length) return;

    // 어두운 바 배경에서도 보이도록 밝기만 올림 (채도를 억지로 올리면 흰색/회색이 엉뚱한 색으로 바뀜)
    // 색상(hue) 순으로 정렬해 자연스럽게 이어지게 하고, 무채색(흰색/회색)은 끝에 둠
    // 어두운 색은 HSL 채도 값이 과장되므로(예: 살짝 붉은 검정 → 채도 50%) 실제 색 진하기(chroma)를 유지하도록 채도를 다시 계산
    //   (그대로 밝히면 흑백 앨범의 검정이 진한 빨강/분홍 막대가 됨)
    const colors = palette.map(c => {
        const rgb = c.split(',').map(Number);
        const chroma = (Math.max(...rgb) - Math.min(...rgb)) / 255;
        const [h, , l0] = rgbToHsl(...rgb);
        const l = Math.min(Math.max(l0, 0.6), 0.8);
        return { h, s: Math.min(1, chroma / (1 - Math.abs(2 * l - 1))), l, chroma };
    });
    const vivid = colors.filter(c => c.chroma >= 0.12).sort((a, b) => a.h - b.h);
    const neutral = colors.filter(c => c.chroma < 0.12).map(c => ({ ...c, s: 0 }));
    let stops = [...vivid, ...neutral];

    // 한 계열 색뿐인 앨범(예: 빨강+검정)은 막대가 거의 같은 색이 되므로, 대표 색의 밝기를 달리해 그라데이션을 만듦
    const hueSpread = vivid.length ? vivid[vivid.length - 1].h - vivid[0].h : 0;
    if (vivid.length > 0 && hueSpread < 25) {
        const { h, s } = vivid.reduce((best, c) => (c.s > best.s ? c : best));
        stops = [{ h, s, l: 0.72 }, { h, s, l: 0.6 }, ...neutral.slice(0, 1)];
    }

    // 색 사이는 RGB로 보간 (hue로 보간하면 파랑 → 분홍 사이에 앨범에 없는 보라/초록 등이 끼어 무지개처럼 보임)
    const rgbStops = stops.map(c => hslToRgb(c.h, c.s, c.l));
    bars.forEach((bar, i) => {
        const pos = bars.length > 1 ? (i / (bars.length - 1)) * (rgbStops.length - 1) : 0;
        const a = rgbStops[Math.floor(pos)], b = rgbStops[Math.min(Math.ceil(pos), rgbStops.length - 1)];
        const t = pos - Math.floor(pos);
        const [r, g, bl] = a.map((v, k) => Math.round(v + (b[k] - v) * t));
        bar.style.setProperty('--bar-color', `rgb(${r}, ${g}, ${bl})`);
    });
}

function applyGradient(imgEl) {
    if (imgEl) lastAlbumImg = imgEl;
    const img = lastAlbumImg;
    if (!img) return;

    const bar = document.getElementById('bar');
    const lpMode = document.getElementById('lp-mode');
    const titleEl = document.getElementById('title');
    const artistEl = document.getElementById('artist');

    applyEqPalette(img);

    if (appConfig.theme === 'dark') {
        if (bar) { bar.style.background = 'rgba(15, 15, 15, 0.95)'; bar.style.backdropFilter = ''; }
        if (lpMode) lpMode.style.background = 'rgba(15, 15, 15, 0.95)';
        if (titleEl) titleEl.style.color = '#fff';
        if (artistEl) artistEl.style.color = 'rgba(255,255,255,0.5)';
        return;
    }

    if (appConfig.theme === 'glass') {
        if (bar) { bar.style.background = 'rgba(255, 255, 255, 0.07)'; bar.style.backdropFilter = 'blur(40px) saturate(180%)'; }
        if (titleEl) titleEl.style.color = '#fff';
        if (artistEl) artistEl.style.color = 'rgba(255,255,255,0.5)';
        return;
    }

    if (bar) bar.style.backdropFilter = '';
    const color = extractColor(img);
    const [r, g, b] = color.split(',').map(Number);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const isLight = brightness > 128;
    applyAmbientBackground(img, isLight);

    if (appConfig.theme === 'accent') {
        if (bar) bar.style.background = `linear-gradient(90deg, rgba(${color}, 1.0) 0%, rgba(${color}, 0.85) 45%, rgba(${color}, 0.2) 100%)`;
    } else {
        if (bar) bar.style.background = `linear-gradient(90deg, rgba(${color}, 0.9) 0%, rgba(${color}, 0.5) 25%, rgba(15,15,15,0.92) 55%)`;
        // LP 배경은 물감 캔버스(#lp-ambient-canvas)가 그림. 캔버스가 꺼진 테마용 바탕색만 지정
        if (lpMode) lpMode.style.background = `rgb(${color})`;
    }

    if (titleEl) titleEl.style.color = isLight ? '#000' : '#fff';
    if (artistEl) artistEl.style.color = isLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.5)';

    if (isLight) {
        document.documentElement.style.setProperty('--ui-primary', '#000000');
        document.documentElement.style.setProperty('--ui-secondary', 'rgba(0, 0, 0, 0.6)');
        document.documentElement.style.setProperty('--ui-lyric-dim', 'rgba(0, 0, 0, 0.3)');
        document.documentElement.style.setProperty('--ui-glow', 'rgba(0, 0, 0, 0.2)'); // 검은 네온 그림자
        document.documentElement.style.setProperty('--ui-glow-dim', 'rgba(0, 0, 0, 0.1)');
        document.documentElement.style.setProperty('--ui-bg', 'rgba(0, 0, 0, 0.15)');
    } else {
        document.documentElement.style.setProperty('--ui-primary', '#ffffff');
        document.documentElement.style.setProperty('--ui-secondary', 'rgba(255, 255, 255, 0.6)');
        document.documentElement.style.setProperty('--ui-lyric-dim', 'rgba(255, 255, 255, 0.25)');
        document.documentElement.style.setProperty('--ui-glow', 'rgba(255, 255, 255, 0.8)'); // 하얀 네온 그림자
        document.documentElement.style.setProperty('--ui-glow-dim', 'rgba(255, 255, 255, 0.5)');
        document.documentElement.style.setProperty('--ui-bg', 'rgba(255, 255, 255, 0.15)');
    }

    document.documentElement.style.setProperty('--theme-color', `rgb(${color})`);
    document.documentElement.style.setProperty('--bg-color', `rgb(${color})`);
}

// ═════════════════════════════════════════════════════════════
//  4. 📝 가사(LRC) 파싱 및 렌더링
// ═════════════════════════════════════════════════════════════
function parseLRC(lrc) {
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g;
    const result = [];
    for (const line of lrc.split('\n')) {
        const times = [];
        let match;
        timeRegex.lastIndex = 0;
        while ((match = timeRegex.exec(line)) !== null) {
            times.push(+match[1] * 60000 + +match[2] * 1000 + +match[3].padEnd(3, '0'));
        }
        const text = line.replace(/\[\d{2}:\d{2}\.\d{2,3}\]/g, '').trim();
        if (text) times.forEach(t => result.push({ time: t, text }));
    }
    return result.sort((a, b) => a.time - b.time);
}

// 첫 가사가 시작되기 전(전주) 상태: 현재 줄에 ♪를 띄우고 첫 가사는 다음 줄에서 대기
const LYRIC_INTRO_MARK = '♪';
const LYRIC_INTRO_IDX = -100; // lastLyricIdx 초기값(-1)과 겹치지 않는 값

function getLyricContext(progress) {
    if (currentLyrics.length > 0 && progress < currentLyrics[0].time) {
        return {
            prev2: '', prev: '',
            current: LYRIC_INTRO_MARK,
            next: currentLyrics[0].text,
            next2: currentLyrics[1]?.text || '',
            idx: LYRIC_INTRO_IDX,
        };
    }
    let idx = 0;
    for (let i = 0; i < currentLyrics.length; i++) {
        if (currentLyrics[i].time <= progress) idx = i;
        else break;
    }
    return {
        prev2: currentLyrics[idx - 2]?.text || '',
        prev: currentLyrics[idx - 1]?.text || '',
        current: currentLyrics[idx]?.text || '',
        next: currentLyrics[idx + 1]?.text || '',
        next2: currentLyrics[idx + 2]?.text || '',
        idx,
    };
}

// 전체화면 가사: 한 줄씩 실제로 위로 스크롤 (사라졌다 나타나는 빈 간격 없음)
//  현재 줄 → 이전 줄 자리로 올라가며 작고 흐려지고, 다음 줄 → 현재 줄 자리로 올라오며 커지고 진해짐
const LYRIC_SCROLL_MS = 590;
// 천천히 시작해 천천히 멈추는 곡선 (초반에 확 튀어나가지 않도록)
const LYRIC_SCROLL_EASING = 'cubic-bezier(0.33, 0.5, 0.2, 1)';
// 사라지는 이전 줄/새로 나타나는 다음 줄은 줄 간격의 일부만 움직이며 흐려지고 나타남
const LYRIC_EDGE_TRAVEL = 0.7;

// els/texts: [이전2, 이전, 현재, 다음, 다음2] 순서
function animateLyricScroll(els, texts) {
    els.forEach(el => { el.getAnimations().forEach(a => a.finish()); el.style.removeProperty('opacity'); el.style.removeProperty('transform'); });
    const container = document.getElementById('lyrics-container');
    const last = els.length - 1;

    const oldTexts = els.map(el => el.textContent);
    // 한 줄씩 위로 넘어가는 경우만 스크롤 (현재 → 이전, 다음 → 현재)
    // 전주(♪) → 첫 가사로 넘어갈 때도 스크롤 (♪는 이전 줄로 가지 않고 사라짐)
    const isStep = !!oldTexts[2] && texts[2] === oldTexts[3] && (texts[1] === oldTexts[2] || oldTexts[2] === LYRIC_INTRO_MARK);

    if (!isStep) {
        // 곡 변경/탐색 등: 짧게 겹쳐 바뀌는 페이드 (빈 간격 없음)
        els.forEach((el, i) => { el.textContent = texts[i]; });
        updateLyricEdgeMask(container, els);
        els.forEach(el => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 285, easing: 'ease-out' }));
        return;
    }

    // 자리(slot)별 위치·글자 크기·색 (교체 전에 측정)
    const oldRects = els.map(el => el.getBoundingClientRect());
    const styles = els.map(el => getComputedStyle(el));
    const sizes = styles.map(st => parseFloat(st.fontSize));
    const colors = styles.map(st => st.color);

    // 맨 위 줄: 복제본을 그 자리에 두고 위로 밀어 올리며 사라지게 함
    if (oldTexts[0]) {
        const ghost = els[0].cloneNode(true);
        ghost.removeAttribute('id');
        ghost.className = 'lyric-ghost';
        Object.assign(ghost.style, {
            left: `${oldRects[0].left}px`, top: `${oldRects[0].top}px`, width: `${oldRects[0].width}px`,
            fontSize: styles[0].fontSize, fontWeight: styles[0].fontWeight, fontFamily: styles[0].fontFamily,
            lineHeight: styles[0].lineHeight, color: colors[0], textAlign: styles[0].textAlign,
        });
        document.body.appendChild(ghost);
        const lift = (oldRects[1].top - oldRects[0].top) * LYRIC_EDGE_TRAVEL;
        // 가장자리 흐림 영역에 있던 줄이므로 반투명에서 시작
        ghost.animate(
            [{ transform: 'translateY(0)', opacity: 0.35 }, { transform: `translateY(${-lift}px)`, opacity: 0 }],
            { duration: LYRIC_SCROLL_MS, easing: LYRIC_SCROLL_EASING }
        ).onfinish = () => ghost.remove();
    }

    els.forEach((el, i) => { el.textContent = texts[i]; });
    const newRects = els.map(el => el.getBoundingClientRect());
    updateLyricEdgeMask(container, els);

    // 각 줄은 바로 아래 자리(i+1)의 위치·크기·색에서 출발해 제자리로 올라옴
    for (let i = 0; i < last; i++) {
        els[i].animate([
            { transform: `translateY(${oldRects[i + 1].top - newRects[i].top}px) scale(${sizes[i + 1] / sizes[i]})`, color: colors[i + 1] },
            { transform: 'none', color: colors[i] },
        ], { duration: LYRIC_SCROLL_MS, easing: LYRIC_SCROLL_EASING });
    }

    // 맨 아래 새 줄: 아래에서 올라오며 나타남
    const rise = (newRects[last].top - newRects[last - 1].top) * LYRIC_EDGE_TRAVEL;
    els[last].animate([
        { transform: `translateY(${rise}px)`, opacity: 0 },
        { transform: 'none', opacity: 1 },
    ], { duration: LYRIC_SCROLL_MS, easing: LYRIC_SCROLL_EASING });
}

// 창 크기가 바뀌면 줄 위치가 달라지므로 흐림 경계 다시 계산
window.addEventListener('resize', () => {
    if (!document.body.classList.contains('fullscreen-mode')) return;
    const ids = ['prev2-lyric', 'prev-lyric', 'current-lyric', 'next-lyric', 'next2-lyric'];
    const els = ids.map(id => document.getElementById(id));
    if (els.every(Boolean)) updateLyricEdgeMask(document.getElementById('lyrics-container'), els);
});

// 가사 창 위아래 끝 흐림: 맨 위/맨 아래 줄이 절반쯤만 보이도록 그 줄 위치에 맞춰 마스크 경계를 설정
function updateLyricEdgeMask(container, els) {
    if (!container) return;
    const box = container.getBoundingClientRect();
    const first = els[0].getBoundingClientRect();
    const lastRect = els[els.length - 1].getBoundingClientRect();
    container.style.setProperty('--fade-top-start', `${Math.max(0, first.top - box.top)}px`);
    container.style.setProperty('--fade-top-end', `${Math.max(0, first.bottom - box.top)}px`);
    container.style.setProperty('--fade-bottom-start', `${Math.max(0, lastRect.top - box.top)}px`);
    container.style.setProperty('--fade-bottom-end', `${Math.max(0, lastRect.bottom - box.top)}px`);
}

function updateLyrics(prev, current, next, prev2 = '', next2 = '') {
    const prevEl = document.getElementById('prev-lyric');
    const currentEl = document.getElementById('current-lyric');
    const nextEl = document.getElementById('next-lyric');
    const container = document.getElementById('lyrics-container');
    const lpCurrentEl = document.getElementById('lp-current-lyric');

    const isFull = document.body.classList.contains('fullscreen-mode');

    const prev2El = document.getElementById('prev2-lyric');
    const next2El = document.getElementById('next2-lyric');
    const fullEls = [prev2El, prevEl, currentEl, nextEl, next2El];

    if (isFull && fullEls.every(Boolean)) {
        animateLyricScroll(fullEls, [prev2, prev, current, next, next2]);
        if (lpCurrentEl) lpCurrentEl.textContent = current;
        return;
    }

    // 위젯(바) 모드: 짧게 페이드아웃 → 글자 교체 → 가로 중앙 정렬 후 페이드인
    [prevEl, currentEl, nextEl].forEach(el => {
        if (el) el.style.setProperty('opacity', '0', 'important');
    });
    if (lpCurrentEl) lpCurrentEl.style.opacity = '0';

    setTimeout(() => {
        // 대기 중 전체화면으로 바뀌었다면 전체화면 방식으로 처리
        if (document.body.classList.contains('fullscreen-mode') && fullEls.every(Boolean)) {
            [prevEl, currentEl, nextEl].forEach(el => el.style.removeProperty('opacity'));
            animateLyricScroll(fullEls, [prev2, prev, current, next, next2]);
            if (lpCurrentEl) { lpCurrentEl.textContent = current; lpCurrentEl.style.opacity = '1'; }
            return;
        }

        if (prevEl) prevEl.textContent = prev;
        if (currentEl) currentEl.textContent = current;
        if (nextEl) nextEl.textContent = next;
        if (prev2El) prev2El.textContent = prev2;
        if (next2El) next2El.textContent = next2;
        if (lpCurrentEl) lpCurrentEl.textContent = current;

        if (container && currentEl && prevEl && nextEl) {
            const containerCenter = container.offsetWidth / 2;
            const currentHalf = currentEl.offsetWidth / 2;
            const gap = 32;
            prevEl.style.left = (containerCenter - currentHalf - gap - prevEl.offsetWidth) + 'px';
            nextEl.style.left = (containerCenter + currentHalf + gap) + 'px';
        }
        [prevEl, currentEl, nextEl].forEach(el => {
            if (el) el.style.setProperty('opacity', '1', 'important');
        });

        if (lpCurrentEl) lpCurrentEl.style.opacity = '1';
    }, 250);
}

// 🚨 매개변수에 videoId를 추가 (기본값 null)
async function fetchLyrics(title, artist, album, videoId = null, retryCount = 0) {
    if (title !== lastTitle || artist !== lastArtist) return;

    if (retryCount === 0) {
        isFetchingLyrics = true;
        updateLyrics('', '🎵 가사 찾는 중...', '');
    }

    try {
        // 🚨 1. URL 조립: videoId가 있으면 주소 끝에 붙여줍니다.
        let url = `http://127.0.0.1:8888/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`;
        if (videoId) {
            url += `&videoId=${encodeURIComponent(videoId)}`;
        }

        const res = await fetch(url).then(r => r.json());
        if (title !== lastTitle || artist !== lastArtist) return;

        currentLyrics = res.lyrics ? parseLRC(res.lyrics) : [];
        if (currentLyrics.length > 0) {
            lastLyricIdx = -1;
        } else {
            // 🚨 2. 재시도할 때도 videoId를 잊지 않고 넘겨줍니다.
            // 서버가 lrclib 검색 실패로 결과를 보류한 경우(retry)는 과부하가 풀리도록 조금 더 기다렸다가 재시도
            if (retryCount < 2) { setTimeout(() => fetchLyrics(title, artist, album, videoId, retryCount + 1), res.retry ? 5000 : 2000); return; }
            updateLyrics('', '가사 없음', '');
        }
    } catch (e) {
        if (title !== lastTitle || artist !== lastArtist) return;
        // 🚨 3. 에러로 인한 재시도 시에도 videoId를 넘겨줍니다.
        if (retryCount < 2) { setTimeout(() => fetchLyrics(title, artist, album, videoId, retryCount + 1), 2000); return; }
        updateLyrics('', '가사 없음', '');
    } finally {
        isFetchingLyrics = false;
    }
}

// 괄호 밖의 구분선에서만 나눔 (예: "orion - [米津玄師 / 요네즈 켄시] ㅣ아카네 리제"의 괄호 안 " / "는 구분선이 아님)
function splitTitleParts(title) {
    const masked = title.replace(/[\[(（【][^\])）】]*[\])）】]/g, m => '\0'.repeat(m.length));
    const parts = [];
    let start = 0;
    for (const m of masked.matchAll(/\s+[\/|｜]\s+|\s*ㅣ\s*/g)) {
        parts.push(title.slice(start, m.index));
        start = m.index + m[0].length;
    }
    parts.push(title.slice(start));
    return parts;
}

// 화면에 보여줄 곡 제목: 일반 영상(커버 등)은 "orion - [米津玄師 / 요네즈 켄시] ㅣ아카네 리제 【COVER】"처럼
// 영상 제목 전체가 오므로 곡명만 남김. 구분선이나 [ ], 【 】가 없는 제목(공식 음원 등)은 그대로 둠
function displayTitle(title) {
    const raw = (title || '').trim();
    if (!/\s[\/|｜]\s|ㅣ|[\[【]/.test(raw)) return raw;
    const songPart = splitTitleParts(raw)[0];
    const cleaned = songPart
        .replace(/\[[^\]]*\]|【[^】]*】/g, ' ')
        .replace(/[(（][^)）]*(cover|커버|official|m\/?v|live|라이브|ver\.?|version|歌ってみた)[^)）]*[)）]/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-–~:]+|[\s\-–~:]+$/g, '')
        .trim();
    return cleaned || raw;
}

// ═════════════════════════════════════════════════════════════
//  5. 🖥️ 전체화면 토글 및 UI 겹침 방지 (높이 센서)
// ═════════════════════════════════════════════════════════════
let isFullscreen = false;
const iconMaximize = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>`;
const btnFullscreen = document.getElementById('btn-fullscreen');

if (btnFullscreen) {
    btnFullscreen.innerHTML = iconMaximize;
    btnFullscreen.addEventListener('click', toggleFullscreen);
}

document.addEventListener('dblclick', (e) => {
    if (document.getElementById('settings-modal')?.classList.contains('show')) return;

    if (e.target.closest('.controls, .setting-item, #lyrics-container, #track-info, #btn-fullscreen')) return;
    toggleFullscreen();
});

function toggleFullscreen() {
    isFullscreen = !isFullscreen;
    if (isFullscreen) {
        document.body.classList.add('fullscreen-mode');
        ipcRenderer.send('toggle-fullscreen', true);
    } else {
        document.body.classList.remove('fullscreen-mode');
        ipcRenderer.send('toggle-fullscreen', false);
    }
    lastLyricIdx = -1;
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen) toggleFullscreen();

    // ↑ / ↓: 가사 싱크 ±50ms (↑ = 가사를 더 일찍, ↓ = 더 늦게. 설정 창 싱크 값과 같은 값)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.target.closest?.('input, textarea, select')) {
        e.preventDefault();
        appConfig.syncOffset += e.key === 'ArrowUp' ? 50 : -50;
        saveSettings();
        applyConfigToUI();
        showSyncToast();
    }
});

let syncToastTimer = null;
function showSyncToast() {
    let toast = document.getElementById('sync-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'sync-toast';
        document.body.appendChild(toast);
    }
    const ms = appConfig.syncOffset;
    toast.textContent = `가사 싱크 ${ms > 0 ? '+' : ''}${ms}ms`;
    toast.classList.add('show');
    clearTimeout(syncToastTimer);
    syncToastTimer = setTimeout(() => toast.classList.remove('show'), 1200);
}

// 🚨 곡 정보 상자 높이 실시간 추적 (버튼 겹침 완벽 방지)
function updateTrackHeight() {
    const tiEl = document.getElementById('track-info');
    if (tiEl) document.documentElement.style.setProperty('--ti-h', tiEl.offsetHeight + 'px');
}

const trackInfoObserver = new ResizeObserver(() => updateTrackHeight());
setTimeout(() => {
    const tiEl = document.getElementById('track-info');
    if (tiEl) trackInfoObserver.observe(tiEl);
    updateTrackHeight();
}, 500);

const bodyObserver = new MutationObserver(() => setTimeout(updateTrackHeight, 50));
bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

// ═════════════════════════════════════════════════════════════
//  6. 🔄 서버 폴링 & 앨범 아트 추출 & 진행바
// ═════════════════════════════════════════════════════════════
async function syncWithServer() {
    try {
        const track = await fetch('http://127.0.0.1:8888/current-track').then(r => r.json());
        const fetchedAt = performance.now();

        // 진행 시간은 측정 시점 기준이므로, 그 뒤로 흐른 시간(전송·폴링 지연)만큼 보정
        if (track.playing && track.sampledAt) {
            const age = Date.now() - track.sampledAt;
            if (age > 0 && age < 5000) track.progress += age;
        }
        // 가사 클릭으로 이동한 직후, 이동 전에 측정된 위치가 오면 가사가 되돌아가므로 위젯이 계산한 위치를 유지
        if (track.sampledAt && track.sampledAt < lastSeekAt && lastSyncTime !== null) {
            track.progress = localProgress + (fetchedAt - lastSyncTime);
        }

        // 1. 재생 상태 확인 및 이퀄라이저 제어
        if (!track.playing) {
            isPlaying = false;
            lastSyncTime = null;
            stopEQ();
            document.getElementById('btn-play-pause').textContent = '▶';
            const lpPlayBtn = document.getElementById('lp-btn-play');
            if (lpPlayBtn) lpPlayBtn.textContent = '▶';
            document.getElementById('vinyl-record')?.classList.remove('playing');

            if (!isPausedDisplayed) {
                isPausedDisplayed = true;
                updateLyrics('', '⏸', '');
            }
            return;
        }

        // 🚨 이퀄라이저 생존 정밀 확인: 단순히 변수 유무가 아니라 실제 연결 상태(OPEN)까지 체크
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) startEQ();

        document.getElementById('btn-play-pause').textContent = '⏸';
        const lpPlayBtn = document.getElementById('lp-btn-play');
        if (lpPlayBtn) lpPlayBtn.textContent = '⏸';
        document.getElementById('vinyl-record')?.classList.add('playing');
        isPausedDisplayed = false;

        const isSongChanged = track.title !== lastTitle;
        const isArtistChanged = track.artist !== lastArtist;

        // 2. 곡 변경 처리 및 UI 초기화
        if (track.title && track.title !== 'YouTube Music' && (isSongChanged || isArtistChanged)) {
            // 다이내믹 UI 컬러 초기화 (하얀색 튐 방지 및 기본 다크모드)
            document.documentElement.style.setProperty('--bg-color', '#1a1a1a');
            document.documentElement.style.setProperty('--theme-color', '#ffffff');
            document.documentElement.style.setProperty('--ui-primary', '#ffffff');
            document.documentElement.style.setProperty('--ui-secondary', 'rgba(255, 255, 255, 0.6)');
            document.documentElement.style.setProperty('--ui-lyric-dim', 'rgba(255, 255, 255, 0.25)');
            document.documentElement.style.setProperty('--ui-glow', 'rgba(255, 255, 255, 0.8)');
            document.documentElement.style.setProperty('--ui-glow-dim', 'rgba(255, 255, 255, 0.5)');
            document.documentElement.style.setProperty('--ui-bg', 'rgba(255, 255, 255, 0.15)');

            if (!isSongChanged && isArtistChanged && currentLyrics.length > 0) {
                lastArtist = track.artist;
                document.getElementById('artist').textContent = track.artist;
                const lpArtist = document.getElementById('lp-widget-artist');
                if (lpArtist) lpArtist.textContent = track.artist;
            } else {
                if (isSongChanged) localProgress = track.progress > 5000 ? 0 : track.progress;
                // 싱크 조절은 곡마다 다르므로 곡이 바뀌면 0으로 초기화
                if (isSongChanged && appConfig.syncOffset !== 0) {
                    appConfig.syncOffset = 0;
                    saveSettings();
                    applyConfigToUI();
                }
                lastTitle = track.title;
                lastArtist = track.artist;
                lastLyricIdx = -1;
                currentLyrics = [];

                const trackInfo = document.getElementById('track-info');
                const lyricsContainer = document.getElementById('lyrics-container');
                const lpTextInfo = document.querySelector('.lp-text-info');

                if (trackInfo && lyricsContainer) { trackInfo.classList.add('fade'); lyricsContainer.classList.add('fade'); }
                if (lpTextInfo) lpTextInfo.classList.add('fade');

                await new Promise(r => setTimeout(r, 400));

                document.getElementById('title').textContent = displayTitle(track.title);
                document.getElementById('artist').textContent = track.artist || 'Unknown Artist';
                const lpTitle = document.getElementById('lp-widget-title');
                const lpArtist = document.getElementById('lp-widget-artist');
                if (lpTitle) lpTitle.textContent = displayTitle(track.title);
                if (lpArtist) lpArtist.textContent = track.artist || 'Unknown Artist';

                if (trackInfo && lyricsContainer) { trackInfo.classList.remove('fade'); lyricsContainer.classList.remove('fade'); }
                if (lpTextInfo) lpTextInfo.classList.remove('fade');

                // 🚨 영상 ID 확보 (서버가 영어 제목/가수 조회에 사용)
                let vid = track.videoId || null;
                if (!vid && track.albumArt && track.albumArt.includes('i.ytimg.com')) {
                    vid = track.albumArt.match(/\/vi\/([^\/]+)\//)?.[1];
                }

                // 확보한 영상 ID를 함께 넘겨서 가사 요청
                fetchLyrics(track.title, track.artist, track.album, vid);
            }
        } else {
            if (track.progress < localProgress - 2000) lastLyricIdx = -1;
            localProgress = track.progress;
        }

        // 곡 전환 시 페이드(400ms) 대기 시간이 진행 시간에 누락되지 않도록 응답 받은 시점을 기준으로 사용
        lastSyncTime = fetchedAt;
        isPlaying = true;
        trackDuration = track.duration;

        // 3. 앨범 아트 다중 화질 추적 및 타임아웃 최적화
        const albumArtEl = document.getElementById('album-art');
        const lpCover = document.getElementById('lp-widget-cover');
        let originalArt = track.albumArt;
        let tryUrls = [];

        if (originalArt) {
            if (originalArt.includes('i.ytimg.com')) {
                const vid = originalArt.match(/\/vi\/([^\/]+)\//)?.[1];
                if (vid) {
                    tryUrls.push(`https://i.ytimg.com/vi/${vid}/maxresdefault.jpg`);
                    tryUrls.push(`https://i.ytimg.com/vi/${vid}/sddefault.jpg`);
                }
            } else {
                tryUrls.push(originalArt.replace(/([=-])w\d+-h\d+/, '$1w1024-h1024'));
                tryUrls.push(originalArt.replace(/([=-])w\d+-h\d+/, '$1w544-h544'));
            }
            tryUrls.push(originalArt);
        }

        if (originalArt && albumArtEl) {
            if (albumArtEl.getAttribute('data-src') !== originalArt) {

                albumArtEl.setAttribute('data-src', originalArt);
                albumArtEl.classList.remove('visible');
                if (lpCover) lpCover.classList.add('fade');

                const loadNextImage = (index) => {
                    if (index >= tryUrls.length) return;
                    const tempImg = new Image();
                    tempImg.crossOrigin = 'Anonymous';

                    const timeoutId = setTimeout(() => {
                        tempImg.src = "";
                        loadNextImage(index + 1);
                    }, 2500);

                    tempImg.onload = () => {
                        clearTimeout(timeoutId);
                        // 유튜브 영상 썸네일(16:9)이 정사각형으로 잘리지 않도록 원본 비율 전달 (세로로 긴 이미지는 정사각형 처리)
                        const ratio = tempImg.naturalWidth / tempImg.naturalHeight;
                        albumArtEl.style.setProperty('--art-ratio', ratio > 1 ? ratio : 1);
                        albumArtEl.crossOrigin = 'Anonymous';
                        albumArtEl.src = tryUrls[index];
                        albumArtEl.classList.add('visible');

                        setTimeout(() => { try { applyGradient(albumArtEl); } catch (e) { } }, 50);

                        if (lpCover) {
                            lpCover.crossOrigin = 'Anonymous';
                            lpCover.src = tryUrls[index];
                            lpCover.classList.remove('fade');
                        }
                    };

                    tempImg.onerror = () => {
                        clearTimeout(timeoutId);
                        loadNextImage(index + 1);
                    };
                    tempImg.src = tryUrls[index];
                };
                loadNextImage(0);

            } else if (isSongChanged || isArtistChanged) {
                setTimeout(() => {
                    try { applyGradient(albumArtEl); } catch (e) { }
                }, 50);
            }
        }

        // 마지막으로 이퀄라이저 실행 재확인
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) startEQ();

    } catch (e) {
        console.error('동기화 실패:', e);
        // 에러 발생 시 세션 재연결 시도
        if (!wsClient || wsClient.readyState !== WebSocket.OPEN) startEQ();
    }
}

// 가사 전환 페이드(250ms)가 끝날 때 가사가 정확히 보이도록 살짝 앞당김
const LYRIC_LEAD_MS = 300;

// ─── 전체화면 가사 클릭 → 그 가사 위치로 이동 ───
// 줄 순서: [앞앞, 앞, 현재, 다음, 다음다음] → 현재 가사 기준 -2 ~ +2
let shownLyricIdx = -1;
let lastSeekAt = 0; // 이동 요청 시각 (이보다 먼저 측정된 재생 위치는 이동 전 값이므로 무시)
const LYRIC_SLOT_OFFSETS = { 'prev2-lyric': -2, 'prev-lyric': -1, 'current-lyric': 0, 'next-lyric': 1, 'next2-lyric': 2 };

function seekTo(ms) {
    ms = Math.max(0, Math.round(ms));
    lastSeekAt = Date.now();
    // 응답을 기다리지 않고 화면부터 바로 이동
    localProgress = ms;
    lastSyncTime = performance.now();
    // 일시정지 중에도 가사 표시가 바로 이동하도록 직접 갱신
    const { prev2, prev, current, next, next2, idx } = getLyricContext(ms + LYRIC_LEAD_MS + appConfig.syncOffset);
    lastLyricIdx = idx; shownLyricIdx = idx;
    updateLyrics(prev, current, next, prev2, next2);
    fetch('http://127.0.0.1:8888/seek', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms })
    }).catch(() => { });
}

Object.entries(LYRIC_SLOT_OFFSETS).forEach(([id, offset]) => {
    document.getElementById(id)?.addEventListener('click', () => {
        if (!document.body.classList.contains('fullscreen-mode') || currentLyrics.length === 0) return;
        // 전주(♪) 표시 중에는 다음 줄이 첫 가사
        const base = shownLyricIdx === LYRIC_INTRO_IDX ? -1 : shownLyricIdx;
        const lyric = currentLyrics[base + offset];
        if (!lyric) return;
        // 가사가 현재 줄이 되는 시점(재생 위치 + 싱크 조절 ≥ 가사 시각)에 맞춰, 싱크 조절값만큼 보정한 위치로 이동
        seekTo(lyric.time - appConfig.syncOffset);
    });
});

function tickProgress() {
    if (!isPlaying || lastSyncTime === null || !trackDuration || trackDuration <= 0) {
        requestAnimationFrame(tickProgress); return;
    }
    const now = performance.now();
    const progress = Math.min(localProgress + (now - lastSyncTime), trackDuration);
    let percent = Math.max(0, Math.min(100, (progress / trackDuration) * 100));
    if (isNaN(percent) || !isFinite(percent)) percent = 0;

    const progressFill = document.getElementById('progress-fill');
    if (progressFill) progressFill.style.width = `${percent}%`;
    const lpProgressFill = document.getElementById('lp-progress-fill');
    if (lpProgressFill) lpProgressFill.style.width = `${percent}%`;

    if (currentLyrics.length > 0 && (now - lastLyricCheckTime > 100)) {
        lastLyricCheckTime = now;
        const { prev2, prev, current, next, next2, idx } = getLyricContext(progress + LYRIC_LEAD_MS + appConfig.syncOffset);
        if (idx !== lastLyricIdx) { lastLyricIdx = idx; shownLyricIdx = idx; updateLyrics(prev, current, next, prev2, next2); }
    }
    requestAnimationFrame(tickProgress);
}

// ═════════════════════════════════════════════════════════════
//  7. 🎛️ 미디어 컨트롤 및 이퀄라이저 (스프링 물리)
// ═════════════════════════════════════════════════════════════
async function sendControlRequest(command) {
    if (command === 'play-pause') {
        const wasPlaying = isPlaying;
        isPlaying = !wasPlaying;
        document.getElementById('btn-play-pause').textContent = isPlaying ? '⏸' : '▶';
        await fetch('http://127.0.0.1:8888/play-pause', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playing: wasPlaying })
        });
    } else {
        lastTitle = ''; lastLyricIdx = -1; currentLyrics = []; updateLyrics('', '🎵', '');
        await fetch(`http://127.0.0.1:8888/${command}`, { method: 'POST' });
    }
    setTimeout(syncWithServer, 500);
}

document.getElementById('btn-play-pause')?.addEventListener('click', () => sendControlRequest('play-pause'));
document.getElementById('lp-btn-play')?.addEventListener('click', () => sendControlRequest('play-pause'));
document.getElementById('btn-prev')?.addEventListener('click', () => sendControlRequest('previous'));
document.getElementById('lp-btn-prev')?.addEventListener('click', () => sendControlRequest('previous'));
document.getElementById('btn-next')?.addEventListener('click', () => sendControlRequest('next'));
document.getElementById('lp-btn-next')?.addEventListener('click', () => sendControlRequest('next'));

let wsClient = null;
let visualizerMode = 'BARS';
let eqAnimationFrameId = null;

document.getElementById('equalizer')?.addEventListener('click', () => { visualizerMode = visualizerMode === 'BARS' ? 'WAVE' : 'BARS'; });

// 이퀄라이저 시작 함수 수정
function startEQ() {
    // 이미 연결이 열려있는 상태라면 중복 생성 방지
    if (wsClient && wsClient.readyState === WebSocket.OPEN) return;

    // 비정상적인 기존 연결이 남아있다면 정리
    if (wsClient) stopEQ();

    try {
        wsClient = new WebSocket('ws://127.0.0.1:8889'); //

        wsClient.onopen = () => {
            console.log("EQ 소켓 연결 성공");
            wsClient.send(JSON.stringify({ type: 'register_renderer' }));
        };

        const bars = document.querySelectorAll('#equalizer .bar');
        let currentValues = new Array(10).fill(0);
        let latestEqData = new Array(10).fill(0);
        let currentRenderMode = '';
        let lastFrameTime = 0;

        // 🎵 iOS Dynamic Island 이퀄라이저 스타일: 목표 높이를 넘지 않고(출렁임 없이) 부드럽게 따라감.
        //    올라갈 때는 빠르게, 내려올 때는 천천히 (시간 상수 ms, 화면 주사율과 관계없이 같은 속도)
        const ATTACK_MS = 45;
        const RELEASE_MS = 110;
        // 막대 높이(px): 소리가 없을 때는 막대 폭만 한 둥근 점, 최대는 바 높이(44px) 안에 들어가도록
        const BAR_MIN_PX = 3.5;
        const BAR_BASE_PX = 16;
        // 움직임 강조: 막대마다 최근 평균 높이를 천천히 따라가는 기준선을 두고, 기준선에서 벗어난 만큼을 키워서 보여줌
        //   → 계속 큰 소리(예: 베이스가 큰 곡의 저음역)는 낮아지고 비트가 칠 때의 변화가 크게 보임
        let baselines = new Array(10).fill(0);
        const BASELINE_RISE_MS = 1500;  // 기준선이 올라가는 속도 (느리게 → 비트가 기준선에 묻히지 않음)
        const BASELINE_FALL_MS = 300;   // 기준선이 내려가는 속도 (조용해지면 빠르게 따라 내려감)
        const BASELINE_WEIGHT = 0.8;    // 기준선을 얼마나 빼는지
        const MOTION_GAIN = 2.6;        // 남은 변화량을 얼마나 키우는지
        const BASELINE_SNAP_RATIO = 0.5; // 기준선이 소리의 절반보다 낮으면
        const BASELINE_LOCK_MS = 400;    // 이 시간 동안 기준선을 소리에 고정
        let baselineLock = new Array(10).fill(0);

        // 분석 범위를 올린 만큼(15dB = 255 / 70dB × 15)의 값, 막대 최대 높이 (기본 16px의 배수, 바 높이 44px 안에 들어가도록)
        const EQ_HEADROOM = 255 / 70 * 15;
        const EQ_MAX_SCALE = 2.0;
        function renderVisualizer() {
            if (!isPlaying) {
                latestEqData = new Array(10).fill(0);
            }

            let isAnimating = false;

            if (currentRenderMode !== visualizerMode) {
                currentRenderMode = visualizerMode;
                bars.forEach(bar => {
                    // 🚨 핵심: 자바스크립트 제어 시 CSS transition과의 충돌 방지
                    bar.style.transition = 'background 0.5s ease, box-shadow 0.5s ease';
                    if (visualizerMode === 'BARS') {
                        // 크기는 매 프레임 높이로 조절 (scaleY로 늘리면 둥근 끝도 같이 늘어나 찌그러짐)
                        bar.style.transform = 'none';
                        bar.style.borderRadius = '';
                    } else {
                        bar.style.height = '3.5px';
                        bar.style.borderRadius = '50%';
                    }
                });
            }

            const now = performance.now();
            const dt = lastFrameTime ? Math.min(now - lastFrameTime, 100) : 16;
            lastFrameTime = now;

            bars.forEach((bar, index) => {
                // Tampermonkey가 분석 범위를 15dB 올려 보내므로 그만큼 더해 원래 높이로 복원 (255를 넘는 값 = 예전엔 최대치에 붙던 큰 소리)
                const raw = latestEqData[index] || 0;
                let targetValue = (raw > 0 ? raw + EQ_HEADROOM : 0) * 0.5;
                const diff = targetValue - currentValues[index];
                const tau = diff > 0 ? ATTACK_MS : RELEASE_MS;
                currentValues[index] += diff * (1 - Math.exp(-dt / tau));

                if (Math.abs(diff) < 0.1) {
                    currentValues[index] = targetValue;
                } else {
                    isAnimating = true;
                }

                const smoothed = Math.max(0, currentValues[index]);
                // 재생 시작/일시정지 후 재개처럼 기준선이 소리보다 한참 낮으면, 소리가 자리 잡을 때까지 잠깐 기준선을 소리에 고정
                //   (천천히 따라가게 두면 처음 1~2초 동안 모든 막대가 최대로 튀었다가 내려옴)
                if (baselines[index] < smoothed * BASELINE_SNAP_RATIO) baselineLock[index] = BASELINE_LOCK_MS;
                if (baselineLock[index] > 0) {
                    baselines[index] = smoothed;
                    baselineLock[index] -= dt;
                } else {
                    const baseTau = smoothed > baselines[index] ? BASELINE_RISE_MS : BASELINE_FALL_MS;
                    baselines[index] += (smoothed - baselines[index]) * (1 - Math.exp(-dt / baseTau));
                }
                let value = Math.max(0, (smoothed - baselines[index] * BASELINE_WEIGHT) * MOTION_GAIN);

                if (visualizerMode === 'BARS') {
                    let baseScale = Math.max(0.2, (value / 255) * 1.75);
                    let boostMultiplier = 1 + (index / (bars.length - 1)) * 1.5;
                    if (index === 0) boostMultiplier *= 1.8;
                    if (index === 1) boostMultiplier *= 1.6;
                    const scale = Math.min(baseScale * boostMultiplier, EQ_MAX_SCALE);
                    bar.style.height = `${Math.max(BAR_MIN_PX, BAR_BASE_PX * scale).toFixed(1)}px`;
                } else {
                    let totalVolume = currentValues.reduce((a, b) => a + b, 0);
                    bar.style.transform = `scaleY(1) translateY(${Math.sin((Date.now() / 150) + index) * ((totalVolume / 10 / 25) + 2)}px)`;
                }
            });

            if (isPlaying || isAnimating) {
                eqAnimationFrameId = requestAnimationFrame(renderVisualizer);
            } else {
                eqAnimationFrameId = null;
            }
        }

        wsClient.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'eq_data') {
                latestEqData = msg.data;
                if (!eqAnimationFrameId) {
                    eqAnimationFrameId = requestAnimationFrame(renderVisualizer);
                }
            }
        };

        wsClient.onerror = () => stopEQ();
        wsClient.onclose = () => stopEQ();

    } catch (e) {
        console.error("EQ 시작 실패:", e);
        stopEQ();
    }
}

// 이퀄라이저 중단 함수 수정
function stopEQ() {
    if (wsClient) {
        wsClient.onopen = null;
        wsClient.onmessage = null;
        wsClient.onerror = null;
        wsClient.onclose = null;
        if (wsClient.readyState === WebSocket.OPEN) {
            wsClient.close();
        }
        wsClient = null;
    }
    if (eqAnimationFrameId) {
        cancelAnimationFrame(eqAnimationFrameId);
        eqAnimationFrameId = null;
    }

    document.querySelectorAll('#equalizer .bar').forEach(bar => {
        // 중단 시에만 다시 transition을 적용하여 부드럽게 복구
        bar.style.transition = 'height 0.12s ease, transform 0.12s ease, background 0.5s ease';
        bar.style.height = '3.5px';
        bar.style.transform = 'translateY(0) scaleY(1)';
    });
}

// ═════════════════════════════════════════════════════════════
//  8. ⚙️ UI 업데이트 및 설정 모달 이벤트 바인딩
// ═════════════════════════════════════════════════════════════
function applyConfigToUI() {
    const autoFadeToggle = document.getElementById('auto-fade-toggle');
    if (autoFadeToggle) autoFadeToggle.checked = appConfig.autoFade;
    if (appConfig.autoFade) enableAutoFade(); else disableAutoFade();

    const opacitySlider = document.getElementById('opacity-slider');
    if (opacitySlider) {
        opacitySlider.value = appConfig.opacity;
        document.getElementById('opacity-value').textContent = Math.round(appConfig.opacity * 100) + '%';
    }
    const alwaysOnTopToggle = document.getElementById('always-on-top-toggle');
    if (alwaysOnTopToggle) alwaysOnTopToggle.checked = appConfig.alwaysOnTop;
    const shortcutsToggle = document.getElementById('shortcuts-toggle');
    if (shortcutsToggle) shortcutsToggle.checked = appConfig.globalShortcut;
    const offsetDisplay = document.getElementById('offset-display');
    if (offsetDisplay) offsetDisplay.textContent = `${appConfig.syncOffset > 0 ? '+' : ''}${appConfig.syncOffset}ms`;

    document.querySelectorAll('.theme-pill[data-theme]').forEach(btn => btn.classList.toggle('active', btn.dataset.theme === appConfig.theme));
    document.querySelectorAll('.widget-style-pills .theme-pill').forEach(btn => btn.classList.toggle('active', btn.dataset.widget === appConfig.widgetStyle));
    document.querySelectorAll('.tray-icon-pills .theme-pill').forEach(btn => btn.classList.toggle('active', btn.dataset.icon === appConfig.trayIcon));
}

function applyConfigToApp() {
    if (!appConfig.autoFade) {
        const barMode = document.getElementById('bar-mode');
        const lpMode = document.getElementById('lp-mode');
        if (barMode) barMode.style.opacity = appConfig.opacity;
        if (lpMode) lpMode.style.opacity = appConfig.opacity;
    }
    document.body.setAttribute('data-theme', appConfig.theme);
    applyGradient(null);

    ipcRenderer.send('update-system-settings', {
        alwaysOnTop: appConfig.alwaysOnTop,
        globalShortcut: appConfig.globalShortcut,
        widgetStyle: appConfig.widgetStyle,
        trayIcon: appConfig.trayIcon
    });
}

function scheduleFade() {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
        if (isFullscreen) return; // 전체화면에서는 흐리게 하지 않음
        const bar = document.getElementById('bar');
        if (bar) { bar.style.transition = 'background 1.5s ease, opacity 1.2s ease'; bar.style.opacity = '0.65'; }
    }, 3000);
}

function onMouseMove() {
    const bar = document.getElementById('bar');
    if (bar) { bar.style.transition = 'background 1.5s ease, opacity 0.15s ease'; bar.style.opacity = '1'; }
    scheduleFade();
}

function enableAutoFade() {
    document.addEventListener('mousemove', onMouseMove);
    scheduleFade();
    document.getElementById('opacity-section')?.classList.add('section-disabled');
}

function disableAutoFade() {
    clearTimeout(fadeTimer);
    document.removeEventListener('mousemove', onMouseMove);
    const bar = document.getElementById('bar');
    if (bar) { bar.style.transition = 'background 1.5s ease, opacity 0.15s ease'; bar.style.opacity = appConfig.opacity; }
    document.getElementById('opacity-section')?.classList.remove('section-disabled');
}

document.getElementById('opacity-slider')?.addEventListener('input', (e) => {
    appConfig.opacity = parseFloat(e.target.value);
    document.getElementById('opacity-value').textContent = Math.round(appConfig.opacity * 100) + '%';
    applyConfigToApp();
});
document.getElementById('opacity-slider')?.addEventListener('change', saveSettings);

document.getElementById('auto-fade-toggle')?.addEventListener('change', (e) => {
    appConfig.autoFade = e.target.checked;
    saveSettings();
    if (appConfig.autoFade) enableAutoFade(); else disableAutoFade();
});

['always-on-top-toggle', 'shortcuts-toggle'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', (e) => {
        appConfig[id === 'always-on-top-toggle' ? 'alwaysOnTop' : 'globalShortcut'] = e.target.checked;
        saveSettings();
    });
});

document.getElementById('offset-minus')?.addEventListener('click', () => { appConfig.syncOffset -= 100; saveSettings(); applyConfigToUI(); });
document.getElementById('offset-plus')?.addEventListener('click', () => { appConfig.syncOffset += 100; saveSettings(); applyConfigToUI(); });

document.querySelectorAll('.theme-pill[data-theme]').forEach(btn => {
    btn.addEventListener('click', (e) => { appConfig.theme = e.currentTarget.dataset.theme; saveSettings(); applyConfigToUI(); applyConfigToApp(); });
});
document.querySelectorAll('.widget-style-pills .theme-pill').forEach(btn => {
    btn.addEventListener('click', (e) => { appConfig.widgetStyle = e.currentTarget.dataset.widget; saveSettings(); applyConfigToUI(); });
});
document.querySelectorAll('.tray-icon-pills .theme-pill').forEach(btn => {
    btn.addEventListener('click', (e) => { appConfig.trayIcon = e.currentTarget.dataset.icon; saveSettings(); applyConfigToUI(); });
});

// ═════════════════════════════════════════════════════════════
//  9. 🪟 IPC 수신 (메인 프로세스와 통신)
// ═════════════════════════════════════════════════════════════
ipcRenderer.on('change-style', (event, style) => {
    const barMode = document.getElementById('bar-mode');
    const lpMode = document.getElementById('lp-mode');
    if (!barMode || !lpMode) return;
    if (style === 'lp') { barMode.classList.remove('mode-active'); lpMode.classList.add('mode-active'); }
    else { lpMode.classList.remove('mode-active'); barMode.classList.add('mode-active'); }
});

ipcRenderer.on('hide-widget-for-settings', () => document.body.classList.add('settings-open'));

// 🚨 설정창 열기 시 전체화면 해제 로직
ipcRenderer.on('open-settings', () => {
    if (isFullscreen) toggleFullscreen();
    document.getElementById('settings-modal').classList.add('show');
});

ipcRenderer.on('show-widget-after-settings', () => document.body.classList.remove('settings-open'));

document.getElementById('settings-close')?.addEventListener('click', closeSettingsModal);
function closeSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('closing');
    setTimeout(() => {
        if (modal) { modal.classList.remove('show'); modal.classList.remove('closing'); }
        ipcRenderer.send('close-settings');
    }, 350);
}

// ═════════════════════════════════════════════════════════════
//  10. 🚀 앱 부팅 및 메인 루프 실행
// ═════════════════════════════════════════════════════════════
initSettings();
tickProgress();
syncWithServer();
setInterval(syncWithServer, 3000);