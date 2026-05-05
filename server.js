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
// 인증 헤더용 Base64 인코딩
const BASE64_CREDENTIALS = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
const AUTH_HEADER = { Authorization: `Basic ${BASE64_CREDENTIALS}`, 'Content-Type': 'application/x-www-form-urlencoded' };

// --- 전역 상태 및 연결 객체 ---
let currentService = 'youtube'; // 'youtube' | 'spotify' 현재 서비스 상태
let playerState = { playing: false }; // YouTube 재생 상태
let commandClient = null;  // YouTube 원격 제어용 SSE 클라이언트
let rendererSocket = null; // YouTube 비주얼라이저용 WS 클라이언트[cite: 5]
let accessToken = null;    // Spotify Access Token
let refreshToken = null;   // Spotify Refresh Token[cite: 6]

// --- 미들웨어 설정 ---
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

// ─── 1. 서비스 전환 라우트 ──────────────────────────────────
app.post('/set-service', (req, res) => {
    let needsSetup = false;

    if (req.body.service) {
        currentService = req.body.service;

        // 스포티파이로 변경했을 때의 논리
        if (currentService === 'spotify') {
            if (!process.env.SPOTIFY_CLIENT_ID) {
                needsSetup = true; // Client ID가 없으면 셋업 창 열기 요청
            } else if (!accessToken) {
                // ID는 있는데 토큰이 없으면 즉시 브라우저를 열어 로그인 시도
                shell.openExternal(`http://127.0.0.1:${PORT}/login`);
            }
        }
    }
    res.json({ ok: true, currentService, needsSetup });
});

// ─── Spotify 인증 ────────────────────────────────────────
async function refreshAccessToken() {
    try {
        const { data } = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
            { headers: AUTH_HEADER }
        );
        accessToken = data.access_token;
    } catch (e) {
        console.error('Spotify 리프레시 실패:', e.response?.data);
    }
}

// ─── 2. Spotify 인증 유틸리티 (🚨 누락되었던 핵심 함수들) ───
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
    } catch (e) {
        console.error('Spotify 리프레시 실패:', e.response?.data);
    }
}

// ─── 3. Spotify 로그인 & 콜백 ──────────────────────────────
app.get('/login', (req, res) => {
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const redirectUri = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
    const scopes = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';

    if (!clientId) return res.status(400).send('Spotify Client ID가 설정되지 않았습니다.');

    res.redirect(
        `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scopes)}`
    );
});

app.get('/callback', async (req, res) => {
    const redirectUri = process.env.REDIRECT_URI || `http://127.0.0.1:${PORT}/callback`;
    const header = getSpotifyAuthHeader(); // 🚨 여기서 에러가 났었습니다! 이제 정상 작동합니다.

    try {
        const { data } = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({ grant_type: 'authorization_code', code: req.query.code, redirect_uri: redirectUri }),
            { headers: header }
        );
        accessToken = data.access_token;
        refreshToken = data.refresh_token;
        console.log('✅ Spotify 토큰 수신 완료');
        res.send('<script>window.close()</script>');
    } catch (e) {
        // 인증 실패 시 상세 에러를 화면에 표시
        const errData = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error('Spotify 콜백 실패:', errData);
        res.status(500).send(`
            <div style="font-family: sans-serif; padding: 20px;">
                <h2>인증 실패 😢</h2>
                <p>스포티파이 서버에서 토큰 교환을 거절했습니다. (주로 Secret 키 오타 또는 띄어쓰기 문제)</p>
                <p style="color: red;"><strong>에러 상세:</strong> ${errData}</p>
                <hr>
                <p><strong>해결 방법:</strong></p>
                <ol>
                    <li>이 창을 닫습니다.</li>
                    <li>앱 설정에서 라이센스 <b>초기화</b> 버튼을 눌러주세요.</li>
                    <li>Spotify를 다시 선택한 뒤, Client ID와 Secret을 다시 복사해서 붙여넣어 주세요.</li>
                </ol>
            </div>
        `);
    }
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
        console.log('✅ Spotify 토큰 수신 완료');
        res.send('<script>window.close()</script>'); // 성공하면 창 자동 닫힘
    } catch (e) {
        // 🚨 브라우저 화면에 정확한 에러 원인을 띄워줍니다.
        const errData = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        console.error('Spotify 콜백 실패:', errData);
        res.status(500).send(`
            <div style="font-family: sans-serif; padding: 20px;">
                <h2>인증 실패 😢</h2>
                <p>스포티파이 서버에서 토큰 교환을 거절했습니다.</p>
                <p style="color: red;"><strong>에러 상세:</strong> ${errData}</p>
                <hr>
                <p><strong>해결 방법:</strong></p>
                <ol>
                    <li>창을 닫고 앱 설정에서 라이센스 <b>초기화</b> 버튼을 눌러주세요.</li>
                    <li>Spotify를 다시 선택한 뒤, Client ID와 Secret을 다시 입력해 주세요.</li>
                </ol>
            </div>
        `);
    }
});

