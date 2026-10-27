// ==UserScript==
// @name         YouTube Music Ultimate Integration (Ultra Light v7.1)
// @namespace    http://tampermonkey.net/
// @version      9.0
// @author       You
// @match        https://music.youtube.com/*
// @match        https://www.youtube.com/embed/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    // 유튜브 뮤직 페이지 안의 다른 프레임에서는 실행하지 않음 (임베드 플레이어는 아래 자막 추출 전용으로만 실행)
    if (location.hostname === 'music.youtube.com' && window.top !== window.self) return;

    // =====================================================================
    // 0. 유튜브 자막 추출 (lrclib에 가사가 없을 때 서버가 요청)
    //    페이지의 플레이어가 자막을 불러오게 한 뒤 그 응답을 가로채 LRC로 변환해서 서버로 전송
    //    (자막 주소로 직접 요청하면 플레이어의 인증 토큰이 없어 빈 응답이 오므로 플레이어를 통해 받음)
    // =====================================================================

    function msToLrcTag(ms) {
        const mins = Math.floor(ms / 60000);
        const secs = ((ms % 60000) / 1000).toFixed(2);
        return `[${String(mins).padStart(2, '0')}:${secs.padStart(5, '0')}]`;
    }

    // json3 / srv3(XML) / 구형 XML 자막을 모두 LRC로 변환
    function captionsToLrc(raw) {
        const lines = [];
        const push = (ms, text) => {
            const clean = (text || '').replace(/\s*\n\s*/g, ' ').trim();
            if (clean) lines.push(`${msToLrcTag(ms)} ${clean}`);
        };

        const body = (raw || '').trim();
        if (!body) return null;

        if (body.startsWith('{')) {
            const json = JSON.parse(body);
            for (const ev of json.events || []) {
                if (!ev.segs) continue;
                push(ev.tStartMs || 0, ev.segs.map(s => s.utf8 || '').join(''));
            }
        } else {
            const doc = new DOMParser().parseFromString(body, 'text/xml');
            doc.querySelectorAll('p[t]').forEach(p => push(Number(p.getAttribute('t')), p.textContent));
            if (lines.length === 0) {
                doc.querySelectorAll('text[start]').forEach(t => push(parseFloat(t.getAttribute('start')) * 1000, t.textContent));
            }
        }
        return lines.length > 0 ? lines.join('\n') : null;
    }

    function postCaptions(videoId, lyrics, lang, from) {
        fetch("http://127.0.0.1:8888/yt-captions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ videoId, lyrics, lang, from })
        }).catch(() => { });
    }

    // 직접 등록한 자막(자동 생성 제외) 중 원하는 언어 순으로 선택, 없으면 첫 번째 자막
    function pickCaptionTrack(tracks, langs) {
        const manual = tracks.filter(t => t.kind !== 'asr');
        for (const lang of langs) {
            const track = manual.find(t => (t.languageCode || '').slice(0, 2) === lang);
            if (track) return track;
        }
        return manual[0] || null;
    }

    // 추출하는 동안 화면에 자막이 뜨지 않도록 숨김
    function setCaptionsHidden(hidden) {
        let style = document.getElementById('lyrics-widget-hide-captions');
        if (hidden && !style) {
            style = document.createElement('style');
            style.id = 'lyrics-widget-hide-captions';
            style.textContent = '.ytp-caption-window-container, .caption-window { display: none !important; }';
            document.documentElement.appendChild(style);
        } else if (!hidden && style) {
            style.remove();
        }
    }

    // 플레이어가 자막을 불러오게 하고 그 응답을 가로챔 → { lyrics, lang } | null
    const CAPTION_TIMEOUT_MS = 8000;
    let captionCapture = null; // 진행 중인 추출: { videoId, finish }

    function handleTimedTextResponse(url, raw) {
        if (!captionCapture) return;
        try {
            const u = new URL(url, location.origin);
            if (!u.pathname.includes('/api/timedtext') || u.searchParams.get('kind') === 'asr') return;
            if (u.searchParams.get('v') !== captionCapture.videoId) return;
            const lrc = captionsToLrc(raw);
            if (lrc) captionCapture.finish(lrc);
        } catch (e) { }
    }

    const origFetch = window.fetch;
    window.fetch = function (input) {
        const promise = origFetch.apply(this, arguments);
        const url = typeof input === 'string' ? input : input?.url;
        if (url && url.includes('/api/timedtext')) {
            promise.then(r => r.clone().text()).then(raw => handleTimedTextResponse(url, raw)).catch(() => { });
        }
        return promise;
    };

    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        if (typeof url === 'string' && url.includes('/api/timedtext')) {
            this.addEventListener('load', () => {
                if (this.responseType === '' || this.responseType === 'text') handleTimedTextResponse(url, this.responseText);
            });
        }
        return origOpen.apply(this, arguments);
    };

    function capturePlayerCaptions(player, videoId, langs) {
        return new Promise(async (resolve) => {
            if (captionCapture) captionCapture.finish(null);

            let restoreTrack = null;
            try { restoreTrack = player.getOption?.('captions', 'track'); } catch (e) { }
            let lang = null;
            const finish = (lyrics) => {
                if (captionCapture?.finish !== finish) return;
                captionCapture = null;
                clearTimeout(timer);
                // 원래 쓰던 자막 설정으로 되돌림 (꺼져 있었으면 끔)
                try {
                    if (restoreTrack?.languageCode) player.setOption?.('captions', 'track', restoreTrack);
                    else { player.setOption?.('captions', 'track', {}); player.unloadModule?.('captions'); }
                } catch (e) { }
                setCaptionsHidden(false);
                resolve(lyrics ? { lyrics, lang } : null);
            };
            const timer = setTimeout(() => finish(null), CAPTION_TIMEOUT_MS);
            captionCapture = { videoId, finish };
            setCaptionsHidden(true);

            try {
                player.loadModule?.('captions');
                // 자막 모듈이 뜬 뒤 플레이어 자막 목록에서 원하는 언어를 선택 (불러오는 순간 응답을 가로챔)
                let track = null;
                for (let i = 0; i < 25 && !track && captionCapture?.finish === finish; i++) {
                    track = pickCaptionTrack(player.getOption?.('captions', 'tracklist') || [], langs);
                    if (!track) await new Promise(r => setTimeout(r, 200));
                }
                if (captionCapture?.finish !== finish) return;
                if (!track) return finish(null); // 직접 등록한 자막이 없음
                lang = track.languageCode;
                player.setOption?.('captions', 'track', track);
            } catch (e) {
                finish(null);
            }
        });
    }

    // ── 뮤직비디오 임베드 플레이어 안에서 실행되는 경우 ──
    //    유튜브 뮤직 페이지가 숨겨진 임베드로 띄운 뮤직비디오의 자막을 추출해 부모 페이지로 전달
    if (location.hostname === 'www.youtube.com') {
        const match = (location.hash + '&' + location.search).match(/lyrics-widget=([^&#]*)/);
        if (window.top === window.self || !match) return;
        const langs = decodeURIComponent(match[1]).split(',').filter(Boolean);
        const videoId = location.pathname.split('/embed/')[1]?.split(/[/?#]/)[0];
        const reply = (result) => window.parent.postMessage({ lyricsWidgetCaptions: true, videoId, result }, 'https://music.youtube.com');

        let tries = 0;
        const waitPlayer = setInterval(() => {
            const player = document.getElementById('movie_player');
            if (player?.getOption && player.loadModule) {
                clearInterval(waitPlayer);
                capturePlayerCaptions(player, videoId, langs).then(reply);
            } else if (++tries > 50) {
                clearInterval(waitPlayer);
                reply(null);
            }
        }, 200);
        return;
    }

    // 다른 영상(뮤직비디오)을 숨겨진 임베드 플레이어로 띄워 자막 추출
    const EMBED_TIMEOUT_MS = 12000;
    function captureEmbedCaptions(videoId, langs) {
        return new Promise(resolve => {
            const iframe = document.createElement('iframe');
            const done = (result) => {
                clearTimeout(timer);
                window.removeEventListener('message', onMessage);
                iframe.remove();
                resolve(result);
            };
            const onMessage = (e) => {
                if (e.origin === 'https://www.youtube.com' && e.data?.lyricsWidgetCaptions && e.data.videoId === videoId) done(e.data.result);
            };
            const timer = setTimeout(() => done(null), EMBED_TIMEOUT_MS);
            window.addEventListener('message', onMessage);

            const lang = langs[0] || 'ko';
            const marker = `lyrics-widget=${encodeURIComponent(langs.join(','))}`;
            iframe.src = `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1&cc_lang_pref=${lang}&hl=${lang}&${marker}#${marker}`;
            iframe.allow = 'autoplay';
            iframe.style.cssText = 'position:fixed;left:-400px;top:-400px;width:320px;height:180px;opacity:0;pointer-events:none;border:0;';
            document.documentElement.appendChild(iframe);
        });
    }

    // 서버 요청: 재생 중인 영상의 자막 → 없으면 뮤직비디오 후보의 자막 순으로 시도
    async function extractCaptions({ videoId, langs = [], candidates = [] }) {
        let result = null;
        const player = document.getElementById('movie_player');
        if (player && player.getVideoData?.().video_id === videoId) {
            // 곡 정보의 자막 목록에 직접 등록한 자막이 있을 때만 플레이어를 건드림
            const listed = player.getPlayerResponse?.()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            if (pickCaptionTrack(listed, langs)) result = await capturePlayerCaptions(player, videoId, langs);
        }
        for (const candidate of candidates) {
            if (result) break;
            result = await captureEmbedCaptions(candidate, langs);
            if (result) result.from = candidate;
        }
        postCaptions(videoId, result?.lyrics || null, result?.lang, result?.from);
    }

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

        // 자동 생성 아티스트 채널은 "K/DA - Topic"처럼 " - Topic"이 붙음
        artist = artist.replace(/\s+-\s+Topic$/i, '');
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
            lyric: currentLyric,
            // 위젯의 소리 조절 슬라이더에 현재 볼륨 표시 (0~100)
            volume: player?.getVolume ? player.getVolume() : (video ? Math.round(video.volume * 100) : undefined),
            muted: player?.isMuted ? player.isMuted() : !!video?.muted
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

    // ─── 부드러운 일시정지/이동: 소리를 서서히 줄인 뒤 동작하고, 다시 서서히 올림 ───
    // 오디오 연결(fadeGain)은 페이지를 한 번 클릭한 뒤에 생기므로, 그 전에는 페이드 없이 바로 동작
    const PAUSE_FADE_MS = 300;
    const SEEK_FADE_OUT_MS = 200;
    const FADE_IN_MS = 350;
    let fadeSeq = 0; // 연속 입력(예: → 여러 번) 때 마지막 동작만 소리를 다시 올리도록

    function fadeOutput(target, ms) {
        if (!fadeGain || !audioCtx) return Promise.resolve();
        const g = fadeGain.gain, now = audioCtx.currentTime;
        g.cancelScheduledValues(now);
        g.setValueAtTime(g.value, now);
        g.linearRampToValueAtTime(target, now + ms / 1000);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function setOutputGain(value) {
        if (!fadeGain || !audioCtx) return;
        fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
        fadeGain.gain.setValueAtTime(value, audioCtx.currentTime);
    }

    // 영상에서 이벤트가 오거나 시간이 지나면 진행
    function waitForVideoEvent(video, type, timeoutMs) {
        return new Promise(resolve => {
            if (!video) return resolve();
            const done = () => { clearTimeout(timer); video.removeEventListener(type, done); resolve(); };
            const timer = setTimeout(done, timeoutMs);
            video.addEventListener(type, done, { once: true });
        });
    }

    function isVideoPlaying() {
        const video = document.querySelector('video.html5-main-video');
        return navigator.mediaSession?.playbackState
            ? navigator.mediaSession.playbackState === 'playing'
            : !!(video && !video.paused);
    }

    function pausePlayback() {
        const video = document.querySelector('video.html5-main-video');
        if (runMediaAction('pause')) return;
        if (clickPlayerBarButton(['#play-pause-button', '.play-pause-button'])) return;
        video?.pause();
    }

    function resumePlayback() {
        const video = document.querySelector('video.html5-main-video');
        if (runMediaAction('play')) return;
        if (clickPlayerBarButton(['#play-pause-button', '.play-pause-button'])) return;
        video?.play();
    }

    async function togglePlaybackWithFade() {
        const seq = ++fadeSeq;
        const video = document.querySelector('video.html5-main-video');
        if (isVideoPlaying()) {
            await fadeOutput(0, PAUSE_FADE_MS);
            if (seq !== fadeSeq) return;
            pausePlayback();
            // 멈춘 뒤에는 음량을 원래대로 (유튜브 뮤직 화면에서 직접 재생해도 소리가 나도록)
            await waitForVideoEvent(video, 'pause', 300);
            if (seq === fadeSeq) setOutputGain(1);
        } else {
            setOutputGain(0);
            resumePlayback();
            await waitForVideoEvent(video, 'playing', 600); // 실제로 소리가 나기 시작한 뒤 올림
            if (seq === fadeSeq) fadeOutput(1, FADE_IN_MS);
        }
    }

    async function seekWithFade(sec) {
        const seq = ++fadeSeq;
        const video = document.querySelector('video.html5-main-video');
        const playing = isVideoPlaying();
        if (playing) {
            await fadeOutput(0, SEEK_FADE_OUT_MS);
            if (seq !== fadeSeq) return; // 그 사이 새 이동 요청이 오면 그것만 처리
        }
        seekTo(sec);
        if (!playing) return;
        await waitForVideoEvent(video, 'seeked', 700);
        if (seq === fadeSeq) fadeOutput(1, FADE_IN_MS);
    }

    // 위젯에서 가사 클릭 → 해당 위치로 이동
    // 플레이어 API(seekTo)가 조용히 무시되는 경우가 있어, 실제로 이동했는지 확인하고 안 됐으면 영상 위치를 직접 바꿈
    function seekTo(sec) {
        if (!Number.isFinite(sec) || sec < 0) return;
        const player = document.getElementById('movie_player');
        const video = document.querySelector('video.html5-main-video');
        const currentSec = () => player?.getCurrentTime?.() ?? video?.currentTime ?? 0;
        try { player?.seekTo?.(sec, true); } catch (e) { }
        setTimeout(() => {
            if (Math.abs(currentSec() - sec) > 2 && video) {
                console.log('[가사 위젯] 플레이어 이동 실패 → 영상 위치 직접 변경', sec);
                video.currentTime = sec;
            }
        }, 400);
    }

    // 위젯 소리 조절 → 유튜브 뮤직 볼륨 변경 (플레이어 바의 볼륨 슬라이더 표시도 맞춤)
    function setVolume(volume) {
        if (!Number.isFinite(volume)) return;
        const player = document.getElementById('movie_player');
        if (player?.setVolume) {
            player.setVolume(volume);
            if (volume > 0 && player.isMuted?.()) player.unMute?.();
        } else {
            const video = document.querySelector('video.html5-main-video');
            if (video) { video.volume = volume / 100; if (volume > 0) video.muted = false; }
        }
        const barSlider = document.querySelector('ytmusic-player-bar #volume-slider');
        if (barSlider) barSlider.value = volume;
    }

    // 위젯 소리 버튼 클릭 → 음소거/해제
    function setMuted(muted) {
        const player = document.getElementById('movie_player');
        if (player?.mute && player?.unMute) muted ? player.mute() : player.unMute();
        else { const video = document.querySelector('video.html5-main-video'); if (video) video.muted = muted; }
    }

    function handleCommand(command) {
        if (command.startsWith('captions:')) {
            try { extractCaptions(JSON.parse(command.slice('captions:'.length))); } catch (e) { }
            return;
        }
        if (command.startsWith('mute:')) {
            setMuted(command === 'mute:1');
            return;
        }
        if (command.startsWith('volume:')) {
            setVolume(Number(command.slice('volume:'.length)));
            return;
        }
        if (command.startsWith('seek:')) {
            seekWithFade(Number(command.slice('seek:'.length)) / 1000);
            return;
        }
        if (command === 'play-pause') {
            togglePlaybackWithFade();
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
    // 🚨 저음 전용 분석기: 기본 분석기(256)는 한 칸이 약 172Hz라 킥·서브 베이스(40~150Hz)를 구분하지 못함
    //    → 칸을 약 21Hz로 잘게 나누는 분석기(2048)를 따로 두고 낮은 막대 4개만 여기서 계산 (나머지 막대는 그대로)
    let bassAnalyser = null;
    // 낮은 막대 4개의 주파수 범위(Hz): 킥·서브 베이스 / 베이스 / 저음 / 중저음
    const BASS_BANDS = [[40, 90], [90, 180], [180, 350], [350, 700]];
    let fadeGain = null; // 일시정지/이동 때 소리를 부드럽게 줄였다 올리는 음량 단계 (유튜브 뮤직 볼륨 값은 그대로)

    // 🚨 볼륨 보정: 영상 볼륨은 분석기에 들어가기 전에 적용되므로, 유튜브 뮤직 볼륨을 줄이면 파형도 작아짐.
    //    볼륨만큼 줄어든 데시벨(예: 50% → -6dB)만큼 분석 범위를 같이 내려서 볼륨과 관계없이 같은 파형을 보여줌.
    //    (음소거·볼륨 0이면 분석할 소리 자체가 없으므로 보정 불가)
    // 분석 범위: 기본값(-100 ~ -30dB)보다 15dB 위로 올림 → 베이스가 큰 곡도 저음역이 최대치(255)에 붙지 않음
    //   (위젯이 15dB만큼 다시 더해 표시하므로 보통 음량의 막대 높이는 그대로, 큰 소리만 더 높이 올라감)
    const BASE_MIN_DB = -85, BASE_MAX_DB = -15;
    let compensatedVolume = 1;
    function compensateVolume(volume) {
        const v = Math.max(volume, 0.01);
        if (Math.abs(v - compensatedVolume) < 0.001) return;
        compensatedVolume = v;
        const offset = 20 * Math.log10(v);
        for (const node of [analyser, bassAnalyser]) {
            if (!node) continue;
            try {
                node.minDecibels = BASE_MIN_DB + offset;
                node.maxDecibels = BASE_MAX_DB + offset;
            } catch (e) { }
        }
    }

    const connectWS = () => {
        if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

        ws = new WebSocket('ws://127.0.0.1:8889');

        ws.onopen = () => {
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const bassData = new Uint8Array(bassAnalyser.frequencyBinCount);
            // 각 범위에 해당하는 칸 번호 (칸 폭 = 샘플레이트 / fftSize)
            const binWidth = audioCtx.sampleRate / bassAnalyser.fftSize;
            const bassBins = BASS_BANDS.map(([lo, hi]) => [Math.max(1, Math.floor(lo / binWidth)), Math.ceil(hi / binWidth)]);
            // 범위 안에서 가장 큰 값 (한 칸이 좁아 소리가 특정 칸에 몰리므로 평균보다 최댓값이 실제 세기에 가까움)
            const bandPeak = ([from, to]) => {
                let peak = 0;
                for (let i = from; i <= to && i < bassData.length; i++) if (bassData[i] > peak) peak = bassData[i];
                return peak;
            };
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
                        mediaSource.connect(bassAnalyser);
                    } catch (e) { }
                }

                if (analyser && ws.readyState === WebSocket.OPEN && currentVideo && !currentVideo.paused) {
                    compensateVolume(currentVideo.volume);
                    analyser.getByteFrequencyData(dataArray);
                    bassAnalyser.getByteFrequencyData(bassData);

                    let hasAudio = false;
                    for (let i = 0; i < 10; i++) { if (dataArray[i] > 0) hasAudio = true; }

                    if (hasAudio) {
                        const eqData = [
                            // 낮은 막대 4개: 저음 전용 분석기 (40~90 / 90~180 / 180~350 / 350~700Hz)
                            ...bassBins.map(bandPeak),
                            // 나머지 6개: 기존 분석기 (약 1.0 / 1.4 / 2.1 / 2.8 / 3.4 / 4.1kHz)
                            dataArray[6] || 0, dataArray[8] || 0,
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
            bassAnalyser = audioCtx.createAnalyser();
            bassAnalyser.fftSize = 2048;
            bassAnalyser.smoothingTimeConstant = 0.4;
            // 영상 → 분석기 → 페이드 음량 → 스피커 (이퀄라이저는 페이드 전 소리를 분석하므로 영향 없음)
            fadeGain = audioCtx.createGain();
            analyser.connect(fadeGain);
            fadeGain.connect(audioCtx.destination);
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