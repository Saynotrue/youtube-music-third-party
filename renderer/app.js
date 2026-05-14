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
    isPro: false,
    opacity: 1.0,
    autoFade: false,
    theme: 'auto',
    syncOffset: 0,
    alwaysOnTop: true,
    globalShortcut: true,
    widgetStyle: 'eq',
    trayIcon: 'player',
    musicService: 'youtube'
};

function initSettings() {
    const saved = localStorage.getItem('lyricsBarSettings');
    if (saved) appConfig = { ...appConfig, ...JSON.parse(saved) };

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

function applyGradient(imgEl) {
    if (imgEl) lastAlbumImg = imgEl;
    const img = lastAlbumImg;
    if (!img) return;

    const bar = document.getElementById('bar');
    const lpMode = document.getElementById('lp-mode');
    const titleEl = document.getElementById('title');
    const artistEl = document.getElementById('artist');

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

    if (appConfig.theme === 'accent') {
        if (bar) bar.style.background = `linear-gradient(90deg, rgba(${color}, 1.0) 0%, rgba(${color}, 0.85) 45%, rgba(${color}, 0.2) 100%)`;
    } else {
        if (bar) bar.style.background = `linear-gradient(90deg, rgba(${color}, 0.9) 0%, rgba(${color}, 0.5) 25%, rgba(15,15,15,0.92) 55%)`;
        if (lpMode) lpMode.style.background = `linear-gradient(180deg, rgb(${color}) 0%, rgb(35, 35, 35) 75%, rgb(15, 15, 15) 100%)`;
    }

    if (titleEl) titleEl.style.color = isLight ? '#000' : '#fff';
    if (artistEl) artistEl.style.color = isLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.5)';

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
            const isFull = document.body.classList.contains('fullscreen-mode');

            if (!isFull) {
                if (container && currentEl && prevEl && nextEl) {
                    const containerCenter = container.offsetWidth / 2;
                    const currentHalf = currentEl.offsetWidth / 2;
                    const gap = 32;
                    prevEl.style.left = (containerCenter - currentHalf - gap - prevEl.offsetWidth) + 'px';
                    nextEl.style.left = (containerCenter + currentHalf + gap) + 'px';
                }
            } else {
                if (prevEl) prevEl.style.left = '';
                if (nextEl) nextEl.style.left = '';
            }

            if (prevEl) prevEl.style.opacity = isFull ? '' : '1';
            if (currentEl) currentEl.style.opacity = isFull ? '' : '1';
            if (nextEl) nextEl.style.opacity = isFull ? '' : '1';
            if (lpCurrentEl) lpCurrentEl.style.opacity = '1';
        });
    }, 250);
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
});

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

        // 🚨 이퀄라이저 생존 확인: 재생 중인데 꺼져있으면 다시 살림
        if (appConfig.musicService === 'youtube' && !wsClient) {
            startEQ();
        }

        document.getElementById('btn-play-pause').textContent = '⏸';
        const lpPlayBtn = document.getElementById('lp-btn-play');
        if (lpPlayBtn) lpPlayBtn.textContent = '⏸';
        document.getElementById('vinyl-record')?.classList.add('playing');
        isPausedDisplayed = false;

        const isSongChanged = track.title !== lastTitle;
        const isArtistChanged = track.artist !== lastArtist;

        // 2. 곡 변경 처리 및 배경색 초기화
        if (track.title && track.title !== 'YouTube Music' && (isSongChanged || isArtistChanged)) {
            // 🚨 배경색 즉시 어두운 회색으로 리셋 (하얀색 튐 방지)
            document.documentElement.style.setProperty('--bg-color', '#1a1a1a');
            document.documentElement.style.setProperty('--theme-color', '#ffffff');

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
                const lpTextInfo = document.querySelector('.lp-text-info');

                if (trackInfo && lyricsContainer) { trackInfo.classList.add('fade'); lyricsContainer.classList.add('fade'); }
                if (lpTextInfo) lpTextInfo.classList.add('fade');

                await new Promise(r => setTimeout(r, 400));

                document.getElementById('title').textContent = track.title;
                document.getElementById('artist').textContent = track.artist || 'Unknown Artist';
                const lpTitle = document.getElementById('lp-widget-title');
                const lpArtist = document.getElementById('lp-widget-artist');
                if (lpTitle) lpTitle.textContent = track.title;
                if (lpArtist) lpArtist.textContent = track.artist || 'Unknown Artist';

                if (trackInfo && lyricsContainer) { trackInfo.classList.remove('fade'); lyricsContainer.classList.remove('fade'); }
                if (lpTextInfo) lpTextInfo.classList.remove('fade');

                fetchLyrics(track.title, track.artist, track.album);
            }
        } else {
            if (track.progress < localProgress - 2000) lastLyricIdx = -1;
            localProgress = track.progress;
        }

        lastSyncTime = performance.now();
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

        if (originalArt && albumArtEl && albumArtEl.getAttribute('data-src') !== originalArt) {
            albumArtEl.setAttribute('data-src', originalArt);
            albumArtEl.classList.remove('visible');
            if (lpCover) lpCover.classList.add('fade');

            const loadNextImage = (index) => {
                if (index >= tryUrls.length) return;
                const tempImg = new Image();
                tempImg.crossOrigin = 'Anonymous';

                // ⏱️ 타임아웃: 2.5초 이상 걸리면 다음 화질로 강제 전환
                const timeoutId = setTimeout(() => {
                    tempImg.src = "";
                    loadNextImage(index + 1);
                }, 2500);

                tempImg.onload = () => {
                    clearTimeout(timeoutId);
                    albumArtEl.crossOrigin = 'Anonymous';
                    albumArtEl.src = tryUrls[index];
                    albumArtEl.classList.add('visible');
                    // 색상 추출 및 배경색 적용
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
        }

        // 서비스가 유튜브일 경우 이퀄라이저 실행 재확인
        if (appConfig.musicService === 'youtube' && !wsClient) startEQ();

    } catch (e) {
        console.error('동기화 실패:', e);
        if (appConfig.musicService === 'youtube') startEQ(); // 에러 발생 시 세션 재연결 시도
    }
}

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
        const { prev, current, next, idx } = getLyricContext(progress + 1000 + appConfig.syncOffset);
        if (idx !== lastLyricIdx) { lastLyricIdx = idx; updateLyrics(prev, current, next); }
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
        let velocities = new Array(10).fill(0);
        let latestEqData = new Array(10).fill(0);
        let currentRenderMode = '';

        const STIFFNESS = 0.25;
        const DAMPING = 0.65;

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
                        bar.style.height = '16px';
                        bar.style.borderRadius = '2px';
                    } else {
                        bar.style.height = '4px';
                        bar.style.borderRadius = '50%';
                    }
                });
            }

            bars.forEach((bar, index) => {
                let targetValue = (latestEqData[index] || 0) * 0.5;
                let diff = targetValue - currentValues[index];
                velocities[index] += diff * STIFFNESS;
                velocities[index] *= DAMPING;
                currentValues[index] += velocities[index];

                if (Math.abs(velocities[index]) < 0.1 && Math.abs(diff) < 0.1) {
                    velocities[index] = 0;
                    currentValues[index] = targetValue;
                } else {
                    isAnimating = true;
                }

                let value = Math.max(0, Math.min(currentValues[index], 180));

                if (visualizerMode === 'BARS') {
                    let baseScale = Math.max(0.2, (value / 255) * 1.75);
                    let boostMultiplier = 1 + (index / (bars.length - 1)) * 1.5;
                    if (index === 0) boostMultiplier *= 1.8;
                    if (index === 1) boostMultiplier *= 1.6;
                    bar.style.transform = `scaleY(${Math.min(baseScale * boostMultiplier, 1.8)})`;
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
        bar.style.height = '3px';
        bar.style.transform = 'translateY(0) scaleY(1)';
    });
}

