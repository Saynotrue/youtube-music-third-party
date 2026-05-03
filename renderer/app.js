const { ipcRenderer } = require('electron');

let currentLyrics = [];
let lastTitle = '';
let lastArtist = '';
let isFetchingLyrics = false;
let lastLyricIdx = -1;
let isPausedDisplayed = false;
let userSyncOffset = 0;

// 로컬 재생 상태 추적
let localProgress = 0;
let lastSyncTime = null;
let isPlaying = false;
let trackDuration = 0;

// --- 색상 추출 ---
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
    const color = extractColor(imgEl);
    const [r, g, b] = color.split(',').map(Number);

    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const isLight = brightness > 128;

    document.getElementById('bar').style.background =
        `linear-gradient(90deg, rgba(${color}, 0.9) 0%, rgba(${color}, 0.5) 25%, rgba(15,15,15,0.92) 55%)`;

    const lpMode = document.getElementById('lp-mode');
    if (lpMode) {
        lpMode.style.background = 
            `linear-gradient(180deg, rgb(${color}) 0%, rgb(35, 35, 35) 75%, rgb(15, 15, 15) 100%)`;
    }

    document.getElementById('title').style.color = isLight ? '#000' : '#fff';
    document.getElementById('artist').style.color = isLight
        ? 'rgba(0,0,0,0.6)'
        : 'rgba(255,255,255,0.5)';
}

// --- LRC 파싱 ---
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

// --- 가사 컨텍스트 반환 ---
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

// --- 가사 UI 렌더링 ---
function updateLyrics(prev, current, next) {
    const prevEl = document.getElementById('prev-lyric');
    const currentEl = document.getElementById('current-lyric');
    const nextEl = document.getElementById('next-lyric');
    const container = document.getElementById('lyrics-container');
    const lpCurrentEl = document.getElementById('lp-current-lyric');

    [prevEl, currentEl, nextEl, lpCurrentEl].forEach(el => {
        if(el) el.style.opacity = '0';
    });

    setTimeout(() => {
        if(prevEl) prevEl.textContent = prev;
        if(currentEl) currentEl.textContent = current;
        if(nextEl) nextEl.textContent = next;
        if(lpCurrentEl) lpCurrentEl.textContent = current;
        
        if(lpCurrentEl) lpCurrentEl.textContent = current; 

        requestAnimationFrame(() => {
            if(container && currentEl && prevEl && nextEl) {
                const containerCenter = container.offsetWidth / 2;
                const currentHalf = currentEl.offsetWidth / 2;
                const gap = 32;

                const prevRight = containerCenter - currentHalf - gap;
                prevEl.style.left = (prevRight - prevEl.offsetWidth) + 'px';

                const nextLeft = containerCenter + currentHalf + gap;
                nextEl.style.left = nextLeft + 'px';
            }
        });

        [prevEl, currentEl, nextEl, lpCurrentEl].forEach(el => {
            if(el) el.style.opacity = '1';
        });
    }, 200);
}

// --- 가사 데이터 Fetch ---
async function fetchLyrics(title, artist, album, retryCount = 0) {
    if (title !== lastTitle || artist !== lastArtist) return;

    if (retryCount === 0) {
        updateLyrics('', '🎵 가사 찾는 중...', '');
    }

    try {
        const res = await fetch(
            `http://127.0.0.1:8888/lyrics?` +
            `title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`
        ).then(r => r.json());

        if (title !== lastTitle || artist !== lastArtist) return;

        const parsedLyrics = res.lyrics ? parseLRC(res.lyrics) : [];

        if (parsedLyrics.length > 0) {
            currentLyrics = parsedLyrics;
            lastLyricIdx = -1;
        } else {
            if (retryCount < 2) {
                console.log(`[Fetch 지연] 2초 후 ${retryCount + 1}차 재시도`);
                setTimeout(() => fetchLyrics(title, artist, album, retryCount + 1), 2000);
                return;
            }
            updateLyrics('', '가사 없음', '');
        }
    } catch (e) {
        if (title !== lastTitle || artist !== lastArtist) return;

        if (retryCount < 2) {
            setTimeout(() => fetchLyrics(title, artist, album, retryCount + 1), 2000);
            return;
        }
        updateLyrics('', '가사 없음', '');
    }
}

// --- 🎵 미디어 컨트롤 (가사 바 모드) ---
document.getElementById('btn-play-pause').addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/play-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playing: isPlaying })
    });
    setTimeout(syncWithServer, 300);
});

document.getElementById('btn-prev').addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/previous', { method: 'POST' });
    setTimeout(syncWithServer, 500);
});

document.getElementById('btn-next').addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/next', { method: 'POST' });
    setTimeout(syncWithServer, 500);
});

// --- 💿 미디어 컨트롤 (LP 위젯 모드) ---
document.getElementById('lp-btn-play')?.addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/play-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playing: isPlaying })
    });
    setTimeout(syncWithServer, 300);
});

document.getElementById('lp-btn-prev')?.addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/previous', { method: 'POST' });
    setTimeout(syncWithServer, 500);
});

document.getElementById('lp-btn-next')?.addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/next', { method: 'POST' });
    setTimeout(syncWithServer, 500);
});

