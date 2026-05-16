require('dotenv').config();
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const { shell } = require('electron');

const app = express();
const PORT = process.env.PORT || 8888;
const WS_PORT = 8889;

// --- Spotify 설정 ---
const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, REDIRECT_URI } = process.env;
const SCOPES = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';

let currentService = 'youtube';
let playerState = { playing: false };
let commandClient = null;
let rendererSocket = null;
let accessToken = null;
let refreshToken = null;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

// ─── 서비스 전환 및 인증 ────────────────────────────────
app.post('/set-service', (req, res) => {
    let needsSetup = false;
    if (req.body.service) {
        currentService = req.body.service;
        if (currentService === 'spotify') {
            if (!process.env.SPOTIFY_CLIENT_ID) needsSetup = true;
            else if (!accessToken) shell.openExternal(`http://127.0.0.1:${PORT}/login`);
        }
    }
    res.json({ ok: true, currentService, needsSetup });
});

function getSpotifyAuthHeader() {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    const base64Credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    return { Authorization: `Basic ${base64Credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' };
}

async function refreshAccessToken() {
    const header = getSpotifyAuthHeader();
    if (!header || !refreshToken) return;
    try {
        const { data } = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
            { headers: header }
        );
        accessToken = data.access_token;
    } catch (e) { }
}

app.get('/login', (req, res) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
    if (!clientId) return res.status(400).send('Spotify Client ID가 설정되지 않았습니다.');
    res.redirect(`https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(SCOPES)}`);
});

app.get('/callback', async (req, res) => {
    const redirectUri = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
    const header = getSpotifyAuthHeader();
    try {
        const { data } = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri }),
            { headers: header }
        );
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
        res.send('<script>window.close()</script>');
    } catch (e) {
        const errData = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        res.status(500).send(`<div style="padding: 20px;"><h2>인증 실패 😢</h2><p>${errData}</p></div>`);
    }
});

// ─── 미디어 제어 및 상태 동기화 ───────────────────────────
app.get('/command-stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    commandClient = res;
    req.on('close', () => { commandClient = null; });
});

app.post('/play-pause', async (req, res) => {
    if (currentService === 'youtube') {
        if (commandClient) commandClient.write(`data: play-pause\n\n`);
        res.json({ ok: true });
    } else if (currentService === 'spotify') {
        try {
            await axios.put(`https://api.spotify.com/v1/me/player/${req.body.playing ? 'pause' : 'play'}`, null, { headers: { Authorization: `Bearer ${accessToken}` } });
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false }); }
    }
});

app.post('/previous', async (req, res) => {
    if (currentService === 'youtube') {
        if (commandClient) commandClient.write(`data: previous\n\n`);
        res.json({ ok: true });
    } else if (currentService === 'spotify') {
        try {
            await axios.post('https://api.spotify.com/v1/me/player/previous', null, { headers: { Authorization: `Bearer ${accessToken}` } });
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false }); }
    }
});

app.post('/next', async (req, res) => {
    if (currentService === 'youtube') {
        if (commandClient) commandClient.write(`data: next\n\n`);
        res.json({ ok: true });
    } else if (currentService === 'spotify') {
        try {
            await axios.post('https://api.spotify.com/v1/me/player/next', null, { headers: { Authorization: `Bearer ${accessToken}` } });
            res.json({ ok: true });
        } catch (e) { res.json({ ok: false }); }
    }
});

app.post('/update-state', (req, res) => {
    if (currentService === 'youtube') playerState = req.body;
    res.json({ ok: true });
});

app.get('/current-track', async (req, res) => {
    if (currentService === 'youtube') {
        res.json(playerState);
    } else if (currentService === 'spotify') {
        if (!accessToken) return res.json({ playing: false });
        try {
            const { data } = await axios.get('https://api.spotify.com/v1/me/player', { headers: { Authorization: `Bearer ${accessToken}` } });
            if (!data?.item) return res.json({ playing: false });
            res.json({
                playing: data.is_playing, title: data.item.name, artist: data.item.artists.map(a => a.name).join(', '),
                album: data.item.album.name, albumArt: data.item.album.images[0]?.url, progress: data.progress_ms, duration: data.item.duration_ms,
            });
        } catch (e) {
            if (e.response?.status === 401) await refreshAccessToken();
            res.json({ playing: false });
        }
    }
});

