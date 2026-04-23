let currentLyrics = [];
let lastTitle = '';
let isFetchingLyrics = false;
let lastLyricIdx = -1;
let eqInterval = null;
let isPausedDisplayed = false;

// 로컬 progress 추적
let localProgress = 0;
let lastSyncTime = null;
let isPlaying = false;
let trackDuration = 0;

// ─── 색상 추출 ───────────────────────────────────────────
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

    // 밝기 계산 (0~255, 128 이상이면 밝은 색)
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    const isLight = brightness > 128;

    document.getElementById('bar').style.background =
        `linear-gradient(90deg, rgba(${color}, 0.9) 0%, rgba(${color}, 0.5) 25%, rgba(15,15,15,0.92) 55%)`;

    // 텍스트 색상 전환
    document.getElementById('title').style.color = isLight ? '#000' : '#fff';
    document.getElementById('artist').style.color = isLight
        ? 'rgba(0,0,0,0.6)'
        : 'rgba(255,255,255,0.5)';
}

// ─── LRC 파싱 ────────────────────────────────────────────
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

// ─── 가사 컨텍스트 ───────────────────────────────────────
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

// ─── 가사 업데이트 ───────────────────────────────────────
function updateLyrics(prev, current, next) {
    const prevEl = document.getElementById('prev-lyric');
    const currentEl = document.getElementById('current-lyric');
    const nextEl = document.getElementById('next-lyric');
    const container = document.getElementById('lyrics-container');

    [prevEl, currentEl, nextEl].forEach(el => el.style.opacity = '0');

    setTimeout(() => {
        prevEl.textContent = prev;
        currentEl.textContent = current;
        nextEl.textContent = next;

        requestAnimationFrame(() => {
            const containerCenter = container.offsetWidth / 2;
            const currentHalf = currentEl.offsetWidth / 2;
            const gap = 32;

            const prevRight = containerCenter - currentHalf - gap;
            prevEl.style.left = (prevRight - prevEl.offsetWidth) + 'px';

            const nextLeft = containerCenter + currentHalf + gap;
            nextEl.style.left = nextLeft + 'px';
        });

        [prevEl, currentEl, nextEl].forEach(el => el.style.opacity = '1');
    }, 200);
}

// ─── 가사 fetch ──────────────────────────────────────────
async function fetchLyrics(title, artist, album) {
    if (isFetchingLyrics) return;
    isFetchingLyrics = true;
    currentLyrics = [];
    lastLyricIdx = -1;
    updateLyrics('', '🎵', '');

    try {
        const res = await fetch(
            `http://127.0.0.1:8888/lyrics?` +
            `title=${encodeURIComponent(title)}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`
        ).then(r => r.json());

        currentLyrics = res.lyrics ? parseLRC(res.lyrics) : [];
        if (!currentLyrics.length) updateLyrics('', '가사 없음', '');
    } catch (e) {
        console.error('가사 fetch 실패:', e);
        updateLyrics('', '가사 없음', '');
    } finally {
        isFetchingLyrics = false;
    }
}

// ─── 이퀄라이저 ─────────────────────────────────────────
let audioCtx = null;
let analyser = null;
let realAudioInterval = null;

async function startEQ() {
    // 이미 실행 중이면 중복 실행 방지
    if (audioCtx) return;

    try {
        // 1. Mac의 기본 오디오 입력(마이크 혹은 BlackHole) 스트림 가져오기
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true, // 오디오 입력 허용
            video: false
        });

        // 2. 오디오 분석기(Analyser) 세팅
        audioCtx = new AudioContext();
        const source = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser();

        analyser.fftSize = 64; // 해상도 조절
        analyser.smoothingTimeConstant = 0.2;
        source.connect(analyser);
        // 주의: source.connect(audioCtx.destination)은 절대 하지 마세요! (하울링 발생)

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const bars = document.querySelectorAll('#equalizer .bar');

        // 3. 실시간 렌더링 루프 (기존 setInterval 대신 requestAnimationFrame 사용)
        function renderFrame() {
            if (!audioCtx) return; // 중지 상태면 루프 종료
            requestAnimationFrame(renderFrame);

            // 현재 주파수 데이터 가져오기 (0 ~ 255)
            analyser.getByteFrequencyData(dataArray);

            bars.forEach((bar, index) => {
                // Tampermonkey에서 보낸 소리 크기 (0~255)
                let value = dataArray[index] || 0;

                if (visualizerMode === 'BARS') {
                    // 🚀 수정됨: value / 15 -> value / 6 으로 변경 (움직임 폭 약 2.5배 증가)
                    // value가 최대치(255)일 때 높이가 약 42px이 되어 가사 바(44px)에 꽉 차게 됩니다.
                    let height = Math.min(18, 3 + (value / 8));
                    bar.style.height = height + 'px';
                    bar.style.transform = 'translateY(0)';
                    bar.style.borderRadius = '1px';
                } else {
                    // 모드 2: 물결(Wave) 형태에 실제 소리 크기 반영
                    bar.style.height = '4px';
                    bar.style.borderRadius = '50%';
                    // 🚀 수정됨: 진폭(위아래로 움직이는 폭) 계산을 더 크게 키움
                    const offset = Math.sin(now / 150 + index) * (value / 8 + 3);
                    bar.style.transform = `translateY(${offset}px)`;
                }
            });
        }

        renderFrame();

    } catch (e) {
        console.error('오디오 캡처 실패 (시스템 설정에서 마이크 권한을 확인하세요):', e);
        // 권한이 없으면 임시로 기존 가짜 애니메이션 실행
        fallbackFakeEQ();
    }
}

