const { ipcRenderer } = require('electron');

// ─── 전역 상태 및 변수 ───────────────────────────────────
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

// ─── ⚙️ 앱 설정 (Config) 초기화 및 관리 ──────────────────
let appConfig = {
    isPro: false,
    opacity: 1.0,
    autoFade: false,
    theme: 'auto',
    syncOffset: 0, // 기본 0ms
    alwaysOnTop: true,
    globalShortcut: true,
    widgetStyle: 'eq',
    trayIcon: 'player',
    musicService: 'youtube'
};

function initSettings() {
    const saved = localStorage.getItem('lyricsBarSettings');
    if (saved) {
        appConfig = { ...appConfig, ...JSON.parse(saved) };
    }
    // 서버에 초기 서비스 상태 알림
    fetch('http://127.0.0.1:8888/set-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: appConfig.musicService })
    }).catch(e => console.error("서버 초기화 에러:", e));

    applyConfigToUI();
    applyConfigToApp();
}

function saveSettings() {
    localStorage.setItem('lyricsBarSettings', JSON.stringify(appConfig));
    applyConfigToApp();
}

// ─── 🎨 색상 추출 및 테마 (Gradient) 적용 ────────────────
function extractColor(imgEl) {
    const canvas = document.createElement('canvas');
    canvas.width = 10; canvas.height = 10;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgEl, 0, 0, 10, 10);
    const data = ctx.getImageData(0, 0, 10, 10).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) {
        r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
    const count = data.length / 4;
    return `${Math.floor(r / count)}, ${Math.floor(g / count)}, ${Math.floor(b / count)}`;
}

function applyGradient(imgEl) {
    if (imgEl) lastAlbumImg = imgEl;
    const img = lastAlbumImg;
    if (!img) return;

    const bar = document.getElementById('bar');
    const lpMode = document.getElementById('lp-mode');
    const titleEl = document.getElementById('title');
    const artistEl = document.getElementById('artist');

    // PRO 테마 분기
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

    // Auto / Accent 테마 (색상 추출 필요)
    if (bar) bar.style.backdropFilter = '';
    const color = extractColor(img);
    const [r, g, b] = color.split(',').map(Number);
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const isLight = brightness > 128;

    if (appConfig.theme === 'accent') {
        if (bar) bar.style.background = `linear-gradient(90deg, rgba(${color}, 1.0) 0%, rgba(${color}, 0.85) 45%, rgba(${color}, 0.2) 100%)`;
    } else { // 기본 Auto
        if (bar) bar.style.background = `linear-gradient(90deg, rgba(${color}, 0.9) 0%, rgba(${color}, 0.5) 25%, rgba(15,15,15,0.92) 55%)`;
        if (lpMode) lpMode.style.background = `linear-gradient(180deg, rgb(${color}) 0%, rgb(35, 35, 35) 75%, rgb(15, 15, 15) 100%)`;
    }

    if (titleEl) titleEl.style.color = isLight ? '#000' : '#fff';
    if (artistEl) artistEl.style.color = isLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.5)';
    document.documentElement.style.setProperty('--theme-color', `rgb(${color})`);
}

// ─── 📝 가사(LRC) 파싱 및 렌더링 ─────────────────────────
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

function getLyricContext(progress) {
    let idx = 0;
    for (let i = 0; i < currentLyrics.length; i++) {
        if (currentLyrics[i].time <= progress) idx = i;
        else break;
    }
    return {
        prev: currentLyrics[idx - 1]?.text || '',
        current: currentLyrics[idx]?.text || '',
        next: currentLyrics[idx + 1]?.text || '',
        idx,
    };
}

