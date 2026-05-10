// ==UserScript==
// @name         YouTube Music Ultimate Integration (Ultra Light v7.1)
// @namespace    http://tampermonkey.net/
// @version      7.1
// @author       You
// @match        https://music.youtube.com/*
// @grant        none
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

    // =====================================================================
    // 1. 상태 및 가사 전송
    // =====================================================================
    setInterval(() => {
        const video = document.querySelector('video.html5-main-video');
        const titleEl = document.querySelector('ytmusic-player-bar .title') || document.querySelector('yt-formatted-string.title');
        const bylineEl = document.querySelector('ytmusic-player-bar .byline');
        const imgEl = document.querySelector('ytmusic-player-bar img');
        const activeLyric = document.querySelector('.ytmusic-player-page .active-lyric');
        const timeInfoEl = document.querySelector('.time-info.ytmusic-player-bar');

        if (!titleEl) return;

        const parts = (bylineEl ? bylineEl.textContent : '').split(' • ');
        const artist = parts[0] || '';
        const album = parts[1] || '';
        const currentLyric = activeLyric ? activeLyric.textContent.trim() : "";

        let progress = 0, duration = 0;
        if (timeInfoEl) {
            const timeParts = timeInfoEl.textContent.split('/');
            if (timeParts.length === 2) {
                progress = parseTimeToMs(timeParts[0]);
                duration = parseTimeToMs(timeParts[1]);
            }
        } else if (video) {
            progress = Math.floor(video.currentTime * 1000);
            duration = Math.floor(video.duration * 1000);
        }

        let isPlaying = navigator.mediaSession ? (navigator.mediaSession.playbackState === 'playing') : (video && !video.paused);

        const state = {
            playing: isPlaying,
            title: titleEl.textContent.trim(),
            artist: artist.trim(),
            album: album.trim(),
            albumArt: imgEl ? imgEl.src : '',
            progress: progress,
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
    let evtSource = null;
    function connectSSE() {
        if (evtSource) evtSource.close();
        evtSource = new EventSource("http://127.0.0.1:8888/command-stream");
        evtSource.onmessage = function (event) {
            const command = event.data;
            if (command === 'play-pause') document.querySelector('#play-pause-button')?.click();
            else if (command === 'next') document.querySelector('.next-button')?.click();
            else if (command === 'previous') document.querySelector('.previous-button')?.click();
        };
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
        };

        ws.onclose = () => {
            if (animationFrameId) cancelAnimationFrame(animationFrameId);
            if (watchdogTimer) clearInterval(watchdogTimer);
            setTimeout(connectWS, 3000);
        };
        ws.onerror = () => ws.close();
    };

    const setupAudioAnalysis = () => {
        if (audioSetupDone) return;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.85;
            analyser.connect(audioCtx.destination);
            audioSetupDone = true;
            connectWS();
        } catch (e) {
            console.error("오디오 설정 오류:", e);
        }
    };

    window.addEventListener('click', () => {
        if (!audioSetupDone) setupAudioAnalysis();
    }, { once: true });

})();