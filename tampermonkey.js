// ==UserScript==
// @name         YouTube Music Ultimate Integration (Lyrics, Visualizer, Remote)
// @namespace    http://tampermonkey.net/
// @version      6.0
// @author       You
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
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
    // 1. 상태 및 가사 전송 (1초마다 가사 바에 현재 상태 알려주기)
    // =====================================================================
    setInterval(() => {
        const video = document.querySelector('video.html5-main-video');
        const titleEl = document.querySelector('ytmusic-player-bar .title') || document.querySelector('yt-formatted-string.title');
        const bylineEl = document.querySelector('ytmusic-player-bar .byline');
        const imgEl = document.querySelector('ytmusic-player-bar img');
        const activeLyric = document.querySelector('.ytmusic-player-page .active-lyric');

        const timeInfoEl = document.querySelector('.time-info.ytmusic-player-bar');

        if (!titleEl) return;

        const bylineText = bylineEl ? bylineEl.textContent : '';
        const parts = bylineText.split(' • ');
        const artist = parts[0] || '';
        const album = parts[1] || '';
        const currentLyric = activeLyric ? activeLyric.textContent.trim() : "";

        let progress = 0;
        let duration = 0;

        if (timeInfoEl) {
            const timeText = timeInfoEl.textContent;
            const timeParts = timeText.split('/');
            if (timeParts.length === 2) {
                progress = parseTimeToMs(timeParts[0]);
                duration = parseTimeToMs(timeParts[1]);
            }
        } else if (video) {
            progress = Math.floor(video.currentTime * 1000);
            duration = Math.floor(video.duration * 1000);
        }
        let isPlaying = false;
        if (navigator.mediaSession) {
            isPlaying = navigator.mediaSession.playbackState === 'playing';
        } else if (video) {
            isPlaying = !video.paused;
        }

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

        GM_xmlhttpRequest({
            method: "POST",
            url: "http://127.0.0.1:8888/update-state",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(state),
            onerror: () => {}
        });
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
            if (command === 'play-pause') {
                const btn = document.querySelector('#play-pause-button');
                if (btn) btn.click();
            } else if (command === 'next') {
                const btn = document.querySelector('.next-button');
                if (btn) btn.click();
            } else if (command === 'previous') {
                const btn = document.querySelector('.previous-button');
                if (btn) btn.click();
            }
        };

        evtSource.onerror = function (err) {
            evtSource.close();
            setTimeout(connectSSE, 3000);
        };
    }

    connectSSE();

    // =====================================================================
    // 3. 오디오 분석 및 비주얼라이저 로직
    // =====================================================================
    let audioCtx = null;
    let analyser = null;
    let currentVideo = null;
    let mediaSource = null;
    let audioSetupDone = false;
    let ws = null;
    let eqInterval = null;

    const connectWS = () => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        ws = new WebSocket('ws://127.0.0.1:8889');

        ws.onopen = () => {
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            if (eqInterval) clearInterval(eqInterval);

            eqInterval = setInterval(() => {
                const video = document.querySelector('video.html5-main-video');
                if (video && video !== currentVideo) {
                    if (mediaSource) mediaSource.disconnect();
                    currentVideo = video;
                    mediaSource = audioCtx.createMediaElementSource(currentVideo);
                    mediaSource.connect(analyser);
                }

                if (analyser && ws.readyState === WebSocket.OPEN) {
                    analyser.getByteFrequencyData(dataArray);
                    const eqData = [
                        dataArray[1] || 0, dataArray[2] || 0, dataArray[3] || 0,
                        dataArray[4] || 0, dataArray[6] || 0, dataArray[8] || 0,
                        dataArray[12] || 0, dataArray[16] || 0, dataArray[20] || 0,
                        dataArray[24] || 0
                    ];
                    ws.send(JSON.stringify({ type: 'eq_data', data: eqData }));
                }
            }, 33);
        };

        ws.onclose = () => {
            if (eqInterval) clearInterval(eqInterval);
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
            console.error("오디오 설정 중 오류 발생:", e);
        }
    };

    window.addEventListener('click', () => {
        if (!audioSetupDone) setupAudioAnalysis();
    }, { once: true });

})();