function updateLyrics(prev, current, next) {
    const prevEl = document.getElementById('prev-lyric');
    const currentEl = document.getElementById('current-lyric');
    const nextEl = document.getElementById('next-lyric');
    const container = document.getElementById('lyrics-container');
    const lpCurrentEl = document.getElementById('lp-current-lyric');

    [prevEl, currentEl, nextEl, lpCurrentEl].forEach(el => { if (el) el.style.opacity = '0'; });

    setTimeout(() => {
        if (prevEl) prevEl.textContent = prev;
        if (currentEl) currentEl.textContent = current;
        if (nextEl) nextEl.textContent = next;
        if (lpCurrentEl) lpCurrentEl.textContent = current;

        requestAnimationFrame(() => {
            if (container && currentEl && prevEl && nextEl) {
                const containerCenter = container.offsetWidth / 2;
                const currentHalf = currentEl.offsetWidth / 2;
                const gap = 32;
                prevEl.style.left = (containerCenter - currentHalf - gap - prevEl.offsetWidth) + 'px';
                nextEl.style.left = (containerCenter + currentHalf + gap) + 'px';
            }
        });

        [prevEl, currentEl, nextEl, lpCurrentEl].forEach(el => { if (el) el.style.opacity = '1'; });
    }, 200);
}

async function fetchLyrics(title, artist, album, retryCount = 0) {
    if (title !== lastTitle || artist !== lastArtist) return;

    if (retryCount === 0) {
        isFetchingLyrics = true;
        updateLyrics('', '🎵 가사 찾는 중...', '');
    }

    try {
        const res = await fetch(`http://127.0.0.1:8888/lyrics?title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`).then(r => r.json());
        if (title !== lastTitle || artist !== lastArtist) return;

        currentLyrics = res.lyrics ? parseLRC(res.lyrics) : [];
        if (currentLyrics.length > 0) {
            lastLyricIdx = -1;
        } else {
            if (retryCount < 2) { setTimeout(() => fetchLyrics(title, artist, album, retryCount + 1), 2000); return; }
            updateLyrics('', '가사 없음', '');
        }
    } catch (e) {
        if (title !== lastTitle || artist !== lastArtist) return;
        if (retryCount < 2) { setTimeout(() => fetchLyrics(title, artist, album, retryCount + 1), 2000); return; }
        updateLyrics('', '가사 없음', '');
    } finally {
        isFetchingLyrics = false;
    }
}

// ─── 🔄 서버 폴링 & 진행바 렌더링 ─────────────────────────
async function syncWithServer() {
    try {
        const track = await fetch('http://127.0.0.1:8888/current-track').then(r => r.json());

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

        document.getElementById('btn-play-pause').textContent = '⏸';
        const lpPlayBtn = document.getElementById('lp-btn-play');
        if (lpPlayBtn) lpPlayBtn.textContent = '⏸';
        document.getElementById('vinyl-record')?.classList.add('playing');
        isPausedDisplayed = false;

        const isSongChanged = track.title !== lastTitle;
        const isArtistChanged = track.artist !== lastArtist;

        if (track.title && track.title !== 'YouTube Music' && (isSongChanged || isArtistChanged)) {
            if (!isSongChanged && isArtistChanged && currentLyrics.length > 0) {
                lastArtist = track.artist;
                document.getElementById('artist').textContent = track.artist;
                const lpArtist = document.getElementById('lp-widget-artist');
                if (lpArtist) lpArtist.textContent = track.artist;
            } else {
                if (isSongChanged) localProgress = track.progress > 5000 ? 0 : track.progress;

                lastTitle = track.title;
                lastArtist = track.artist;
                lastLyricIdx = -1;
                currentLyrics = [];

                const trackInfo = document.getElementById('track-info');
                const lyricsContainer = document.getElementById('lyrics-container');
                const lpTextInfo = document.querySelector('.lp-text-info'); // 👈 LP 텍스트 영역 추가

                // 🚨 1. 페이드 아웃 시작 (기존 Bar 모드와 함께 LP 모드도 페이드아웃)
                if (trackInfo && lyricsContainer) { trackInfo.classList.add('fade'); lyricsContainer.classList.add('fade'); }
                if (lpTextInfo) lpTextInfo.classList.add('fade');

                await new Promise(r => setTimeout(r, 400));

                // 🚨 2. 데이터 교체 (중복 제거 및 깔끔하게 정리)
                document.getElementById('title').textContent = track.title;
                document.getElementById('artist').textContent = track.artist || 'Unknown Artist';

                const lpTitle = document.getElementById('lp-widget-title');
                const lpArtist = document.getElementById('lp-widget-artist');
                if (lpTitle) lpTitle.textContent = track.title;
                if (lpArtist) lpArtist.textContent = track.artist || 'Unknown Artist';

                // 🚨 3. 페이드 인 (Bar 모드와 LP 모드 모두 다시 나타나게 처리)
                if (trackInfo && lyricsContainer) { trackInfo.classList.remove('fade'); lyricsContainer.classList.remove('fade'); }
                if (lpTextInfo) lpTextInfo.classList.remove('fade'); // 👈 누락되었던 LP 텍스트 복구 코드 추가

                fetchLyrics(track.title, track.artist, track.album);
            }
        } else {
            if (track.progress < localProgress - 2000) lastLyricIdx = -1;
            localProgress = track.progress;
        }

        lastSyncTime = performance.now();
        isPlaying = true;
        trackDuration = track.duration;

        const albumArtEl = document.getElementById('album-art');
        const lpCover = document.getElementById('lp-widget-cover');

        // 🚨 앨범 아트 교체 시 페이드 효과 적용
        if (track.albumArt && albumArtEl && albumArtEl.src !== track.albumArt) {

            albumArtEl.classList.remove('visible'); // Bar 모드 투명화
            if (lpCover) lpCover.classList.add('fade'); // LP 모드 투명화

            // 새 이미지가 완전히 로드된 후에 화면에 띄우기 (깜빡임 방지)
            const tempImg = new Image();
            tempImg.src = track.albumArt;
            tempImg.onload = () => {
                // Bar 모드 이미지 적용
                albumArtEl.src = track.albumArt;
                albumArtEl.classList.add('visible');
                applyGradient(albumArtEl);

                // LP 모드 이미지 적용 및 페이드 인
                if (lpCover) {
                    lpCover.src = track.albumArt;
                    lpCover.classList.remove('fade');
                }
            };
        }

        if (appConfig.musicService === 'youtube') {
            startEQ();
        } else {
            stopEQ();
        }

    } catch (e) { console.error('동기화 실패:', e); }
}

