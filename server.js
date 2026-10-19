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
const commandClients = new Set();
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
    res.write(': connected\n\n');
    commandClients.add(res);
    req.on('close', () => { commandClients.delete(res); });
});

function sendCommand(command) {
    for (const client of commandClients) client.write(`data: ${command}\n\n`);
}

app.post('/play-pause', async (req, res) => {
    if (currentService === 'youtube') {
        sendCommand('play-pause');
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
        sendCommand('previous');
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
        sendCommand('next');
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

// 최근 조회 결과 캐시 (오래된 항목부터 삭제)
const CACHE_MAX = 50;

function cacheSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

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

// 텍스트에서 가장 많이 쓰인 문자 체계로 언어 추정 (영문은 글자 단위라 음절 문자와 비슷한 비중이 되도록 보정)
function detectTextLang(text) {
    const count = (re) => (text.match(re) || []).length;
    const scores = {
        ko: count(/[가-힣]/g),
        ja: count(/[ぁ-ゟァ-ヿ]/g) + count(/[一-龥]/g) * 0.5,
        en: count(/[a-zA-Z]/g) / 4,
    };
    const [lang, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return score > 0 ? lang : null;
}

const normalize = (s) => (s || '').toLowerCase().replace(/[\s'"`‘’“”「」『』【】\[\]()（）|·・\-_:~!?.,]/g, '');

// ─── 원곡 정보 추출 (커버 영상 제목 → 원곡 가수 / 원제) ─────────
const JP_CHARS = /[ぁ-ゟァ-ヿ一-龥]/;
const JP_SEGMENTS = /[ぁ-ゟァ-ヿ一-龥々〆ー・·]+/g;
const NON_SONG_GROUP = /cover|커버|ver\.?|version|official|m\/?v|live|라이브|full|short|가사|lyrics|자막|^\s*(4k|8k|hd|fhd|uhd|hq|1080p|4k\s*60fps)\s*$/i;

// 예) "물떼새[ヨルシカ - 千鳥] | 아라하시 타비 cover"        → 후보: 千鳥 / ヨルシカ
//     "푸름과 여름 (Mrs. GREEN APPLE) / 텐코 시부키 cover"     → 가수: Mrs. GREEN APPLE (원제는 검색으로 확인)
//     "아이네 클라이네 (アイネクライネ : 요네즈 켄시) / ..."     → 후보: アイネクライネ / 요네즈 켄시
//     "아 프리오리 (Mrs. GREEN APPLE「ア·プリオリ」) / ..."   → 후보: ア·プリオリ / Mrs. GREEN APPLE
function parseOriginalSong(title) {
    const tracks = [], artists = [], titles = [];
    const add = (list, v) => { v = (v || '').trim(); if (v && !list.includes(v)) list.push(v); };

    // "곡 정보 / 커버 가수" 형태이므로 커버 가수 부분(/, | 뒤)은 제외
    const songPart = title.split(/\s+[\/|｜]\s+/)[0];
    const groups = [...songPart.matchAll(/[\[(（【]([^\])）】]+)[\])）】]/g)].map(m => m[1].trim());
    for (const g of groups) {
        if (NON_SONG_GROUP.test(g) && !JP_CHARS.test(g)) continue;

        const quoted = g.match(/[「『"](.+?)[」』"]/);
        if (quoted) {
            add(tracks, quoted[1]);
            add(artists, g.replace(quoted[0], ''));
            continue;
        }
        // "가수 - 곡명" / "곡명 : 가수" 등 순서가 제각각이므로 양쪽 모두 후보로 사용
        const parts = g.split(/\s+[-–]\s+|\s*[:：]\s*/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
            parts.forEach(p => { add(tracks, p); add(artists, p); });
        } else {
            add(artists, g);
        }
    }

    // 괄호 밖의 "곡명 - 가수" (예: "라일락[ライラック] - Mrs. GREEN APPLE")
    const outside = songPart.replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ').replace(/\s+/g, ' ').trim();
    const outsideParts = outside.split(/\s+[-–]\s+/).map(s => s.trim()).filter(Boolean);
    if (outsideParts.length === 2) outsideParts.forEach(p => add(artists, p));
    // 괄호를 뺀 곡명 후보 (예: "W/X/Y", "Henceforth - Orangestar" → Henceforth / Orangestar, "푸름과 여름")
    // 한글/일본어가 들어간 쪽을 대표 곡명으로 우선 (예: "Mrs. GREEN APPLE - 춘수" → 춘수)
    outsideParts.length === 2
        ? [...outsideParts].sort((a, b) => Number(/[가-힣ぁ-ゟァ-ヿ一-龥]/.test(b)) - Number(/[가-힣ぁ-ゟァ-ヿ一-龥]/.test(a))).forEach(p => add(titles, p))
        : add(titles, outside);

    // 괄호 밖에 있는 일본어 원제도 후보로 추가
    for (const seg of songPart.match(JP_SEGMENTS) || []) add(tracks, seg);

    return { tracks: tracks.filter(t => JP_CHARS.test(t)), artists, titles: titles.filter(t => !tracks.includes(t)) };
}

// 제목에 원제가 없을 때(예: "푸름과 여름"): 유튜브 검색 결과 제목들에 함께 적힌 일본어 원제 중 가장 많이 나온 것을 사용
async function resolveJapaneseTitle(koreanTitle, originalArtist) {
    try {
        const { data } = await axios.post('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
            { context: { client: { clientName: 'WEB', clientVersion: '2.20260901.00.00', hl: 'ko', gl: 'KR' } }, query: `${originalArtist || ''} ${koreanTitle}`.trim() },
            { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });

        const titles = [];
        (function walk(o) {
            if (!o || typeof o !== 'object') return;
            if (o.videoRenderer) { titles.push(o.videoRenderer.title?.runs?.map(r => r.text).join('') || ''); return; }
            for (const k in o) walk(o[k]);
        })(data);

        const nKo = normalize(koreanTitle);
        const nArtist = normalize(originalArtist);
        const counts = new Map();
        const koPattern = [...koreanTitle.replace(/\s+/g, '')].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*');
        const besideKo = new RegExp(`${koPattern}\\s*[\\[(（【「『]\\s*([^\\])）】」』]+?)\\s*[\\])）】」』]`);
        for (const t of titles.slice(0, 10)) {
            if (!normalize(t).includes(nKo)) continue; // 한국어 제목이 함께 적힌 영상만 사용
            // "푸름과 여름(青と夏)"처럼 한국어 제목 바로 뒤 괄호 안의 일본어가 원제일 가능성이 가장 높음
            const beside = t.match(besideKo)?.[1]?.trim();
            if (beside && JP_CHARS.test(beside)) counts.set(beside, (counts.get(beside) || 0) + 3);
            for (const seg of new Set(t.match(JP_SEGMENTS) || [])) {
                if (nArtist && normalize(seg) === nArtist) continue;
                counts.set(seg, (counts.get(seg) || 0) + 1);
            }
        }
        const best = [...counts].sort((a, b) => b[1] - a[1])[0];
        if (best) console.log(`[가사 검색] 🈶 원제 확인: ${koreanTitle} → ${best[0]}`);
        return best ? best[0] : null;
    } catch (err) {
        console.error('[가사 검색] 원제 검색 오류:', err.message);
        return null;
    }
}

// 유튜브 뮤직의 영어 표기 곡 정보 (예: 멸종위기사랑 / 이찬혁 → Endangered Love / LEE CHANHYUK)
// lrclib은 Spotify/Apple Music 영어 표기 기준으로 등록된 곡이 많아 한국어 제목으로는 검색되지 않는 경우가 많음
const englishMetaCache = new Map();
async function fetchEnglishMetadata(videoId) {
    if (!videoId) return null;
    if (englishMetaCache.has(videoId)) return englishMetaCache.get(videoId);
    try {
        const { data } = await axios.post('https://music.youtube.com/youtubei/v1/next?prettyPrint=false',
            { context: { client: { clientName: 'WEB_REMIX', clientVersion: '1.20260901.01.00', hl: 'en', gl: 'US' } }, videoId },
            { headers: { 'Content-Type': 'application/json', Origin: 'https://music.youtube.com' }, timeout: 4000 });

        let renderer = null;
        (function walk(o) {
            if (renderer || !o || typeof o !== 'object') return;
            if (o.playlistPanelVideoRenderer?.videoId === videoId) { renderer = o.playlistPanelVideoRenderer; return; }
            for (const k in o) walk(o[k]);
        })(data);

        const title = renderer?.title?.runs?.map(r => r.text).join('').trim();
        // longBylineText: "LEE CHANHYUK • EROS • 2025" → 첫 항목이 가수
        const artist = (renderer?.longBylineText?.runs?.map(r => r.text).join('') || '').split(' • ')[0].trim();
        const result = title ? { title, artist } : null;
        cacheSet(englishMetaCache, videoId, result);
        return result;
    } catch (err) {
        console.error('[가사 검색] 영어 곡 정보 조회 오류:', err.message);
        return null; // 실패는 캐시하지 않음
    }
}

// lrclib에 같은 곡 이름으로 대량 등록된 엉터리 가사 (예: YOASOBI「アイドル」 영어판을 일본어로 받아 적은 가사가 20개 이상 등록되어 정상 가사가 검색 결과에서 밀려남)
// 해당 가사의 특징적인 줄로 걸러냄
const VANDALIZED_LYRIC_LINES = [
    '課す 冥土 よこす 実に上の上',
    '万事休す ウィットに富む あれマジで',
];
const isVandalizedLyrics = (lyrics) => !!lyrics && VANDALIZED_LYRIC_LINES.some(line => lyrics.includes(line));

// lrclib은 과부하(503 ServerOverloaded)나 요청 제한(429)이 수시로 발생하므로 간격을 늘려가며 최대 3번 재시도
const LRCLIB_RETRY_DELAYS = [1000, 2000, 4000];
async function searchLrclib(params) {
    for (let attempt = 0; ; attempt++) {
        try {
            const { data } = await axios.get('https://lrclib.net/api/search', { params, timeout: 5000 });
            return (data || []).filter(r => !isVandalizedLyrics(r.syncedLyrics));
        } catch (e) {
            const status = e.response?.status;
            if (attempt < LRCLIB_RETRY_DELAYS.length && (status === 503 || status === 429)) {
                await new Promise(r => setTimeout(r, LRCLIB_RETRY_DELAYS[attempt]));
                continue;
            }
            throw e;
        }
    }
}

// ─── 🚨 가사 Fetch (스마트 필터 및 커버 지원) ─────────────────
app.get('/lyrics', async (req, res) => {
    const { title = '', artist, album, videoId } = req.query;

    // 🚨 1. 가수 이름 정제: " 및 ", " & ", " feat." 등을 잘라내고 메인 가수 1명만 추출!
    let cleanArtist = artist || '';
    if (cleanArtist) {
        // 예: "지코 및 Lilas" -> "지코"
        cleanArtist = cleanArtist.split(/ 및 | & |, | feat\.? | ft\.? /i)[0].trim();
    }

    // 2. 노래 제목 정제
    // ("/"나 "-"로 무작정 자르면 "W/X/Y" → "W"처럼 곡명이 망가지므로 커버 가수 부분과 괄호만 제거)
    const original = parseOriginalSong(title);
    let cleanTitle = original.titles[0] || title.split(/[\[\(\-\/\|]/)[0].trim();
    if (!cleanTitle) cleanTitle = title.trim();

    // 원곡 정보: 제목 괄호 안의 원곡 가수/원제, 없으면 유튜브 검색으로 일본어 원제 확인
    // 제목이 한국어 번역 제목일 때만 원제 검색 (예: "BOW AND ARROW"처럼 이미 원제인 경우는 검색하지 않음)
    if (original.tracks.length === 0 && /[가-힣]/.test(cleanTitle) && original.artists.length > 0) {
        const resolved = await resolveJapaneseTitle(cleanTitle, original.artists[0]);
        if (resolved) original.tracks.push(resolved);
    }

    // expectLang: 이 검색으로 기대하는 가사 언어 (다른 언어 가사는 번역/다른 곡일 가능성이 높아 버림)
    // lrclib 검색은 느슨하게 일치하는 다른 곡도 돌려주므로, 곡명이 검색어와 실제로 일치하는 결과만 채택
    const titleMatches = (r, query) => {
        const a = normalize(r.trackName), b = normalize(query);
        return !!a && !!b && (a.includes(b) || b.includes(a));
    };

    const findBestLyrics = (data, expectLang, query) => {
        if (!data || data.length === 0) return null;
        const syncedResults = data.filter(r => r.syncedLyrics && titleMatches(r, query));
        if (syncedResults.length === 0) return null;

        if (expectLang) return syncedResults.find(r => detectTextLang(r.syncedLyrics) === expectLang) || null;

        const originalLangMatch = syncedResults.find(r => /[가-힣ぁ-んァ-ン一-龥]/.test(r.syncedLyrics));
        const cleanMatch = syncedResults.find(r =>
            !/romaji|romanized|transliteration/i.test(r.trackName) &&
            !/romaji|romanized|transliteration/i.test(r.albumName)
        );
        return originalLangMatch || cleanMatch || syncedResults[0];
    };

    // 검색 순서: 커버 가수 버전 → 원제(+원곡 가수) → 원제 단독 → 유튜브 뮤직 제목(+가수) → 제목 단독
    const queries = [];

    // 유튜브 뮤직 가수 이름은 "hebi. 헤비", "아오쿠모 린 AOKUMO RIN"처럼 표기가 섞여 있어 lrclib에서 검색되지 않으므로 표기별로 분리
    // 제목의 커버 가수 부분 (예: "アスノヨゾラ哨戒班 / Hebi. cover" → "Hebi", "… | 아라하시 타비 ARAHASHI TABI cover")
    // 유튜브 뮤직 가수 이름은 한글만 있는 경우(예: "헤비")가 있어 lrclib의 영문 표기와 맞추려면 제목 쪽 이름이 필요
    const titleCoverArtist = (title.split(/\s+[\/|｜]\s+/).slice(1).join(' ') || '')
        .replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ')
        .replace(/\b(covered\s+by|cover(ed)?|歌ってみた|official|mv|m\/v|live|ver\.?|version)\b|커버|불러보았다/gi, ' ')
        .replace(/\s+/g, ' ').trim();

    // 표기별로 분리 (lrclib은 "hebi. 헤비"처럼 섞인 이름으로는 검색되지 않음). 제목 쪽 이름을 우선
    const scriptCount = (t) => [/[가-힣]/, /[ぁ-ゟァ-ヿ一-龥]/, /[a-zA-Z]/].filter(re => re.test(t)).length;
    const coverArtists = [];
    for (const source of [titleCoverArtist, cleanArtist]) {
        for (const v of [
            source,
            (source.match(/[a-zA-Z][a-zA-Z0-9 .'&_-]*/g) || []).join(' '),
            (source.match(/[가-힣][가-힣 ]*/g) || []).join(' '),
            (source.match(/[ぁ-ゟァ-ヿ一-龥][ぁ-ゟァ-ヿ一-龥ー・ ]*/g) || []).join(' '),
        ]) {
            const name = v.replace(/[\s.]+$/, '').trim();
            if (name.length < 2 || scriptCount(name) > 1 || coverArtists.includes(name)) continue;
            coverArtists.push(name);
        }
    }
    // 한국어/일본어 표기 곡은 영어 표기(예: Endangered Love / LEE CHANHYUK)로도 검색
    const englishMeta = /[가-힣ぁ-ゟァ-ヿ一-龥]/.test(`${title} ${artist}`) ? await fetchEnglishMetadata(videoId) : null;
    // 제목이 같아도 가수만 영어 표기가 다른 경우가 있음 (예: Festa! / 아카네 리제 → Festa! / Akane Lize)
    const englishTitle = englishMeta && (normalize(englishMeta.title) !== normalize(title) || normalize(englishMeta.artist) !== normalize(artist))
        ? (parseOriginalSong(englishMeta.title).titles[0] || englishMeta.title) : null;
    const englishExpect = /[ぁ-ゟァ-ヿ]/.test(cleanTitle) ? 'ja' : null;
    if (englishTitle) {
        console.log(`[가사 검색] 🔤 영어 표기: ${englishTitle} / ${englishMeta.artist}`);
        // 영어 제목으로 찾으면 영어판 가사(예: アイドル → Idol)가 걸리므로, 원제가 일본어면 일본어 가사만 채택
        if (englishMeta.artist) queries.push([{ track_name: englishTitle, artist_name: englishMeta.artist }, englishExpect]);
    }

    // 커버 가수 본인 버전이 lrclib에 있으면 지금 재생 중인 음원과 타이밍이 정확히 일치하므로 최우선
    // (곡명만으로 검색하면 결과가 20개로 잘려 커버 버전이 빠지는 경우가 많음)
    for (const t of [...new Set([...original.tracks, ...original.titles, cleanTitle])].slice(0, 2)) {
        for (const a of coverArtists.slice(0, 3)) queries.push([{ track_name: t, artist_name: a }, null]);
    }
    // "가수 - 곡명"의 순서를 알 수 없으므로 (원제+원곡 가수) 조합을 모두 먼저 시도한 뒤 원제 단독 검색
    for (const track of original.tracks) {
        for (const a of original.artists) if (a !== track) queries.push([{ track_name: track, artist_name: a }, 'ja']);
    }
    // 제목에 원곡 가수가 적힌 경우 (예: "W/X/Y (Tani Yuuki)", "Henceforth - Orangestar")
    for (const t of original.titles) {
        for (const a of original.artists) if (a !== t) queries.push([{ track_name: t, artist_name: a }, null]);
    }
    for (const track of original.tracks) queries.push([{ track_name: track }, 'ja']);
    queries.push([{ track_name: cleanTitle, artist_name: cleanArtist }, null]);
    for (const t of original.titles) queries.push([{ track_name: t }, null]);
    queries.push([{ track_name: cleanTitle }, null]);
    if (englishTitle) queries.push([{ track_name: englishTitle }, englishExpect]);

    // 같은 곡명의 다른 가수 곡(예: ライラック / 美波)을 피하기 위해, 제목에서 알아낸 원곡 가수와 일치하는 결과를 우선
    const knownArtists = [...original.artists, ...coverArtists, englishMeta?.artist || ''].map(normalize).filter(a => a.length >= 2);
    const artistMatches = (r) => {
        const a = normalize(r.artistName);
        return !!a && knownArtists.some(k => a.includes(k) || k.includes(a));
    };

    // 가수 미확인 결과 허용 조건: 곡명이 정확히 같고, 가수 이름이 우리가 아는 가수와 다른 문자로 표기된 경우만
    // (예: 요네즈 켄시 ↔ 米津玄師, 스텔라이브 ↔ STELLIVE). 같은 문자인데 이름이 다르면 다른 가수(예: 스텔라이브 ↔ EXO는 곡명도 다름)
    const scriptsOf = (text) => {
        const set = new Set();
        if (/[가-힣]/.test(text)) set.add('ko');
        if (/[ぁ-ゟァ-ヿ一-龥]/.test(text)) set.add('ja');
        if (/[a-zA-Z]/.test(text)) set.add('latin');
        return set;
    };
    const queryTitles = new Set([...original.tracks, ...original.titles, cleanTitle, englishTitle || ''].map(normalize));
    // 커버곡: 유튜브 뮤직 가수는 커버 가수라 원곡 가수와 다른 게 당연함 (예: Beyond the way / 하나코 나나 cover → 원곡 Giga).
    //   제목에 원곡 가수도 없으면 가수 대신 곡 길이로 확인 (커버는 보통 원곡과 길이가 비슷함)
    const isCover = /cover|커버|歌ってみた/i.test(title);
    const playingSec = playerState.videoId === videoId && playerState.duration ? playerState.duration / 1000 : 0;
    const durationClose = (r) => !playingSec || !r.duration || Math.abs(r.duration - playingSec) <= 15;
    // 표기 문자 비교에 쓸 가수: 곡명으로 쓰인 후보(예: "(星座になれたら : 결속 밴드)"의 星座になれたら)는 제외하고,
    //   커버곡이면 커버 가수(유튜브 뮤직 가수)도 제외 → 원곡 가수만 남김
    const realOriginalArtists = original.artists.filter(a => !original.tracks.includes(a) && !original.titles.includes(a));
    // 커버가 아니면 유튜브 뮤직 가수와 그 영어 표기(예: 아카네 리제 / Akane Lize)도 비교 → 다른 가수의 동명곡(예: Festa / Alex Britti) 차단
    const compareArtists = isCover ? realOriginalArtists : [...realOriginalArtists, cleanArtist, englishMeta?.artist].filter(Boolean);
    const compareScripts = new Set(compareArtists.flatMap(a => [...scriptsOf(a || '')]));
    const isSafeFallback = (r) => {
        if (!queryTitles.has(normalize(r.trackName))) return false;
        if (!durationClose(r)) return false;
        // 비교할 원곡 가수가 없으면 곡명 + 길이로만 판단
        if (compareArtists.length === 0) return true;
        // 같은 가수를 다른 문자로 표기한 경우만 허용 (예: 결속 밴드 ↔ 結束バンド / Kessoku Band)
        return ![...scriptsOf(r.artistName || '')].some(sc => compareScripts.has(sc));
    };

    const MAX_LRCLIB_REQUESTS = 14;
    const tried = new Set();
    let fallbackMatch = null; // 가수가 확인되지 않은 결과 (가수 일치 결과가 끝내 없을 때만 사용)
    for (const [params, expectLang] of queries) {
        const key = JSON.stringify(params);
        if (tried.has(key)) continue;
        if (tried.size >= MAX_LRCLIB_REQUESTS) break;
        tried.add(key);
        try {
            const results = await searchLrclib(params);
            const bestMatch = findBestLyrics(results.filter(artistMatches), expectLang, params.track_name)
                || (knownArtists.length === 0 ? findBestLyrics(results, expectLang, params.track_name) : null);
            if (bestMatch) {
                console.log(`[가사 검색] 📜 lrclib 가사 사용 (${bestMatch.trackName} / ${bestMatch.artistName})`);
                return res.json({ lyrics: bestMatch.syncedLyrics, source: 'lrclib' });
            }
            // 후보가 여럿이면 재생 중인 곡과 길이가 가장 가까운 것 우선 (같은 곡의 다른 버전/커버 구분)
            const byDuration = (a, b) => playingSec ? Math.abs((a.duration || 1e9) - playingSec) - Math.abs((b.duration || 1e9) - playingSec) : 0;
            if (!fallbackMatch) fallbackMatch = findBestLyrics(results.filter(isSafeFallback).sort(byDuration), expectLang, params.track_name);
        } catch (e) {
            console.error("가사 검색 실패:", e.message);
        }
    }

    // 원곡 가수를 확인하지 못했지만 곡명이 일치하는 가사 (예: 가수 표기가 한국어/일본어로 달라 매칭 실패)
    if (fallbackMatch) {
        console.log(`[가사 검색] 📜 lrclib 가사 사용 - 가수 미확인 (${fallbackMatch.trackName} / ${fallbackMatch.artistName})`);
        return res.json({ lyrics: fallbackMatch.syncedLyrics, source: 'lrclib' });
    }

    console.log(`[가사 검색] ❌ lrclib에서 가사를 찾지 못함 (검색어: ${[...tried].map(k => Object.values(JSON.parse(k)).join(' / ')).join(' | ')})`);

    res.json({ lyrics: null, source: null });
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