function tickProgress() {
    // 🚨 trackDuration이 없거나 0이면 실행하지 않음 (Infinity 방지)
    if (!isPlaying || lastSyncTime === null || !trackDuration || trackDuration <= 0) {
        requestAnimationFrame(tickProgress);
        return;
    }

    const now = performance.now();
    const elapsed = now - lastSyncTime;
    const progress = Math.min(localProgress + elapsed, trackDuration);
    
    // 🚨 퍼센트 계산 시 안전장치 추가
    let percent = (progress / trackDuration) * 100;
    if (isNaN(percent) || !isFinite(percent)) percent = 0;
    percent = Math.max(0, Math.min(100, percent));

    // 1. 바 모드 진행 바 업데이트
    const progressFill = document.getElementById('progress-fill');
    if (progressFill) {
        progressFill.style.width = `${percent}%`;
    }

    // 2. LP 모드 진행 바 업데이트
    const lpProgressFill = document.getElementById('lp-progress-fill');
    if (lpProgressFill) {
        lpProgressFill.style.width = `${percent}%`;
    }

    if (currentLyrics.length > 0) {
        const { prev, current, next, idx } = getLyricContext(progress + 1000 + userSyncOffset);
        if (idx !== lastLyricIdx) {
            lastLyricIdx = idx;
            updateLyrics(prev, current, next);
        }
    }

    requestAnimationFrame(tickProgress);
}

// --- 화면 스타일 (위젯/바) 변경 이벤트 ---
ipcRenderer.on('change-style', (event, style) => {
    const barMode = document.getElementById('bar-mode');
    const lpMode = document.getElementById('lp-mode');

    if (!barMode || !lpMode) return;

    if (style === 'lp') {
        // Bar 모드 비활성화, LP 모드 활성화
        barMode.classList.remove('mode-active');
        lpMode.classList.add('mode-active');
    } else {
        // LP 모드 비활성화, Bar 모드 활성화
        lpMode.classList.remove('mode-active');
        barMode.classList.add('mode-active');
    }
});

// --- 서버 상태 동기화 ---
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

        if (track.title && track.title !== 'YouTube Music' &&
            track.artist && track.artist.trim() !== '' &&
            (isSongChanged || isArtistChanged)) {

            if (!isSongChanged && isArtistChanged && currentLyrics.length > 0) {
                lastArtist = track.artist;
                document.getElementById('artist').textContent = track.artist;
                document.getElementById('lp-widget-artist').textContent = track.artist;
            } else {
                if (isSongChanged) {
                    localProgress = track.progress > 5000 ? 0 : track.progress;
                }

                lastTitle = track.title;
                lastArtist = track.artist;
                lastLyricIdx = -1;
                currentLyrics = [];
                if (typeof userSyncOffset !== 'undefined') userSyncOffset = 0;

                const trackInfo = document.getElementById('track-info');
                const lyricsContainer = document.getElementById('lyrics-container');
                const lpTextInfo = document.querySelector('.lp-text-info'); 
                const lpCover = document.getElementById('lp-widget-cover'); 

                if (trackInfo && lyricsContainer) {
                    trackInfo.classList.add('fade');
                    lyricsContainer.classList.add('fade');
                }
                if (lpTextInfo) lpTextInfo.classList.add('fade');

                await new Promise(r => setTimeout(r, 400));

                document.getElementById('title').textContent = track.title;
                document.getElementById('artist').textContent = track.artist || 'Unknown Artist';
                
                const lpTitle = document.getElementById('lp-widget-title');
                const lpArtist = document.getElementById('lp-widget-artist');
                if(lpTitle) lpTitle.textContent = track.title;
                if(lpArtist) lpArtist.textContent = track.artist || 'Unknown Artist';

                if (lpCover && track.albumArt && lpCover.src !== track.albumArt) {
                    const newImg = new Image();
                    newImg.src = track.albumArt;
                    newImg.onload = () => {
                        const tempImg = document.createElement('img');
                        tempImg.src = lpCover.src;
                        tempImg.style.position = 'absolute';
                        tempImg.style.width = '90px';
                        tempImg.style.height = '90px';
                        tempImg.style.borderRadius = '50%';
                        tempImg.style.objectFit = 'cover';
                        tempImg.style.transition = 'opacity 0.6s ease';
                        
                        tempImg.style.top = '50%';
                        tempImg.style.left = '50%';
                        tempImg.style.transform = 'translate(-50%, -50%)';
                        tempImg.style.zIndex = '2'; 
                        
                        const hole = document.querySelector('.vinyl-hole');
                        if (hole) hole.style.zIndex = '3';

                        lpCover.parentNode.appendChild(tempImg);
                        
                        lpCover.src = track.albumArt;
                        
                        tempImg.offsetHeight; 
                        
                        tempImg.style.opacity = '0';
                        
                        setTimeout(() => {
                            if (tempImg.parentNode) tempImg.parentNode.removeChild(tempImg);
                        }, 600);
                    };
                }

                if (trackInfo && lyricsContainer) {
                    trackInfo.classList.remove('fade');
                    lyricsContainer.classList.remove('fade');
                }
                if (lpTextInfo) lpTextInfo.classList.remove('fade');

                fetchLyrics(track.title, track.artist, track.album);
            }
        } else {
            if (track.progress < localProgress - 2000) {
                lastLyricIdx = -1;
            }
            localProgress = track.progress;
        }

        lastSyncTime = performance.now();
        isPlaying = true;
        trackDuration = track.duration;

        const albumArtEl = document.getElementById('album-art');
        if (track.albumArt && albumArtEl && albumArtEl.src !== track.albumArt) {
            albumArtEl.src = track.albumArt;
            albumArtEl.onload = () => {
                albumArtEl.classList.add('visible');
                applyGradient(albumArtEl);
                const color = extractColor(albumArtEl);
                document.documentElement.style.setProperty('--theme-color', `rgb(${color})`);
            };
        }

        startEQ();

    } catch (e) {
        console.error('동기화 실패:', e);
    }
}