function tickProgress() {
    if (!isPlaying || lastSyncTime === null || !trackDuration || trackDuration <= 0) {
        requestAnimationFrame(tickProgress);
        return;
    }

    const now = performance.now();
    const progress = Math.min(localProgress + (now - lastSyncTime), trackDuration);
    let percent = Math.max(0, Math.min(100, (progress / trackDuration) * 100));
    if (isNaN(percent) || !isFinite(percent)) percent = 0;

    const progressFill = document.getElementById('progress-fill');
    if (progressFill) progressFill.style.width = `${percent}%`;
    const lpProgressFill = document.getElementById('lp-progress-fill');
    if (lpProgressFill) lpProgressFill.style.width = `${percent}%`;

    // 🚨 최적화: 가사 갱신 체크는 100ms(0.1초)에 한 번만 실행하여 CPU 점유율 대폭 하락
    if (currentLyrics.length > 0 && (now - lastLyricCheckTime > 100)) {
        lastLyricCheckTime = now;
        const { prev, current, next, idx } = getLyricContext(progress + 1000 + appConfig.syncOffset);
        if (idx !== lastLyricIdx) {
            lastLyricIdx = idx;
            updateLyrics(prev, current, next);
        }
    }

    requestAnimationFrame(tickProgress);
}

// ─── 🎛️ 미디어 컨트롤 & 제어 ─────────────────────────────
async function sendControlRequest(command) {
    if (command === 'play-pause') {
        const wasPlaying = isPlaying;
        // 즉각적인 UI 반응을 위해 로컬 상태 먼저 변경
        isPlaying = !wasPlaying;
        document.getElementById('btn-play-pause').textContent = isPlaying ? '⏸' : '▶';

        await fetch('http://127.0.0.1:8888/play-pause', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playing: wasPlaying })
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

// ─── 📉 이퀄라이저 (EQ) 로직 (🚨 최적화됨) ─────────────────
let wsClient = null;
let visualizerMode = 'BARS';

document.getElementById('equalizer')?.addEventListener('click', () => {
    visualizerMode = visualizerMode === 'BARS' ? 'WAVE' : 'BARS';
});
function startEQ() {
    if (wsClient) return;
    try {
        wsClient = new WebSocket('ws://127.0.0.1:8889');
        wsClient.onopen = () => wsClient.send(JSON.stringify({ type: 'register_renderer' }));

        const bars = document.querySelectorAll('#equalizer .bar');
        let smoothedValues = new Array(10).fill(0);

        let latestEqData = null;
        let isUpdating = false;

        // 🚨 최적화: 현재 모드를 기억하여 스타일을 한 번만 적용
        let currentRenderMode = '';

        function renderVisualizer() {
            if (!isPlaying || !latestEqData) {
                isUpdating = false;
                return;
            }

            // 모드가 바뀌었을 때만 height와 borderRadius를 변경하여 Reflow 방지
            if (currentRenderMode !== visualizerMode) {
                currentRenderMode = visualizerMode;
                bars.forEach(bar => {
                    if (visualizerMode === 'BARS') {
                        bar.style.height = '16px';
                        bar.style.borderRadius = '2px';
                    } else {
                        bar.style.height = '4px';
                        bar.style.borderRadius = '50%';
                    }
                });
            }

            bars.forEach((bar, index) => {
                let rawValue = (latestEqData[index] || 0) * 0.5;
                smoothedValues[index] = rawValue < smoothedValues[index] ? rawValue : (smoothedValues[index] * 0.05) + (rawValue * 0.95);
                smoothedValues[index] = Math.min(smoothedValues[index], 180);
                let value = smoothedValues[index];

                if (visualizerMode === 'BARS') {
                    let baseScale = Math.max(0.2, (value / 255) * 1.75);
                    let boostMultiplier = 1 + (index / (bars.length - 1)) * 1.5;
                    if (index === 0) boostMultiplier *= 1.8;
                    if (index === 1) boostMultiplier *= 1.6;
                    // 🚨 최적화: 매 프레임 변하는 transform만 조작 (하드웨어 가속)
                    bar.style.transform = `scaleY(${Math.min(baseScale * boostMultiplier, 1.8)})`;
                } else {
                    let totalVolume = smoothedValues.reduce((a, b) => a + b, 0);
                    // 🚨 최적화: transform만 조작
                    bar.style.transform = `scaleY(1) translateY(${Math.sin((Date.now() / 150) + index) * ((totalVolume / 10 / 25) + 2)}px)`;
                }
            });

            isUpdating = false;
        }

        wsClient.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'eq_data' && isPlaying) {
                latestEqData = msg.data;
                if (!isUpdating) {
                    isUpdating = true;
                    requestAnimationFrame(renderVisualizer);
                }
            }
        };
        wsClient.onerror = () => stopEQ();
    } catch (e) { stopEQ(); }
}