function stopEQ() {
    if (audioCtx) {
        audioCtx.close();
        audioCtx = null;
    }
    document.querySelectorAll('#equalizer .bar').forEach(bar => {
        bar.style.height = '3px';
    });
}

// 오디오 권한이 거부되었을 때를 대비한 가짜 애니메이션 (기존 코드)
let fakeEqInterval = null;
function fallbackFakeEQ() {
    if (fakeEqInterval) return;
    const bars = document.querySelectorAll('#equalizer .bar');
    fakeEqInterval = setInterval(() => {
        bars.forEach(bar => {
            bar.style.height = (Math.floor(Math.random() * 8) + 3) + 'px';
        });
    }, 150);
}

function stopEQ() {
    clearInterval(eqInterval);
    eqInterval = null;
    document.querySelectorAll('#equalizer .bar').forEach(bar => {
        bar.style.height = '3px';
    });
}

// ─── 컨트롤 버튼 ─────────────────────────────────────────
document.getElementById('btn-play-pause').addEventListener('click', async () => {
    // 로컬 상태로 바로 판단 - 서버 왕복 없음
    await fetch('http://127.0.0.1:8888/play-pause', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playing: isPlaying })
    });
    setTimeout(syncWithServer, 300);
});

document.getElementById('btn-prev').addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/previous', { method: 'POST' });
    setTimeout(syncWithServer, 500); // 0.5초 후 동기화
});

document.getElementById('btn-next').addEventListener('click', async () => {
    await fetch('http://127.0.0.1:8888/next', { method: 'POST' });
    setTimeout(syncWithServer, 500);
});

// ─── 로컬 progress 루프 (requestAnimationFrame) ──────────
function tickProgress() {
    if (!isPlaying || lastSyncTime === null) {
        requestAnimationFrame(tickProgress);
        return;
    }

    const now = performance.now();
    const elapsed = now - lastSyncTime;
    const progress = Math.min(localProgress + elapsed, trackDuration);

    // 진행바 업데이트
    document.getElementById('progress-fill').style.width =
        `${(progress / trackDuration) * 100}%`;

    // 가사 싱크
    if (currentLyrics.length > 0) {
        const { prev, current, next, idx } = getLyricContext(progress + 200);
        if (idx !== lastLyricIdx) {
            lastLyricIdx = idx;
            updateLyrics(prev, current, next);
        }
    }

    requestAnimationFrame(tickProgress);
}

