require('dotenv').config();
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8888;
const WS_PORT = 8889;

// --- 미들웨어 설정 ---
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

// --- 전역 상태 및 연결 객체 ---
let playerState = { playing: false };
let commandClient = null;  // 원격 제어용 SSE 클라이언트 (Tampermonkey)
let rendererSocket = null; // 비주얼라이저용 WS 클라이언트 (Electron UI)

// --- 미디어 제어 (SSE 기반) ---
// Tampermonkey 스크립트 연결용 SSE 엔드포인트
app.get('/command-stream', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    commandClient = res;

    req.on('close', () => {
        commandClient = null;
    });
});

// Electron UI -> Tampermonkey 제어 명령 릴레이
app.post('/play-pause', (req, res) => {
    if (commandClient) commandClient.write(`data: play-pause\n\n`);
    res.json({ ok: true });
});

app.post('/previous', (req, res) => {
    if (commandClient) commandClient.write(`data: previous\n\n`);
    res.json({ ok: true });
});

app.post('/next', (req, res) => {
    if (commandClient) commandClient.write(`data: next\n\n`);
    res.json({ ok: true });
});

// --- 상태 동기화 (REST API) ---
// Tampermonkey -> Server : 현재 재생 상태 업데이트
app.post('/update-state', (req, res) => {
    playerState = req.body;
    res.json({ ok: true });
});

// Server -> Electron : 최신 상태 반환 (폴링용)
app.get('/current-track', (req, res) => {
    res.json(playerState);
});

// --- 가사 Fetch (LRCLIB API 연동) ---
app.get('/lyrics', async (req, res) => {
    const { title, artist, album } = req.query;

    try {
        // 1차 시도: Exact Match (트랙, 아티스트, 앨범)
        const { data } = await axios.get('https://lrclib.net/api/get', {
            params: { track_name: title, artist_name: artist, album_name: album }
        });
        if (data.syncedLyrics) return res.json({ lyrics: data.syncedLyrics });
    } catch { }

    try {
        // 2차 시도: Search (트랙, 아티스트)
        const { data } = await axios.get('https://lrclib.net/api/search', {
            params: { track_name: title, artist_name: artist }
        });
        const found = data?.find(r => r.syncedLyrics);
        if (found) return res.json({ lyrics: found.syncedLyrics });
    } catch { }

    // 매칭 실패 시 null 반환
    res.json({ lyrics: null });
});

// --- 오디오 비주얼라이저 데이터 릴레이 (WebSocket) ---
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // 렌더러(Electron) 소켓 등록
            if (data.type === 'register_renderer') {
                rendererSocket = ws;
            }
            // 웹(Tampermonkey) -> 렌더러(Electron) EQ 데이터 바이패스
            else if (data.type === 'eq_data' && rendererSocket && rendererSocket.readyState === WebSocket.OPEN) {
                rendererSocket.send(JSON.stringify(data));
            }
        } catch (e) {
            console.error('WebSocket 데이터 파싱 오류:', e);
        }
    });

    // 소켓 연결 종료 시 초기화
    ws.on('close', () => {
        if (rendererSocket === ws) {
            rendererSocket = null;
        }
    });
});

// --- 서버 구동 ---
app.listen(PORT, '127.0.0.1', () => {
    console.log(`[HTTP] Server running at http://127.0.0.1:${PORT}`);
    console.log(`[ WS ] Server running at ws://127.0.0.1:${WS_PORT}`);
});