function stopEQ() {
    if (wsClient) { wsClient.close(); wsClient = null; }
    document.querySelectorAll('#equalizer .bar').forEach(bar => {
        bar.style.height = '3px'; bar.style.transform = 'translateY(0)';
    });
}

// ─── ⚙️ UI 업데이트 및 설정 로직 ──────────────────────────
function applyConfigToUI() {
    document.body.setAttribute('data-service', appConfig.musicService);

    // 플랫폼 버튼 활성화
    document.querySelectorAll('.service-pills .theme-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.service === appConfig.musicService);
    });

    // PRO 구역 자동 판별 및 상태 업데이트
    const allSettings = document.querySelectorAll('.settings-section, .setting-item');
    const proSections = Array.from(allSettings).filter(sec => sec.querySelector('.pro-badge'));
    const licenseSection = document.getElementById('license-section');
    const statusEl = document.getElementById('license-status');
    const resetBtn = document.getElementById('license-reset');

    if (appConfig.isPro) {
        if (statusEl) { statusEl.textContent = 'PRO Active'; statusEl.style.color = appConfig.musicService === 'youtube' ? '#FF0000' : '#1DB954'; }
        if (resetBtn) resetBtn.style.display = 'block';
        if (licenseSection) licenseSection.style.display = 'none';
        proSections.forEach(sec => sec.classList.remove('section-disabled'));
    } else {
        if (statusEl) { statusEl.textContent = 'Free'; statusEl.style.color = 'rgba(255,255,255,0.38)'; }
        if (resetBtn) resetBtn.style.display = 'none';
        if (licenseSection) licenseSection.style.display = 'block';
        proSections.forEach(sec => sec.classList.add('section-disabled'));
    }

    // 유튜브 자동 페이드 잠금 로직
    const autoFadeToggle = document.getElementById('auto-fade-toggle');
    if (autoFadeToggle) {
        const autoFadeSection = autoFadeToggle.closest('.settings-section, .setting-item');
        if (appConfig.musicService === 'youtube') {
            autoFadeToggle.disabled = true;
            if (autoFadeSection) { autoFadeSection.style.opacity = '0.4'; autoFadeSection.style.pointerEvents = 'none'; }
            disableAutoFade(); // 강제 해제
        } else {
            autoFadeToggle.disabled = false;
            if (autoFadeSection && appConfig.isPro) { autoFadeSection.style.opacity = '1'; autoFadeSection.style.pointerEvents = 'auto'; }
            if (appConfig.autoFade && appConfig.isPro) enableAutoFade();
        }
        autoFadeToggle.checked = appConfig.autoFade;
    }

    // 기타 토글 및 슬라이더 업데이트
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
    if (!appConfig.autoFade || appConfig.musicService === 'youtube') {
        const barMode = document.getElementById('bar-mode');
        const lpMode = document.getElementById('lp-mode');
        if (barMode) barMode.style.opacity = appConfig.opacity;
        if (lpMode) lpMode.style.opacity = appConfig.opacity;
    }

    document.body.setAttribute('data-theme', appConfig.theme);
    applyGradient(null); // 테마 변경 시 배경 재적용

    ipcRenderer.send('update-system-settings', {
        alwaysOnTop: appConfig.alwaysOnTop,
        globalShortcut: appConfig.globalShortcut,
        widgetStyle: appConfig.widgetStyle,
        trayIcon: appConfig.trayIcon
    });
}