// ─── 서버 polling (3초마다 동기화) ──────────────────────
async function syncWithServer() {
    try {
        const track = await fetch('http://127.0.0.1:8888/current-track').then(r => r.json());

        if (!track.playing) {
            isPlaying = false;
            lastSyncTime = null;
            stopEQ();
            document.getElementById('btn-play-pause').textContent = '▶';
            if (!isPausedDisplayed) {
                isPausedDisplayed = true;
                updateLyrics('', '⏸', '');
            }
            return;
        }

        document.getElementById('btn-play-pause').textContent = '⏸';
        isPausedDisplayed = false;

        // 🚀 변경된 부분: 곡이 바뀌었는지 '먼저' 확인합니다.
        if (track.title && track.title !== lastTitle) {
            
            // 💡 핵심 해결 로직: 곡이 막 바뀌었는데 진행 시간이 5초(5000ms) 이상이다?
            // 이건 유튜브 뮤직 UI가 아직 덜 바뀐 '이전 곡의 끝부분' 시간입니다. 강제로 0으로 리셋!
            if (track.progress > 5000) {
                localProgress = 0;
            } else {
                localProgress = track.progress;
            }

            lastTitle = track.title;
            lastLyricIdx = -1;
            currentLyrics = [];

            const trackInfo = document.getElementById('track-info');
            const lyricsContainer = document.getElementById('lyrics-container');
            if (trackInfo && lyricsContainer) {
                trackInfo.classList.add('fade');
                lyricsContainer.classList.add('fade');
            }

            await new Promise(r => setTimeout(r, 400));

            document.getElementById('title').textContent = track.title;
            document.getElementById('artist').textContent = track.artist || 'Unknown Artist';
            if (trackInfo && lyricsContainer) {
                trackInfo.classList.remove('fade');
                lyricsContainer.classList.remove('fade');
            }

            fetchLyrics(track.title, track.artist, track.album);

        } else {
            // 곡이 바뀌지 않았을 때는 정상적으로 서버 시간을 동기화합니다.
            // (보너스 팁) 사용자가 유튜브 뮤직에서 직접 뒤로 되감기 했을 때 가사도 즉시 돌아오게 만듭니다.
            if (track.progress < localProgress - 2000) {
                lastLyricIdx = -1; 
            }
            localProgress = track.progress;
        }

        lastSyncTime = performance.now();
        isPlaying = true;
        trackDuration = track.duration;

        // 앨범 아트
        const albumArtEl = document.getElementById('album-art');
        if (track.albumArt && albumArtEl.src !== track.albumArt) {
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

// ─── 이퀄라이저 (Realtime Web Socket 기반) ─────────────────
let visualizerMode = 'BARS'; // 현재 비주얼라이저 상태 ('BARS' 또는 'WAVE')
let wsClient = null;

// 이퀄라이저 아이콘을 클릭하면 실시간으로 모드가 바뀝니다.
document.getElementById('equalizer').addEventListener('click', () => {
    visualizerMode = visualizerMode === 'BARS' ? 'WAVE' : 'BARS';
});

function startEQ() {
    if (wsClient) return; // 이미 연결되어 있으면 패스

    try {
        // 앞서 server.js에 추가한 8889 포트로 연결
        wsClient = new WebSocket('ws://127.0.0.1:8889');

        wsClient.onopen = () => {
            // 내가 렌더러(가사 바)임을 서버에 알림
            wsClient.send(JSON.stringify({ type: 'register_renderer' }));
        };

        const bars = document.querySelectorAll('#equalizer .bar');

        // 스무딩 배열 유지
        let smoothedValues = new Array(10).fill(0);

        wsClient.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === 'eq_data' && isPlaying) {
                const dataArray = msg.data;
                const now = Date.now();

                document.getElementById('equalizer').style.alignItems = 'center';

                bars.forEach((bar, index) => {
                    let rawValue = dataArray[index] || 0;

                    // 빠른 반응성(0.6) 유지
                    smoothedValues[index] = (smoothedValues[index] * 0.4) + (rawValue * 0.6);
                    let value = smoothedValues[index];

                    if (visualizerMode === 'BARS') {
                        bar.style.height = '16px'; // 기본 높이 16px

                        // 🚀 1. 기본 비율 맞추기
                        // Web Audio API의 기본 최대치는 255입니다.
                        // (value / 255)를 하면 0.0 ~ 1.0 사이의 값이 됩니다.
                        // 여기에 목표 최대 스케일인 1.75 (16px * 1.75 = 28px)를 곱해줍니다.
                        let baseScale = (value / 255) * 1.75;

                        // 최소 스케일 보장 (막대가 아예 사라지지 않게)
                        baseScale = Math.max(0.2, baseScale);

                        // 🚀 2. 고음역대 가중치 (Boost) 주기
                        // 오른쪽 바(고음역대)로 갈수록 소리 에너지가 작으므로 가중치를 줍니다.
                        // index 0(저음)은 가중치 1.0, 마지막 index(고음)는 가중치 2.5를 받게 됩니다.
                        // 1.5 부분의 숫자를 조절하여 고음역대가 튀는 정도를 맞출 수 있습니다.
                        let boostMultiplier = 1 + (index / (bars.length - 1)) * 1.5;

                        // 🚀 3. 최종 스케일 계산 및 최대치 제한
                        let finalScale = baseScale * boostMultiplier;

                        // 아무리 가중치를 받아도 최대 스케일 1.75 (28px)를 넘지 못하게 컷!
                        // 이렇게 하면 28px을 넘어가려 할 때 28px에서 멈춰있는 것처럼 보이게 됩니다.
                        finalScale = Math.min(finalScale, 1.75);

                        bar.style.transform = `scaleY(${finalScale})`;
                        bar.style.borderRadius = '2px';
                    } else {
                        // 물결(WAVE) 모드 유지
                        let totalVolume = 0;
                        smoothedValues.forEach(val => totalVolume += val);
                        let avgVolume = totalVolume / 10;

                        bar.style.height = '4px';
                        bar.style.borderRadius = '50%';

                        let offset = Math.sin((now / 150) + index) * ((avgVolume / 25) + 2);
                        bar.style.transform = `scaleY(1) translateY(${offset}px)`;
                    }
                });
            }
        };

        wsClient.onerror = () => {
            // 소켓 연결 실패 시 가짜 애니메이션 대신 정지 상태로 둠
            stopEQ();
        };

    } catch (e) {
        // 에러 발생 시 정지 상태로 둠
        stopEQ();
    }
}

function stopEQ() {
    // 노래가 멈췄거나 연결에 실패했을 때 막대 모양 초기화 (기본 3px 높이)
    document.querySelectorAll('#equalizer .bar').forEach(bar => {
        bar.style.height = '3px';
        bar.style.transform = 'translateY(0)';
        bar.style.borderRadius = '1px';
    });
}

// ─── 시작 ────────────────────────────────────────────────
tickProgress();                          // RAF 루프 시작
syncWithServer();                        // 최초 동기화
setInterval(syncWithServer, 3000);       // 3초마다 서버 동기화