// ─── 🚨 [궁극기] 커스텀 유튜브 수동 자막(CC) 추출기 ─────────────────
// 이 함수는 '자동 생성 자막(asr)'을 원천적으로 차단합니다!
async function fetchYouTubeCC(vid) {
    try {
        // 1. 유튜브 영상 페이지 소스 코드를 몰래 가져옵니다.
        const { data } = await axios.get(`https://www.youtube.com/watch?v=${vid}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        // 2. 소스 코드 안에서 자막 데이터가 숨겨진 부분을 찾아냅니다.
        const match = data.match(/"captionTracks":(\[.*?\])/);
        if (!match) return null;

        const tracks = JSON.parse(match[1]);

        // 🚨 3. 핵심: kind가 'asr'(자동 생성)인 것은 가차 없이 버립니다! 수동 자막만 남깁니다.
        const manualTracks = tracks.filter(t => t.kind !== 'asr');

        if (manualTracks.length === 0) {
            console.log(`[가사 검색] ⚠️ 영상에 수동 자막이 존재하지 않습니다. (자동 자막 거부됨)`);
            return null;
        }

        // 4. 언어 우선순위 설정 (한국어 -> 일본어 -> 영어)
        let selectedTrack = null;
        const preferredLangs = ['ko', 'ja', 'en'];

        for (const lang of preferredLangs) {
            // 'ko'만 찾는게 아니라 'ko-KR'도 걸려들도록 유연하게 찾습니다.
            selectedTrack = manualTracks.find(t => t.languageCode.includes(lang));
            if (selectedTrack) break;
        }

        // 한국어/일본어/영어가 없으면 남은 수동 자막 중 첫 번째 것을 씁니다.
        if (!selectedTrack) selectedTrack = manualTracks[0];

        console.log(`[가사 검색] 🎈 완벽한 수동 자막을 찾았습니다! (언어: ${selectedTrack.languageCode})`);

        // 5. 선택된 자막 데이터를 가져와서 가사(LRC) 형태로 예쁘게 조립합니다.
        const xmlRes = await axios.get(selectedTrack.baseUrl);
        const xmlData = xmlRes.data;

        const regex = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g;
        let lrcText = '';
        let matchText;

        const unescapeHtml = (text) => text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

        while ((matchText = regex.exec(xmlData)) !== null) {
            const startSec = parseFloat(matchText[1]);
            let rawText = matchText[2].replace(/<[^>]+>/g, ''); // 내부 HTML 태그 제거
            let cleanText = unescapeHtml(rawText).replace(/\n/g, ' ').trim();

            if (!cleanText) continue;

            const mins = Math.floor(startSec / 60);
            const secs = (startSec % 60).toFixed(2);
            const timeTag = `[${mins.toString().padStart(2, '0')}:${secs.padStart(5, '0')}]`;

            lrcText += `${timeTag} ${cleanText}\n`;
        }

        return lrcText;

    } catch (err) {
        console.error('[가사 검색] 자막 추출 중 오류 발생:', err.message);
    }
    return null;
}

// ─── 가사 Fetch 라우트 ──────────────────────────────────
app.get('/lyrics', async (req, res) => {
    const { title, artist, album, videoId } = req.query;
    const isCover = /cover/i.test(title);

    // [1단계] 커버 곡이면 무조건 유튜브 "수동 자막"부터 가져옵니다.
    if (isCover && videoId) {
        console.log(`[가사 검색] 🎤 커버 곡 감지됨! 유튜브 자막 추출 시도...`);
        const ccLyrics = await fetchYouTubeCC(videoId);
        if (ccLyrics) return res.json({ lyrics: ccLyrics });
        console.log(`[가사 검색] ⚠️ 수동 자막이 없어 일반 가사 DB 탐색으로 넘어갑니다.`);
    }

    // [2단계] 일반 가사 DB 검색
    let cleanTitle = title.split(/[\[\(\-\/\|]/)[0].trim();
    if (!cleanTitle) cleanTitle = title.trim();

    const jpMatch = title.match(/[一-龥ぁ-んァ-ン]+/);
    const jpTitle = jpMatch ? jpMatch[0] : null;

    const findBestLyrics = (data) => {
        if (!data || data.length === 0) return null;
        const syncedResults = data.filter(r => r.syncedLyrics);
        if (syncedResults.length === 0) return null;

        const originalLangMatch = syncedResults.find(r => /[가-힣ぁ-んァ-ン一-龥]/.test(r.syncedLyrics));
        const cleanMatch = syncedResults.find(r => !/romaji|romanized|transliteration/i.test(r.trackName) && !/romaji|romanized|transliteration/i.test(r.albumName));
        return originalLangMatch || cleanMatch || syncedResults[0];
    };

    try {
        let response = await axios.get('https://lrclib.net/api/search', { params: { track_name: cleanTitle, artist_name: artist } });
        let bestMatch = findBestLyrics(response.data);

        if (!bestMatch) {
            response = await axios.get('https://lrclib.net/api/search', { params: { track_name: cleanTitle } });
            bestMatch = findBestLyrics(response.data);
        }
        if (!bestMatch && jpTitle) {
            response = await axios.get('https://lrclib.net/api/search', { params: { track_name: jpTitle } });
            bestMatch = findBestLyrics(response.data);
        }
        if (bestMatch) return res.json({ lyrics: bestMatch.syncedLyrics });
    } catch (e) { console.error("가사 검색 실패:", e.message); }

    // [3단계] 일반 곡인데 DB에 없으면 최후의 수단으로 수동 자막 시도
    if (videoId) {
        const fallbackCC = await fetchYouTubeCC(videoId);
        if (fallbackCC) return res.json({ lyrics: fallbackCC });
    }

    res.json({ lyrics: null });
});

// ─── 오디오 비주얼라이저 릴레이 ───────────────────────────
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register_renderer') {
                rendererSocket = ws;
            } else if (data.type === 'eq_data' && rendererSocket && rendererSocket.readyState === WebSocket.OPEN) {
                if (currentService === 'youtube') rendererSocket.send(JSON.stringify(data));
            }
        } catch (e) { }
    });
    ws.on('close', () => { if (rendererSocket === ws) rendererSocket = null; });
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[HTTP] 통합 서버 실행 중: http://127.0.0.1:${PORT}`);
    console.log(`[ WS ] WebSocket 실행 중: ws://127.0.0.1:${WS_PORT}`);
});