// ─── 🖱️ UI 인터랙션 및 자동 페이드 로직 ──────────────────
function scheduleFade() {
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => {
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

// 설정창 이벤트 바인딩
document.getElementById('license-activate')?.addEventListener('click', () => {
    const key = document.getElementById('license-input').value.trim();
    if (key.startsWith('PRO-')) {
        appConfig.isPro = true; document.getElementById('license-error')?.style.setProperty('opacity', '0');
        saveSettings(); applyConfigToUI();
    } else {
        const errEl = document.getElementById('license-error');
        if (errEl) { errEl.style.opacity = '1'; setTimeout(() => errEl.style.opacity = '0', 3000); }
    }
});

document.getElementById('license-reset')?.addEventListener('click', () => {
    appConfig.isPro = false;
    appConfig.theme = 'auto'; // 테마도 리셋
    saveSettings(); applyConfigToUI();
});

// 플랫폼 변경
window.changeService = async function (service) {
    appConfig.musicService = service;
    saveSettings();
    applyConfigToUI();

    if (service === 'spotify') {
        stopEQ();
    } else if (service === 'youtube') {
        startEQ();
    }

    // 서버에 플랫폼 변경 알림 및 상태 확인
    const res = await fetch('http://127.0.0.1:8888/set-service', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service: service })
    }).then(r => r.json());

    // 강제 동기화 실행
    syncWithServer();

    // 🚨 서버에서 API 키가 없다고 판단(needsSetup: true)했을 때만 셋업 창 열기
    if (res.needsSetup) {
        ipcRenderer.send('open-setup-window');
    }
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

// ─── 🪟 IPC & 창 제어 ──────────────────────────────────────
ipcRenderer.on('change-style', (event, style) => {
    const barMode = document.getElementById('bar-mode');
    const lpMode = document.getElementById('lp-mode');
    if (!barMode || !lpMode) return;
    if (style === 'lp') { barMode.classList.remove('mode-active'); lpMode.classList.add('mode-active'); }
    else { lpMode.classList.remove('mode-active'); barMode.classList.add('mode-active'); }
});

ipcRenderer.on('hide-widget-for-settings', () => document.body.classList.add('settings-open'));
ipcRenderer.on('open-settings', () => document.getElementById('settings-modal').classList.add('show'));
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

// ─── 🚀 부팅 ──────────────────────────────────────────────
initSettings();
tickProgress();
syncWithServer();
setInterval(syncWithServer, 3000);