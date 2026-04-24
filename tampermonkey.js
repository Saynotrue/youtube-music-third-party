// ==UserScript==
// @name         YouTube Music Ultimate Integration (Lyrics, Visualizer, Remote)
// @namespace    http://tampermonkey.net/
// @version      5.2
// @description  가사 바 앱을 위한 완벽한 통합 스크립트 (가짜 비디오 버그 수정)
// @author       You
// @match        https://music.youtube.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    'use strict';

    console.log("⚡ [가사 바 통합 스크립트] 모든 모듈 가동 준비 완료!");

    // =====================================================================
    // 1. 상태 및 가사 전송 (1초마다 가사 바에 현재 상태 알려주기)
    // =====================================================================
    setInterval(() => {
        // 🚀 수정됨: 'video.html5-main-video'로 진짜 음악 소스만 정확히 타겟팅합니다.
        const video = document.querySelector('video.html5-main-video');
        const titleEl = document.querySelector('ytmusic-player-bar .title') || document.querySelector('yt-formatted-string.title');
        const bylineEl = document.querySelector('ytmusic-player-bar .byline');
        const imgEl = document.querySelector('ytmusic-player-bar img');

        const activeLyric = document.querySelector('.ytmusic-player-page .active-lyric');

        if (!video || !titleEl) return;

        const bylineText = bylineEl ? bylineEl.textContent : '';
        const parts = bylineText.split(' • ');
        const artist = parts[0] || '';
        const album = parts[1] || '';
        const currentLyric = activeLyric ? activeLyric.textContent.trim() : "";

        const state = {
            playing: !video.paused,
            title: titleEl.textContent.trim(),
            artist: artist.trim(),
            album: album.trim(),
            albumArt: imgEl ? imgEl.src : '',
            progress: Math.floor(video.currentTime * 1000),
            duration: Math.floor(video.duration * 1000),
            lyric: currentLyric
        };

        GM_xmlhttpRequest({
            method: "POST",
            url: "http://127.0.0.1:8888/update-state",
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify(state),
            onerror: () => {
                // 앱이 꺼져있을 때 브라우저 콘솔에 에러가 도배되는 것을 방지
            }
        });
    }, 1000);

    // =====================================================================
    // 2. 실시간 명령 수신기 (딜레이 제로 리모컨 - 자동 재연결 적용)
    // =====================================================================
    let evtSource = null;

    function connectSSE() {
        if (evtSource) evtSource.close();
        evtSource = new EventSource("http://127.0.0.1:8888/command-stream");

        evtSource.onmessage = function (event) {
            const command = event.data;
            console.log(`⚡ [명령 수신] 즉시 실행: ${command}`);

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
            console.log("🔴 [가사 바] 리모컨 서버 연결 끊김. 3초 후 재연결 시도...");
            evtSource.close();
            setTimeout(connectSSE, 3000);
        };
    }

    connectSSE();

    // =====================================================================
    // 3. 오디오 분석 및 비주얼라이저 로직 (자동 재연결 적용)
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
            console.log("✅ 비주얼라이저 웹소켓 서버 연결 완료!");
            const dataArray = new Uint8Array(analyser.frequencyBinCount);

            if (eqInterval) clearInterval(eqInterval);

            eqInterval = setInterval(() => {
                // 🚀 수정됨: 이퀄라이저도 가짜 비디오가 아닌 진짜 비디오에서 소리를 가져오도록 수정
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
                        dataArray[1] || 0,
                        dataArray[2] || 0,
                        dataArray[3] || 0,
                        dataArray[4] || 0,
                        dataArray[6] || 0,
                        dataArray[8] || 0,
                        dataArray[12] || 0,
                        dataArray[16] || 0,
                        dataArray[20] || 0,
                        dataArray[24] || 0
                    ];

                    ws.send(JSON.stringify({ type: 'eq_data', data: eqData }));
                }
            }, 33);
        };

        ws.onclose = () => {
            console.log("🔴 비주얼라이저 연결 끊김. 3초 후 재접속을 시도합니다...");
            if (eqInterval) clearInterval(eqInterval);
            setTimeout(connectWS, 3000);
        };

        ws.onerror = () => {
            ws.close();
        };
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
            console.log("✅ 오디오 분석기 준비 완료");

            connectWS();

        } catch (e) {
            console.error("오디오 설정 중 오류 발생:", e);
        }
    };

    window.addEventListener('click', () => {
        if (!audioSetupDone) setupAudioAnalysis();
    }, { once: true });

})();