// --- 이퀄라이저 (WebSocket 기반) ---
let visualizerMode = 'BARS';
let wsClient = null;

const eqEl = document.getElementById('equalizer');
if(eqEl) {
    eqEl.addEventListener('click', () => {
        visualizerMode = visualizerMode === 'BARS' ? 'WAVE' : 'BARS';
    });
}

function startEQ() {
    if (wsClient) return;

    try {
        wsClient = new WebSocket('ws://127.0.0.1:8889');

        wsClient.onopen = () => {
            wsClient.send(JSON.stringify({ type: 'register_renderer' }));
        };

        const bars = document.querySelectorAll('#equalizer .bar');
        let smoothedValues = new Array(10).fill(0);

        wsClient.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === 'eq_data' && isPlaying) {
                const dataArray = msg.data;

                const eqContainer = document.getElementById('equalizer');
                if(eqContainer) eqContainer.style.alignItems = 'center';

                bars.forEach((bar, index) => {
                    let rawValue = (dataArray[index] || 0) * 0.5;

                    if (rawValue < smoothedValues[index]) {
                        smoothedValues[index] = rawValue;
                    } else {
                        smoothedValues[index] = (smoothedValues[index] * 0.05) + (rawValue * 0.95);
                    }

                    smoothedValues[index] = Math.min(smoothedValues[index], 180);
                    let value = smoothedValues[index];

                    if (visualizerMode === 'BARS') {
                        bar.style.height = '16px';
                        let baseScale = (value / 255) * 1.75;
                        baseScale = Math.max(0.2, baseScale);

                        let boostMultiplier = 1 + (index / (bars.length - 1)) * 1.5;
                        if (index === 0) boostMultiplier *= 1.8;
                        if (index === 1) boostMultiplier *= 1.6;

                        let finalScale = baseScale * boostMultiplier;
                        finalScale = Math.min(finalScale, 1.8);

                        bar.style.transform = `scaleY(${finalScale})`;
                        bar.style.borderRadius = '2px';
                    } else {
                        let totalVolume = 0;
                        smoothedValues.forEach(val => totalVolume += val);
                        let avgVolume = totalVolume / 10;
                        bar.style.height = '4px';
                        bar.style.borderRadius = '50%';
                        let offset = Math.sin((Date.now() / 150) + index) * ((avgVolume / 25) + 2);
                        bar.style.transform = `scaleY(1) translateY(${offset}px)`;
                    }
                });
            }
        };

        wsClient.onerror = () => {
            stopEQ();
        };

    } catch (e) {
        stopEQ();
    }
}

function stopEQ() {
    if (wsClient) {
        wsClient.onmessage = null; 
        wsClient.onerror = null;
        wsClient.close();
        wsClient = null; 
    }
    
    document.querySelectorAll('#equalizer .bar').forEach(bar => {
        bar.style.height = '3px';
        bar.style.transform = 'translateY(0)';
        bar.style.borderRadius = '1px';
    });
}

// --- 가사 싱크 커스텀 (단축키) ---
document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
        userSyncOffset += 100;
        showSyncMessage(`싱크 +${userSyncOffset}ms`);
    } else if (e.key === 'ArrowLeft') {
        userSyncOffset -= 100;
        showSyncMessage(`싱크 ${userSyncOffset}ms`);
    }
});

// 싱크 조정 알림 UI
function showSyncMessage(msg) {
    let msgEl = document.getElementById('sync-msg');
    if (!msgEl) {
        msgEl = document.createElement('div');
        msgEl.id = 'sync-msg';
        msgEl.style.cssText = 'position:absolute; top:10px; right:10px; background:rgba(0,0,0,0.7); color:white; padding:5px 10px; border-radius:5px; font-size:12px; transition: opacity 0.3s; z-index:9999;';
        document.body.appendChild(msgEl);
    }
    msgEl.textContent = msg;
    msgEl.style.opacity = '1';

    clearTimeout(msgEl.hideTimeout);
    msgEl.hideTimeout = setTimeout(() => {
        msgEl.style.opacity = '0';
    }, 1500);
}

// --- 초기화 및 실행 ---
tickProgress();                          
syncWithServer();                        
setInterval(syncWithServer, 3000);