// ==UserScript==
// @name         YouTube Music Ultimate Integration (Ultra Light v7.1)
// @namespace    http://tampermonkey.net/
// @version      7.9
// @author       You
// @match        https://music.youtube.com/*
// @grant        none
// @noframes
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    function parseTimeToMs(timeStr) {
        if (!timeStr) return 0;
        const parts = timeStr.trim().split(':').map(Number);
        if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
        return 0;
    }

    // 곡 정보: mediaSession(유튜브 뮤직이 직접 채움) → 플레이어 API → 플레이어 바 DOM 순으로 조회
    // 🚨 페이지 전체를 대상으로 한 셀렉터(yt-formatted-string.title 등)는 홈 화면 카드 제목을 잘못 집어오므로 사용 금지
    function getTrackInfo() {
        const meta = navigator.mediaSession?.metadata;
        const player = document.getElementById('movie_player');
        const videoData = player?.getVideoData?.() || {};
        const bar = document.querySelector('ytmusic-player-bar');

        let title = meta?.title || videoData.title || '';
        let artist = meta?.artist || videoData.author || '';
        let album = meta?.album || '';
        let albumArt = meta?.artwork?.length ? meta.artwork[meta.artwork.length - 1].src : '';

        if (bar) {
            if (!title) title = bar.querySelector('.content-info-wrapper .title')?.textContent || '';
            if (!artist) {
                const parts = (bar.querySelector('.content-info-wrapper .byline')?.textContent || '').split(' • ');
                artist = parts[0] || '';
                if (!album) album = parts[1] || '';
            }
            if (!albumArt) albumArt = bar.querySelector('.thumbnail-image-wrapper img, img')?.src || '';
        }

        return { title: title.trim(), artist: artist.trim(), album: album.trim(), albumArt, videoId: videoData.video_id || '' };
    }

    // =====================================================================
    // 1. 상태 및 가사 전송
    // =====================================================================
    setInterval(() => {
        const video = document.querySelector('video.html5-main-video');
        const player = document.getElementById('movie_player');
        const activeLyric = document.querySelector('.ytmusic-player-page .active-lyric');
        const timeInfoEl = document.querySelector('ytmusic-player-bar .time-info');

        const info = getTrackInfo();
        if (!info.title) return;

        const currentLyric = activeLyric ? activeLyric.textContent.trim() : "";

        let progress = 0, duration = 0;
        if (player?.getCurrentTime) progress = Math.floor(player.getCurrentTime() * 1000);
        else if (video) progress = Math.floor(video.currentTime * 1000);

        // 🚨 곡 길이: player.getDuration()은 '지금까지 받아 둔 구간' 길이를 돌려줘 재생 중에 계속 늘어나므로(예: 79초 → 139초, 실제 183초)
        //    곡 정보의 실제 길이(lengthSeconds) → 플레이어 바 표시 시간 → getDuration 순으로 사용
        const response = player?.getPlayerResponse?.();
        if (response?.videoDetails?.videoId === info.videoId) duration = Number(response.videoDetails.lengthSeconds) * 1000 || 0;
        if (!duration && timeInfoEl) {
            const timeParts = timeInfoEl.textContent.split('/');
            if (timeParts.length === 2) {
                duration = parseTimeToMs(timeParts[1]);
                if (!progress) progress = parseTimeToMs(timeParts[0]);
            }
        }
        if (!duration && player?.getDuration) duration = Math.floor(player.getDuration() * 1000);
        if (!duration && video) duration = Math.floor(video.duration * 1000) || 0;

        let isPlaying = navigator.mediaSession?.playbackState
            ? navigator.mediaSession.playbackState === 'playing'
            : !!(video && !video.paused);

        const state = {
            playing: isPlaying,
            title: info.title,
            artist: info.artist,
            album: info.album,
            albumArt: info.albumArt,
            videoId: info.videoId,
            progress: progress,
            sampledAt: Date.now(), // 위젯이 전송/폴링 지연만큼 진행 시간을 보정하는 기준
            duration: duration,
            lyric: currentLyric
        };

        fetch("http://127.0.0.1:8888/update-state", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state)
        }).catch(() => { });
    }, 1000);

    // =====================================================================
    // 2. 실시간 명령 수신기
    // =====================================================================
    // 유튜브 뮤직이 OS 미디어 키용으로 등록하는 핸들러를 가로채 보관 (DOM 구조 변경에 영향 없음)
    const mediaHandlers = {};
    if (navigator.mediaSession?.setActionHandler) {
        const origSetActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
        navigator.mediaSession.setActionHandler = function (action, handler) {
            mediaHandlers[action] = handler;
            return origSetActionHandler(action, handler);
        };
    }

    function runMediaAction(action, details) {
        const handler = mediaHandlers[action];
        if (!handler) return false;
        try { handler({ action, ...details }); return true; } catch (e) { return false; }
    }

    function clickPlayerBarButton(selectors) {
        const bar = document.querySelector('ytmusic-player-bar');
        for (const sel of selectors) {
            const btn = bar?.querySelector(sel) || document.querySelector(sel);
            if (btn) { btn.click(); return true; }
        }
        return false;
    }

    function handleCommand(command) {
        if (command === 'play-pause') {
            const video = document.querySelector('video.html5-main-video');
            const playing = navigator.mediaSession?.playbackState
                ? navigator.mediaSession.playbackState === 'playing'
                : !!(video && !video.paused);
            if (runMediaAction(playing ? 'pause' : 'play')) return;
            if (clickPlayerBarButton(['#play-pause-button', '.play-pause-button'])) return;
            if (video) playing ? video.pause() : video.play();
        } else if (command === 'next') {
            if (runMediaAction('nexttrack')) return;
            if (clickPlayerBarButton(['.next-button', '[aria-label="다음"]', '[aria-label="Next"]'])) return;
            document.getElementById('movie_player')?.nextVideo?.();
        } else if (command === 'previous') {
            if (runMediaAction('previoustrack')) return;
            if (clickPlayerBarButton(['.previous-button', '[aria-label="이전"]', '[aria-label="Previous"]'])) return;
            document.getElementById('movie_player')?.previousVideo?.();
        }
    }

    let evtSource = null;
    function connectSSE() {
        if (evtSource) evtSource.close();
        evtSource = new EventSource("http://127.0.0.1:8888/command-stream");
        evtSource.onmessage = (event) => handleCommand(event.data);
        evtSource.onerror = () => { evtSource.close(); setTimeout(connectSSE, 3000); };
    }
    connectSSE();

    // =====================================================================
    // 3. 오디오 분석 (🚨 윈도우 백그라운드 정지 방지 워치독 추가)
    // =====================================================================
    let audioCtx = null;
    let analyser = null;
    let currentVideo = null;
    let mediaSource = null;
    let audioSetupDone = false;
    let ws = null;
    let animationFrameId = null;
    let watchdogTimer = null;
    let audioTicker = null;

    const connectWS = () => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        ws = new WebSocket('ws://127.0.0.1:8889');

        ws.onopen = () => {
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            if (watchdogTimer) clearInterval(watchdogTimer);

            let lastSendTime = performance.now();
            const targetFPS = 30;
            const frameInterval = 1000 / targetFPS;

            // 데이터를 뽑아서 서버로 쏘는 핵심 로직 분리
            function extractAndSend() {
                const videoEl = document.querySelector('video.html5-main-video');

                if (videoEl && videoEl !== currentVideo) {
                    if (mediaSource) {
                        try { mediaSource.disconnect(); } catch (e) { }
                    }
                    currentVideo = videoEl;
                    try {
                        mediaSource = audioCtx.createMediaElementSource(currentVideo);
                        mediaSource.connect(analyser);
                    } catch (e) { }
                }

                if (analyser && ws.readyState === WebSocket.OPEN && currentVideo && !currentVideo.paused) {
                    analyser.getByteFrequencyData(dataArray);

                    let hasAudio = false;
                    for (let i = 0; i < 10; i++) { if (dataArray[i] > 0) hasAudio = true; }

                    if (hasAudio) {
                        const eqData = [
                            dataArray[1] || 0, dataArray[2] || 0, dataArray[3] || 0,
                            dataArray[4] || 0, dataArray[6] || 0, dataArray[8] || 0,
                            dataArray[12] || 0, dataArray[16] || 0, dataArray[20] || 0,
                            dataArray[24] || 0
                        ];
                        ws.send(JSON.stringify({ type: 'eq_data', data: eqData }));
                    }
                }
            }

            // 메인 루프 (화면에 보일 때 쌩쌩하게 돌아감)
            function sendEqData(timestamp) {
                if (timestamp - lastSendTime >= frameInterval) {
                    lastSendTime = timestamp || performance.now();
                    extractAndSend();
                }
                animationFrameId = requestAnimationFrame(sendEqData);
            }
            animationFrameId = requestAnimationFrame(sendEqData);

            // 🚨 워치독(Watchdog): 윈도우 크롬이 창을 가려서 rAF를 강제로 멈췄을 때 출동!
            watchdogTimer = setInterval(() => {
                const now = performance.now();
                // 150ms 이상 프레임이 안 돌았다면 (크롬이 멈췄다고 판단)
                if (now - lastSendTime > 150) {
                    extractAndSend(); // 강제로 데이터를 쏴서 EQ가 안 죽게 살림
                    lastSendTime = now;
                }
            }, 100);

            // 🚨 오디오 콜백 구동: 윈도우에서 전체화면 위젯이 크롬 창을 가리면 크롬이 페이지를 '숨김'으로 보고
            //    rAF는 멈추고 타이머(워치독)도 최대 1초 간격으로 늦춤 → EQ가 띄엄띄엄 움직임.
            //    오디오 처리 콜백은 재생 중이면 창이 가려져도 멈추지 않으므로(1024샘플 ≈ 21ms마다) 여기서도 데이터를 보냄.
            //    출력 버퍼는 비워 두므로 소리에는 영향 없음.
            if (audioTicker) { try { audioTicker.disconnect(); } catch (e) { } }
            try {
                audioTicker = audioCtx.createScriptProcessor(1024, 1, 1);
                audioTicker.onaudioprocess = () => {
                    const now = performance.now();
                    if (now - lastSendTime >= frameInterval) {
                        lastSendTime = now;
                        extractAndSend();
                    }
                };
                analyser.connect(audioTicker);
                audioTicker.connect(audioCtx.destination);
            } catch (e) { audioTicker = null; }
        };

        ws.onclose = () => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            if (watchdogTimer) clearInterval(watchdogTimer);
            if (audioTicker) { try { audioTicker.disconnect(); } catch (e) { } audioTicker = null; }
            setTimeout(connectWS, 3000);
        };
        ws.onerror = () => ws.close();
    };

    const setupAudioAnalysis = (existingCtx) => {
        if (audioSetupDone) return;
        try {
            audioCtx = existingCtx || new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.4;
            analyser.connect(audioCtx.destination);
            audioSetupDone = true;
            connectWS();
        } catch (e) {
            console.error("오디오 설정 오류:", e);
        }
    };

    // 유튜브 뮤직 버튼은 클릭 이벤트 전파를 막는 경우가 있으므로 캡처 단계에서 첫 사용자 입력을 감지
    ['pointerdown', 'keydown', 'click'].forEach(type => {
        window.addEventListener(type, () => {
            if (!audioSetupDone) setupAudioAnalysis();
        }, { capture: true });
    });

    // 새로고침 후 페이지를 클릭하지 않고 위젯으로만 재생하는 경우:
    // 브라우저가 오디오를 허용한 상태(running)일 때만 바로 연결 (suspended 상태로 연결하면 소리가 끊기므로 금지)
    let silentSetupAttempts = 0;
    function trySetupWithoutGesture() {
        if (audioSetupDone || silentSetupAttempts >= 3) return;
        const video = document.querySelector('video.html5-main-video');
        if (!video || video.paused) return;
        silentSetupAttempts++;
        try {
            const probe = new (window.AudioContext || window.webkitAudioContext)();
            if (probe.state === 'running') setupAudioAnalysis(probe);
            else probe.close();
        } catch (e) { }
    }
    setInterval(trySetupWithoutGesture, 2000);

})();