// ═════════════════════════════════════════════════════════════
//  8. ⚙️ UI 업데이트 및 설정 모달 이벤트 바인딩
// ═════════════════════════════════════════════════════════════
function applyConfigToUI() {
    document.body.setAttribute('data-service', appConfig.musicService);
    document.querySelectorAll('.service-pills .theme-pill').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.service === appConfig.musicService);
    });

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

    const autoFadeToggle = document.getElementById('auto-fade-toggle');
    if (autoFadeToggle) {
        const autoFadeSection = autoFadeToggle.closest('.settings-section, .setting-item');
        if (appConfig.musicService === 'youtube') {
            autoFadeToggle.disabled = true;
            if (autoFadeSection) { autoFadeSection.style.opacity = '0.4'; autoFadeSection.style.pointerEvents = 'none'; }
            disableAutoFade();
        } else {
            autoFadeToggle.disabled = false;
            if (autoFadeSection && appConfig.isPro) { autoFadeSection.style.opacity = '1'; autoFadeSection.style.pointerEvents = 'auto'; }
            if (appConfig.autoFade && appConfig.isPro) enableAutoFade();
        }
        autoFadeToggle.checked = appConfig.autoFade;
    }

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
    appConfig.isPro = false; appConfig.theme = 'auto';
    saveSettings(); applyConfigToUI();
});

window.changeService = async function (service) {
    appConfig.musicService = service;
    saveSettings(); applyConfigToUI();
    if (service === 'spotify') stopEQ(); else if (service === 'youtube') startEQ();

    const res = await fetch('http://127.0.0.1:8888/set-service', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service: service })
    }).then(r => r.json());

    syncWithServer();
    if (res.needsSetup) ipcRenderer.send('open-setup-window');
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