// ─── 미디어 제어 (공통 엔드포인트) ───────────────────────
// YouTube(SSE)[cite: 5] 와 Spotify(API)[cite: 6] 를 분기하여 처리

app.get('/command-stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    commandClient = res;
    req.on('close', () => { commandClient = null; });
});

app.post('/play-pause', async (req, res) => {
    if (currentService === 'youtube') {
        if (commandClient) commandClient.write(`data: play-pause\n\n`);
        res.json({ ok: true });
    } else if (currentService === 'spotify') {
        const { playing } = req.body;
        try {
            await axios.put(`https://api.spotify.com/v1/me/player/${playing ? 'pause' : 'play'}`, null, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false });
        }
    }
});

app.post('/previous', async (req, res) => {
    if (currentService === 'youtube') {
        if (commandClient) commandClient.write(`data: previous\n\n`);
        res.json({ ok: true });
    } else if (currentService === 'spotify') {
        try {
            await axios.post('https://api.spotify.com/v1/me/player/previous', null, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false });
        }
    }
});

app.post('/next', async (req, res) => {
    if (currentService === 'youtube') {
        if (commandClient) commandClient.write(`data: next\n\n`);
        res.json({ ok: true });
    } else if (currentService === 'spotify') {
        try {
            await axios.post('https://api.spotify.com/v1/me/player/next', null, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });
            res.json({ ok: true });
        } catch (e) {
            res.json({ ok: false });
        }
    }
});

// ─── 상태 동기화 (공통 엔드포인트) ───────────────────────
app.post('/update-state', (req, res) => {
    if (currentService === 'youtube') {
        playerState = req.body; // YouTube 상태 캐싱[cite: 5]
    }
    res.json({ ok: true });
});

app.get('/current-track', async (req, res) => {
    if (currentService === 'youtube') {
        res.json(playerState); // YouTube 상태 반환[cite: 5]
    } else if (currentService === 'spotify') {
        if (!accessToken) return res.json({ playing: false });

        try {
            const { data } = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            if (!data?.item) return res.json({ playing: false });

            res.json({
                playing: data.is_playing,
                title: data.item.name,
                artist: data.item.artists.map(a => a.name).join(', '),
                album: data.item.album.name,
                albumArt: data.item.album.images[0]?.url,
                progress: data.progress_ms,
                duration: data.item.duration_ms,
            });
        } catch (e) {
            if (e.response?.status === 401) await refreshAccessToken();
            res.json({ playing: false });
        }
    }
});

// ─── 가사 Fetch (공통) ───────────────────────────────────
app.get('/lyrics', async (req, res) => {
    const { title, artist, album } = req.query;

    try {
        const { data } = await axios.get('https://lrclib.net/api/get', {
            params: { track_name: title, artist_name: artist, album_name: album }
        });
        if (data.syncedLyrics) return res.json({ lyrics: data.syncedLyrics });
    } catch { }

    try {
        const { data } = await axios.get('https://lrclib.net/api/search', {
            params: { track_name: title, artist_name: artist }
        });
        const found = data?.find(r => r.syncedLyrics);
        if (found) return res.json({ lyrics: found.syncedLyrics });
    } catch { }

    res.json({ lyrics: null });
});

// ─── 오디오 비주얼라이저 릴레이 (YouTube 전용 WebSocket) ──
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register_renderer') {
                rendererSocket = ws;
            } else if (data.type === 'eq_data' && rendererSocket && rendererSocket.readyState === WebSocket.OPEN) {
                rendererSocket.send(JSON.stringify(data));
            }
        } catch (e) {
            console.error('WebSocket 파싱 오류:', e);
        }
    });

    ws.on('close', () => {
        if (rendererSocket === ws) rendererSocket = null;
    });
});

// ─── 서버 구동 ───────────────────────────────────────────
app.listen(PORT, '127.0.0.1', () => {
    console.log(`[HTTP] 통합 서버 실행 중: http://127.0.0.1:${PORT}`);
    console.log(`[ WS ] WebSocket 실행 중: ws://127.0.0.1:${WS_PORT}`);
});