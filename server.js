require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 8888;

// CORS 허용 (웹 브라우저에서 오는 요청을 받기 위해)
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

// 브라우저에서 보내줄 현재 재생 상태를 저장할 변수
let playerState = { playing: false };

// 브라우저와 연결된 실시간 통신 파이프 (버튼 즉각 반응용)
let commandClient = null;

// ─── 실시간 통신 파이프 연결 (SSE) ───────────────────────
app.get('/command-stream', (req, res) => {
    // 브라우저에게 "연결 끊지 말고 계속 대기해!" 라고 알려줍니다.
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    });
    commandClient = res; // 연결된 브라우저 기억하기

    req.on('close', () => {
        commandClient = null; // 브라우저 창이 닫히면 기억 지우기
    });
});

// ─── 가사 바에서 버튼 누를 때 -> 브라우저로 즉시 쏘기! ─────
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

// ─── 브라우저에서 정보 수신 ──────────────────────────────
app.post('/update-state', (req, res) => {
    playerState = req.body;
    res.json({ ok: true });
});

// ─── Electron 앱(app.js)으로 정보 전달 ──────────────────────
app.get('/current-track', (req, res) => {
    res.json(playerState);
});

// ─── 가사 검색 (기존 LRCLIB 유지) ───────────────────────────
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

// ─── 실시간 오디오 비주얼라이저 중계 (WebSocket) ───────────
const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8889 }); // 8889 포트 사용

let rendererSocket = null;

wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const data = JSON.parse(message);
        
        // Electron 앱(가사 바)이 연결되었을 때 등록
        if (data.type === 'register_renderer') {
            rendererSocket = ws;
        } 
        // Tampermonkey에서 주파수(EQ) 데이터를 보낼 때
        else if (data.type === 'eq_data' && rendererSocket) {
            // Electron 앱으로 즉시 전달
            rendererSocket.send(JSON.stringify(data));
        }
    });
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`http://127.0.0.1:${PORT}`);
});