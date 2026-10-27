const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8888;
const WS_PORT = 8889;

let playerState = { playing: false };
const commandClients = new Set();
let rendererSocket = null;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});
app.use(express.json());

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

app.post('/play-pause', (req, res) => {
    sendCommand('play-pause');
    res.json({ ok: true });
});

app.post('/previous', (req, res) => {
    sendCommand('previous');
    res.json({ ok: true });
});

app.post('/next', (req, res) => {
    sendCommand('next');
    res.json({ ok: true });
});

// 전체화면 소리 조절 (0~100)
app.post('/volume', (req, res) => {
    const volume = Number(req.body?.volume);
    if (Number.isFinite(volume)) sendCommand(`volume:${Math.max(0, Math.min(100, Math.round(volume)))}`);
    res.json({ ok: true });
});

// 전체화면 소리 버튼 클릭 → 음소거/해제
app.post('/mute', (req, res) => {
    sendCommand(`mute:${req.body?.muted ? 1 : 0}`);
    res.json({ ok: true });
});

// 전체화면 가사 클릭 → 해당 가사 위치로 이동 (ms)
app.post('/seek', (req, res) => {
    const ms = Number(req.body?.ms);
    if (Number.isFinite(ms) && ms >= 0) sendCommand(`seek:${Math.round(ms)}`);
    res.json({ ok: true });
});

app.post('/update-state', (req, res) => {
    playerState = req.body;
    res.json({ ok: true });
});

// 최근 조회 결과 캐시 (오래된 항목부터 삭제)
const CACHE_MAX = 50;

function cacheSet(map, key, value) {
    map.delete(key);
    map.set(key, value);
    if (map.size > CACHE_MAX) map.delete(map.keys().next().value);
}

// ─── 유튜브 자막 (lrclib에 가사가 없을 때만 사용) ──────────
// 서버가 유튜브에 직접 요청하지 않고, Tampermonkey에 요청 → 페이지의 플레이어가 자막을 불러오면 그 응답을 LRC로 변환해 보내줌
const pageCaptions = new Map();       // videoId → LRC | null(자막 없음)
const captionWaiters = new Map();     // videoId → [resolve, ...]
const CAPTION_WAIT_MS = 30000; // 재생 중인 영상 → 뮤직비디오 후보(최대 2개)를 차례로 시도하는 시간

function requestPageCaptions(videoId, langs, candidates) {
    if (pageCaptions.has(videoId)) return Promise.resolve(pageCaptions.get(videoId));
    if (commandClients.size === 0) return Promise.resolve(null); // 유튜브 뮤직 페이지가 연결되어 있지 않음
    return new Promise(resolve => {
        const waiting = captionWaiters.get(videoId);
        if (waiting) { waiting.push(resolve); return; } // 이미 요청 중이면 같은 결과를 기다림
        captionWaiters.set(videoId, [resolve]);
        sendCommand(`captions:${JSON.stringify({ videoId, langs, candidates })}`);
        setTimeout(() => resolveCaptionWaiters(videoId, null), CAPTION_WAIT_MS); // 응답이 없어도 '자막 없음'으로 확정하지 않음
    });
}

function resolveCaptionWaiters(videoId, lyrics) {
    const waiting = captionWaiters.get(videoId);
    if (!waiting) return;
    captionWaiters.delete(videoId);
    waiting.forEach(resolve => resolve(lyrics));
}

app.post('/yt-captions', (req, res) => {
    const { videoId, lyrics, lang, from } = req.body || {};
    if (videoId) {
        cacheSet(pageCaptions, videoId, lyrics || null);
        console.log(lyrics ? `[가사 검색] 🎈 유튜브 자막 추출 성공 (Video ID: ${videoId}${from ? ` → 뮤직비디오 ${from}` : ''}, 자막: ${lang})` : `[가사 검색] 🎈 유튜브 자막 없음 (Video ID: ${videoId})`);
        resolveCaptionWaiters(videoId, lyrics || null);
    }
    res.json({ ok: true });
});

app.get('/current-track', (req, res) => {
    res.json(playerState);
});

// 텍스트에서 가장 많이 쓰인 문자 체계로 언어 추정 (영문은 글자 단위라 음절 문자와 비슷한 비중이 되도록 보정)
function detectTextLang(text) {
    const count = (re) => (text.match(re) || []).length;
    const kana = count(/[ぁ-ゟァ-ヿ]/g), kanji = count(/[一-龥]/g);
    const scores = {
        ko: count(/[가-힣]/g),
        // 가나 없이 한자만 있으면 중국어 (일본어 가사에는 거의 항상 가나가 섞임. 예: 중국어 가사를 일본어로 잘못 판단하던 문제)
        ja: kana > 0 ? kana + kanji * 0.5 : 0,
        zh: kana > 0 ? 0 : kanji,
        en: count(/[a-zA-Z]/g) / 4,
    };
    const [lang, score] = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return score > 0 ? lang : null;
}

const normalize = (s) => (s || '').toLowerCase().replace(/[\s'"`‘’“”「」『』【】\[\]()（）|·・\-_:~!?.,、。！？〜～…★☆♪♡]/g, '');

// 같은 곡의 뮤직비디오 찾기 (유튜브 검색 결과 중 곡명이 들어간 영상, 아티스트 공식 채널 우선)
const MV_EXCLUDE_KEYWORDS = /노래방|karaoke|커버|cover|inst\b|instrumental|reaction|리액션|piano|guitar|bass|drum|vietsub|싱크룸|직캠|fancam|teaser|티저|1시간|1hour|playlist|shorts/i;
async function findMusicVideoIds(title, artist, excludeId) {
    try {
        const { data } = await axios.post('https://www.youtube.com/youtubei/v1/search?prettyPrint=false',
            { context: { client: { clientName: 'WEB', clientVersion: '2.20260901.00.00', hl: 'ko', gl: 'KR' } }, query: `${title} ${artist}`.trim() },
            { headers: { 'Content-Type': 'application/json' }, timeout: 5000 });

        const videos = [];
        (function walk(o) {
            if (!o || typeof o !== 'object') return;
            if (o.videoRenderer) {
                const v = o.videoRenderer;
                videos.push({ id: v.videoId, title: v.title?.runs?.map(r => r.text).join('') || '', owner: v.ownerText?.runs?.map(r => r.text).join('') || '' });
                return;
            }
            for (const k in o) walk(o[k]);
        })(data);

        const nTitle = normalize(title);
        const nArtist = normalize(artist);
        return videos
            .slice(0, 8)
            .filter(v => v.id !== excludeId && normalize(v.title).includes(nTitle))
            // 원곡 제목에 없는 커버/노래방/연주/티저 등의 키워드가 붙은 영상은 제외
            .filter(v => !MV_EXCLUDE_KEYWORDS.test(v.title) || MV_EXCLUDE_KEYWORDS.test(title))
            .sort((a, b) => Number(normalize(b.owner + b.title).includes(nArtist)) - Number(normalize(a.owner + a.title).includes(nArtist)))
            .slice(0, 2)
            .map(v => v.id);
    } catch (err) {
        console.error('[가사 검색] 뮤직비디오 검색 오류:', err.message);
        return [];
    }
}

// ─── 원곡 정보 추출 (커버 영상 제목 → 원곡 가수 / 원제) ─────────
const JP_CHARS = /[ぁ-ゟァ-ヿ一-龥]/;
const JP_SEGMENTS = /[ぁ-ゟァ-ヿ一-龥々〆ー・·]+/g;
const NON_SONG_GROUP = /cover|커버|ver\.?|version|official|m\/?v|live|라이브|full|short|가사|lyrics|자막|^\s*(4k|8k|hd|fhd|uhd|hq|1080p|4k\s*60fps)\s*$/i;

// 예) "물떼새[ヨルシカ - 千鳥] | 아라하시 타비 cover"        → 후보: 千鳥 / ヨルシカ
//     "푸름과 여름 (Mrs. GREEN APPLE) / 텐코 시부키 cover"     → 가수: Mrs. GREEN APPLE (원제는 검색으로 확인)
//     "아이네 클라이네 (アイネクライネ : 요네즈 켄시) / ..."     → 후보: アイネクライネ / 요네즈 켄시
//     "아 프리오리 (Mrs. GREEN APPLE「ア·プリオリ」) / ..."   → 후보: ア·プリオリ / Mrs. GREEN APPLE
// 곡 정보와 커버 가수 사이의 구분선: " / ", " | ", "｜", "ㅣ" (ㅣ는 앞뒤 공백 없이 쓰이기도 함)
// 괄호 밖의 구분선에서만 나눔 (예: "orion - [米津玄師 / 요네즈 켄시] ㅣ아카네 리제"의 괄호 안 " / "는 구분선이 아님)
function splitTitleParts(title) {
    const masked = title.replace(/[\[(（【][^\])）】]*[\])）】]/g, m => '\0'.repeat(m.length));
    const parts = [];
    let start = 0;
    for (const m of masked.matchAll(/\s+[\/|｜]\s+|\s*ㅣ\s*/g)) {
        parts.push(title.slice(start, m.index));
        start = m.index + m[0].length;
    }
    parts.push(title.slice(start));
    return parts;
}

// 따옴표로 감싼 곡명 (앞뒤가 공백/구분선이어야 함 → "Don't"의 ' 같은 문자는 제외)
const QUOTED_TITLE = /(?:^|[\s|ㅣ｜/])[‘'"“]([^’'"”]{1,60})[’'"”](?=$|[\s|ㅣ｜/,])/;
const NON_SONG_WORDS = /\b(music video|official|m\/?v|lyric video|live)\b/gi;

function parseOriginalSong(title) {
    const tracks = [], artists = [], titles = [];
    const artistOnly = new Set(); // 가수 이름으로 확정된 값 (곡명 후보에서 제외)
    const add = (list, v) => { v = (v || '').trim(); if (v && !list.includes(v)) list.push(v); };

    // "가수 | '곡명'" 형태 (예: "네네코 마시로(Neneko Mashiro) | ‘봄꿈’", "TAEYEON (태연) 'To. X' / … Cover")
    //   → 따옴표 안이 곡명, 같은 부분의 나머지(괄호 안 포함)는 가수 후보 (원곡 가수이거나 본인)
    const quotedTitle = title.match(QUOTED_TITLE);
    if (quotedTitle) {
        const part = splitTitleParts(title).find(p => p.includes(quotedTitle[0])) || title;
        const rest = part.replace(quotedTitle[0], ' ').replace(NON_SONG_WORDS, ' ');
        for (const name of rest.split(/[\[(（【\])）】]|\s+[xX×]\s+/)) {
            const n = name.replace(/\s+/g, ' ').trim();
            if (n.length >= 2 && !/^(cover|커버)$/i.test(n)) add(artists, n);
        }
    }

    // "곡 정보 / 커버 가수" 형태이므로 커버 가수 부분(/, | 뒤)은 제외
    // "ㅣ"(한글 모음)를 구분선으로 쓰는 경우도 있음 (예: "orion - [米津玄師] ㅣ아카네 리제 【COVER】")
    const songPart = quotedTitle ? quotedTitle[1].trim() : splitTitleParts(title)[0];
    const groups = [...songPart.matchAll(/[\[(（【]([^\])）】]+)[\])）】]/g)].map(m => m[1].trim());
    for (const g of groups) {
        if (NON_SONG_GROUP.test(g) && !JP_CHARS.test(g)) continue;

        const quoted = g.match(/[「『"](.+?)[」』"]/);
        if (quoted) {
            add(tracks, quoted[1]);
            add(artists, g.replace(quoted[0], ''));
            continue;
        }
        // "[米津玄師 / 요네즈 켄시]"처럼 같은 가수를 표기만 달리해 나열한 경우 → 가수만
        const names = g.split(/\s+[\/／]\s+/).map(s => s.trim()).filter(Boolean);
        if (names.length >= 2 && !/\s[-–]\s|[:：]/.test(g)) {
            names.forEach(n => { add(artists, n); artistOnly.add(n); });
            continue;
        }
        // "가수 - 곡명" / "곡명 : 가수" 등 순서가 제각각이므로 양쪽 모두 후보로 사용
        const parts = g.split(/\s+[-–]\s+|\s*[:：]\s*/).map(s => s.trim()).filter(Boolean);
        if (parts.length === 2) {
            parts.forEach(p => { add(tracks, p); add(artists, p); });
        } else {
            // 일본어가 들어간 괄호는 원제일 가능성이 높으므로 통째로 원제 후보에도 넣음 (예: "앨리스 인 냉동고 (Alice in 冷凍庫)")
            if (JP_CHARS.test(g)) add(tracks, g);
            add(artists, g);
        }
    }

    // 괄호 밖의 "곡명 - 가수" (예: "라일락[ライラック] - Mrs. GREEN APPLE")
    const outside = songPart.replace(/[\[(（【][^\])）】]*[\])）】]/g, ' ').replace(/\s+/g, ' ')
        .replace(/^[\s\-–~:]+|[\s\-–~:]+$/g, '').trim(); // 괄호를 빼고 남은 "orion -"의 "-" 제거
    const outsideParts = outside.split(/\s+[-–]\s+/).map(s => s.trim()).filter(Boolean);
    if (outsideParts.length === 2) outsideParts.forEach(p => add(artists, p));
    // 괄호를 뺀 곡명 후보 (예: "W/X/Y", "Henceforth - Orangestar" → Henceforth / Orangestar, "푸름과 여름")
    // 한글/일본어가 들어간 쪽을 대표 곡명으로 우선 (예: "Mrs. GREEN APPLE - 춘수" → 춘수)
    outsideParts.length === 2
        ? [...outsideParts].sort((a, b) => Number(/[가-힣ぁ-ゟァ-ヿ一-龥]/.test(b)) - Number(/[가-힣ぁ-ゟァ-ヿ一-龥]/.test(a))).forEach(p => add(titles, p))
        : add(titles, outside);

    // 괄호 밖에 있는 일본어 원제도 후보로 추가
    for (const seg of songPart.match(JP_SEGMENTS) || []) add(tracks, seg);

    // 다른 후보에 포함된 조각은 뺌 (예: "Alice in 冷凍庫"가 있으면 "冷凍庫"는 제외)
    const finalTracks = tracks.filter(t => JP_CHARS.test(t) && !artistOnly.has(t) && !tracks.some(o => o !== t && o.includes(t)));
    return { tracks: finalTracks, artists, titles: titles.filter(t => !finalTracks.includes(t)) };
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

// ─── 추가 가사 제공처 (lrclib에 가사가 없을 때) ──────────────
// Syncanto(MIT, vendor/syncanto)의 제공처 코드 사용. 원본의 getLyrics()는 첫 검색 결과를 그대로 쓰므로,
// search() 결과를 lrclib과 같은 기준(가수/곡명/길이)으로 검증한 뒤 getById()로 가사를 가져옴
const { MusixmatchProvider } = require('./vendor/syncanto/providers/musixmatch');
const { AppleMusicProvider } = require('./vendor/syncanto/providers/applemusic');
const { NetEaseProvider } = require('./vendor/syncanto/providers/netease');
const { QQMusicProvider } = require('./vendor/syncanto/providers/qqmusic');
const { KugouProvider } = require('./vendor/syncanto/providers/kugou');
require('./vendor/syncanto/utils/http').log = () => { }; // 라이브러리 내부 디버그 로그 끔

// 우선순위 순서. Spotify 가사는 Musixmatch가 제공하므로 Spotify 자리에는 Musixmatch를 사용
// (YouTube Music 가사는 싱크 없는 일반 가사이고 로그인이 필요해 제외)
const EXTRA_PROVIDERS = [
    { label: 'Spotify(Musixmatch)', provider: new MusixmatchProvider() },
    { label: 'Apple Music', provider: new AppleMusicProvider() },
    { label: 'NetEase', provider: new NetEaseProvider() },
    { label: 'QQ Music', provider: new QQMusicProvider() },
    { label: 'KuGou', provider: new KugouProvider() },
];
const EXTRA_REQUEST_TIMEOUT_MS = 8000;    // 요청 1번
const EXTRA_PROVIDER_BUDGET_MS = 15000;   // 제공처 하나 전체 (모든 제공처를 동시에 검색하므로 최대 대기 시간도 이 정도)

const withTimeout = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);

const LRC_TIMED_LINE = /^\s*\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]\s*\S/;
// 가사 앞에 붙는 제작 정보 줄 (예: NetEase "作词 : 大森元貴", "作曲 : …")
const CREDIT_LINE = /^(作词|作詞|作曲|编曲|編曲|制作人|製作|制作团队|监制|混音|混缩|母带|和声|录音|吉他|贝斯|鼓|弦乐|出品|出品人|发行|演唱|原唱|翻唱|策划|后期|曲绘|词|曲|vocals?|lyrics?|lyricist|composer|composed by|arranged by|arranger|producer|written by)\s*(by)?\s*[:：]/i;

// 한자로 된 짧은 항목명 + 콜론 (예: "混音/母带：LL", "和声编写：…") — 일본어 가사는 가나가 섞이므로 해당 없음
const CREDIT_LINE_ZH = /^[一-龥\s/&·、]{1,10}[:：]/;

// 제작 정보 줄과 맨 앞의 "곡명 - 가수" 줄(예: QQ "[00:00.23]ライラック - Mrs. GREEN APPLE")을 빼고 정리
function cleanProviderLyrics(lrc, trackName, artistName) {
    const nTitle = normalize(trackName), nArtist = normalize(artistName);
    return lrc.split('\n').filter(line => {
        const text = line.replace(/\[[^\]]*\]/g, '').trim();
        if (!text) return true;
        if (CREDIT_LINE.test(text) || CREDIT_LINE_ZH.test(text)) return false;
        const n = normalize(text);
        if (nTitle && nArtist && n.includes(nTitle) && n.includes(nArtist)) return false;
        // 맨 앞의 "곡명 - 원작자" 줄 (예: "サクラキミワタシ - tuki.")
        return !(nTitle && n.startsWith(nTitle) && /\s[-–]\s/.test(text));
    }).join('\n');
}

// 제공처 하나에서 검색 → 검증(accept) 통과한 결과 중 길이가 가까운 순으로 싱크 가사를 찾음
async function searchExtraProvider({ provider }, queries, accept, byDuration, expectLang, verifyLyrics) {
    for (const query of queries) {
        const results = (await withTimeout(provider.search(query).catch(() => []), EXTRA_REQUEST_TIMEOUT_MS)) || [];
        const candidates = results
            // 제공처마다 길이 단위가 다름 (NetEase는 ms, 나머지는 초)
            .map(r => ({ ...r, trackName: r.name, artistName: r.artist, duration: r.duration > 10000 ? r.duration / 1000 : r.duration }))
            .filter(accept)
            .sort(byDuration)
            .slice(0, 2);
        for (const c of candidates) {
            const track = await withTimeout(provider.getById(c.trackId).catch(() => null), EXTRA_REQUEST_TIMEOUT_MS);
            if (!track?.synced) continue;
            const lyrics = cleanProviderLyrics(track.synced, c.name, c.artist);
            if (lyrics.split('\n').filter(l => LRC_TIMED_LINE.test(l)).length < 3) continue; // 싱크 줄이 거의 없으면 제외
            if (isVandalizedLyrics(lyrics)) continue;
            if (expectLang && detectTextLang(lyrics) !== expectLang) continue;
            if (verifyLyrics && !verifyLyrics(c, lyrics)) continue;
            return { lyrics, match: c };
        }
    }
    return null;
}

// ─── 🚨 가사 Fetch (스마트 필터 및 커버 지원) ─────────────────
app.get('/lyrics', async (req, res) => {
    const { title = '', artist, album, videoId } = req.query;

    // 🚨 1. 가수 이름 정제: " 및 ", " & ", " feat." 등을 잘라내고 메인 가수 1명만 추출!
    let cleanArtist = artist || '';
    if (cleanArtist) {
        // 예: "지코 및 Lilas" -> "지코"
        // 자동 생성 아티스트 채널의 " - Topic" 제거 (예: "K/DA - Topic" → "K/DA")
        cleanArtist = cleanArtist.replace(/\s+-\s+Topic$/i, '');
        cleanArtist = cleanArtist.split(/ 및 | & |, | feat\.? | ft\.? /i)[0].trim();
    }

    // 2. 노래 제목 정제
    // ("/"나 "-"로 무작정 자르면 "W/X/Y" → "W"처럼 곡명이 망가지므로 커버 가수 부분과 괄호만 제거)
    const original = parseOriginalSong(title);
    let cleanTitle = original.titles[0] || original.tracks[0] || title.split(/[\[\(\-\/\|]/)[0].trim();
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
    // 따옴표 곡명은 커버 가수 이름이 아님 (예: "아카네 리제(Akane Lize)ㅣ'Stranger'"의 Stranger)
    const titleCoverArtist = (splitTitleParts(title.replace(QUOTED_TITLE, ' ')).slice(1).join(' ') || '')
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
    // 곡명에 가나가 있으면 일본어 가사만 채택 (로마자 표기 가사 제외. 예: 怪獣の花唄 → "Omoidasu no wa kimi no uta")
    const titleExpect = englishExpect;
    if (englishTitle) {
        console.log(`[가사 검색] 🔤 영어 표기: ${englishTitle} / ${englishMeta.artist}`);
        // 영어 제목으로 찾으면 영어판 가사(예: アイドル → Idol)가 걸리므로, 원제가 일본어면 일본어 가사만 채택
        if (englishMeta.artist) queries.push([{ track_name: englishTitle, artist_name: englishMeta.artist }, englishExpect]);
    }

    // 커버 가수 본인 버전이 lrclib에 있으면 지금 재생 중인 음원과 타이밍이 정확히 일치하므로 최우선
    // (곡명만으로 검색하면 결과가 20개로 잘려 커버 버전이 빠지는 경우가 많음)
    for (const t of [...new Set([...original.tracks, ...original.titles, cleanTitle])].slice(0, 2)) {
        for (const a of coverArtists.slice(0, 3)) queries.push([{ track_name: t, artist_name: a }, titleExpect]);
    }
    // "가수 - 곡명"의 순서를 알 수 없으므로 (원제+원곡 가수) 조합을 모두 먼저 시도한 뒤 원제 단독 검색
    for (const track of original.tracks) {
        for (const a of original.artists) if (a !== track) queries.push([{ track_name: track, artist_name: a }, 'ja']);
    }
    // 제목에 원곡 가수가 적힌 경우 (예: "W/X/Y (Tani Yuuki)", "Henceforth - Orangestar")
    for (const t of original.titles) {
        for (const a of original.artists) if (a !== t) queries.push([{ track_name: t, artist_name: a }, titleExpect]);
    }
    for (const track of original.tracks) queries.push([{ track_name: track }, 'ja']);
    queries.push([{ track_name: cleanTitle, artist_name: cleanArtist }, titleExpect]);
    for (const t of original.titles) queries.push([{ track_name: t }, titleExpect]);
    queries.push([{ track_name: cleanTitle }, titleExpect]);
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
    // 제목 앞 【아야츠노 유니】처럼 괄호 안에 커버 가수 본인 이름이 적힌 경우는 원곡 가수가 아니므로 제외
    const performerNames = [cleanArtist, artist || '', ...coverArtists].map(normalize).filter(n => n.length >= 2);
    const isPerformer = (a) => { const n = normalize(a); return !!n && performerNames.some(p => p.includes(n) || n.includes(p)); };
    const originalArtistScripts = [...new Set(realOriginalArtists.filter(a => !isPerformer(a)).flatMap(a => [...scriptsOf(a)]))].filter(sc => sc !== 'latin');
    const lyricsMatchOriginalArtistScript = (lyrics) =>
        originalArtistScripts.length === 0 || [...scriptsOf(lyrics)].some(sc => originalArtistScripts.includes(sc));
    const isSafeFallback = (r) => {
        if (!queryTitles.has(normalize(r.trackName))) return false;
        if (!durationClose(r)) return false;
        // 비교할 원곡 가수가 없으면 곡명 + 길이로만 판단
        if (compareArtists.length === 0) return true;
        // 같은 가수를 다른 문자로 표기한 경우만 허용 (예: 결속 밴드 ↔ 結束バンド / Kessoku Band)
        if ([...scriptsOf(r.artistName || '')].some(sc => compareScripts.has(sc))) return false;
        // 제목에 적힌 원곡 가수 이름이 한글/일본어면 가사에도 그 문자가 있어야 같은 곡으로 봄
        //   (예: BE SOMEBODY (육성재) cover ↔ "Be Somebody / slimdan"은 가수 이름 문자만 달라 통과했지만 가사가 전부 영어)
        //   유튜브 뮤직 가수(커버 가수일 수 있음)는 기준에서 제외 (예: 怪獣の花唄 / 아이리 칸나 → 일본어 원곡 가사가 맞음)
        if (r.syncedLyrics && !lyricsMatchOriginalArtistScript(r.syncedLyrics)) return false;
        return true;
    };

    const MAX_LRCLIB_REQUESTS = 14;
    const tried = new Set();
    let fallbackMatch = null; // 가수가 확인되지 않은 결과 (가수 일치 결과가 끝내 없을 때만 사용)
    let searchFailed = false; // lrclib 과부하(503) 등으로 검색 하나라도 실패했는지
    let lengthMismatch = null; // 가수는 맞지만 길이가 크게 다른 결과 (예: 티저/짧은 버전. 끝내 다른 결과가 없을 때만 사용)
    // 후보가 여럿이면 재생 중인 곡과 길이가 가장 가까운 것 우선 (같은 곡의 다른 버전/커버/티저 구분)
    const exactTitlePool = [];
    const byDuration = (a, b) => playingSec ? Math.abs((a.duration || 1e9) - playingSec) - Math.abs((b.duration || 1e9) - playingSec) : 0;
    for (const [params, expectLang] of queries) {
        const key = JSON.stringify(params);
        if (tried.has(key)) continue;
        if (tried.size >= MAX_LRCLIB_REQUESTS) break;
        tried.add(key);
        try {
            const results = await searchLrclib(params);
            // 원제 단독 검색 결과는 '원곡 가수 다수결' 마지막 수단용으로 모아 둠
            if (!params.artist_name && original.tracks.includes(params.track_name)) exactTitlePool.push(...results);
            const candidates = (knownArtists.length > 0 ? results.filter(artistMatches) : results).sort(byDuration);
            const bestMatch = findBestLyrics(candidates.filter(durationClose), expectLang, params.track_name);
            if (bestMatch) {
                console.log(`[가사 검색] 📜 lrclib 가사 사용 (${bestMatch.trackName} / ${bestMatch.artistName})`);
                return res.json({ lyrics: bestMatch.syncedLyrics, source: 'lrclib' });
            }
            if (!lengthMismatch) lengthMismatch = findBestLyrics(candidates, expectLang, params.track_name);
            if (!fallbackMatch) fallbackMatch = findBestLyrics(results.filter(isSafeFallback).sort(byDuration), expectLang, params.track_name);
        } catch (e) {
            searchFailed = true;
            console.error("가사 검색 실패:", e.message);
        }
    }

    // [2순위] 추가 가사 제공처: Spotify(Musixmatch) → Apple Music → NetEase → QQ Music → KuGou
    //   모두 동시에 검색하고, 찾은 것 중 우선순위가 가장 높은 제공처의 가사를 사용
    {
        const extraQueries = [...new Set([
            original.tracks[0] ? `${original.tracks[0]} ${realOriginalArtists[0] || ''}`.trim() : null, // 커버곡: 일본어 원제 + 원곡 가수
            // 제목 괄호 안의 원곡 가수 (예: "BE SOMEBODY (육성재) / 아라하시 타비 Cover" → "BE SOMEBODY 육성재")
            realOriginalArtists[0] ? `${cleanTitle} ${realOriginalArtists[0]}` : null,
            `${cleanTitle} ${cleanArtist}`.trim(),
            englishTitle && englishMeta?.artist ? `${englishTitle} ${englishMeta.artist}` : null,
        ].filter(Boolean))].slice(0, 2);
        const queryTitleScripts = new Set([cleanTitle, ...original.tracks, ...original.titles, englishTitle || ''].flatMap(t => [...scriptsOf(t)]));
        // 반주/노래방/짧은 버전/라이브 버전 (라이브는 가사 타이밍이 음원과 다름)
        const VERSION_WORDS = /instrumental|\binst\b|karaoke|カラオケ|off vocal|伴奏|剪辑|anime size|\blive\b|라이브|现场/i;
        const extraAccept = (r) => {
            const nName = normalize(r.trackName);
            if (!nName) return false;
            // 반주/노래방/짧은 버전은 지금 듣는 곡도 그 버전일 때만
            if (VERSION_WORDS.test(r.trackName) && !VERSION_WORDS.test(title)) return false;
            if (!durationClose(r)) return false;
            const titleOk = [...queryTitles].some(q => q && (nName.includes(q) || q.includes(nName)));
            // 곡명이 언어만 다른 경우(예: ライラック ↔ Lilac): 가수가 같고 길이가 3초 이내로 거의 같으며,
            // 곡명이 검색한 어떤 제목과도 다른 문자(한글/일본어/영문)로 쓰였을 때만 같은 곡으로 봄
            // (같은 문자인데 곡명이 다르면 같은 가수의 다른 곡. 예: 맨드라미 ↔ 한참 외로워 하던 사람은 결국 고양이가 되어서)
            const sameLength = playingSec && r.duration && Math.abs(r.duration - playingSec) <= 3;
            // 한자만으로 된 제목은 중국어 제목일 수 있어 제외 (예: To. X ↔ 噩梦 같은 가수의 다른 곡)
            const otherScript = /[ぁ-ゟァ-ヿ가-힣a-zA-Z]/.test(r.trackName) && ![...scriptsOf(r.trackName)].some(sc => queryTitleScripts.has(sc));
            if (artistMatches(r) && (titleOk || (sameLength && otherScript))) return true;
            // 가수를 확인하지 못한 결과는 곡 길이로라도 확인돼야 함 (QQ Music 등은 길이 정보가 없어
            // 길이 검사가 그냥 통과됨 → 같은 제목의 다른 사람 커버가 붙음. 예: Alice in 冷凍庫 / めありー)
            if (!r.duration || !isSafeFallback(r)) return false;
            r.unverifiedArtist = true; // 가사를 받은 뒤 가사 문자로 한 번 더 확인 (searchExtraProvider)
            return true;
        };
        // 가수를 확인하지 못한 결과: 원곡 가수 이름이 한글/일본어면 가사에도 그 문자가 있어야 함 (isSafeFallback과 같은 기준)
        const verifyExtraLyrics = (c, lyrics) => {
            return !c.unverifiedArtist || lyricsMatchOriginalArtistScript(lyrics);
        };
        const extraExpect = (original.tracks.length > 0 || /[ぁ-ゟァ-ヿ]/.test(cleanTitle)) ? 'ja' : null;
        const found = await Promise.all(EXTRA_PROVIDERS.map(p =>
            withTimeout(searchExtraProvider(p, extraQueries, extraAccept, byDuration, extraExpect, verifyExtraLyrics).catch(() => null), EXTRA_PROVIDER_BUDGET_MS)));
        const bestIdx = found.findIndex(Boolean);
        if (bestIdx >= 0) {
            const { lyrics, match } = found[bestIdx];
            console.log(`[가사 검색] 🧩 ${EXTRA_PROVIDERS[bestIdx].label} 가사 사용 (${match.name} / ${match.artist})`);
            return res.json({ lyrics, source: EXTRA_PROVIDERS[bestIdx].label });
        }
        console.log(`[가사 검색] 🧩 추가 제공처에도 가사 없음 (검색어: ${extraQueries.join(' | ')})`);
    }

    // 원곡 가수를 확인하지 못했지만 곡명이 일치하는 가사 (예: 가수 표기가 한국어/일본어로 달라 매칭 실패)
    // 검색 실패가 있었으면 정확한 결과를 놓쳤을 수 있으므로 불확실한 결과(가수 미확인/길이 다름)나 자막으로 확정하지 않고
    // 위젯이 잠시 뒤 다시 요청하게 함 (예: "orion / 米津玄師" 검색이 503 → 같은 이름의 다른 가수 곡 "Orion / Glenn Hughes"가 선택됨)
    if (searchFailed && (fallbackMatch || lengthMismatch)) {
        console.log('[가사 검색] ⏳ lrclib 검색 일부 실패 → 불확실한 결과는 보류하고 다시 시도');
        return res.json({ lyrics: null, source: null, retry: true });
    }

    if (fallbackMatch) {
        console.log(`[가사 검색] 📜 lrclib 가사 사용 - 가수 미확인 (${fallbackMatch.trackName} / ${fallbackMatch.artistName})`);
        return res.json({ lyrics: fallbackMatch.syncedLyrics, source: 'lrclib' });
    }
    if (lengthMismatch) {
        console.log(`[가사 검색] 📜 lrclib 가사 사용 - 곡 길이 다름 (${lengthMismatch.trackName} / ${lengthMismatch.artistName}, ${lengthMismatch.duration}s)`);
        return res.json({ lyrics: lengthMismatch.syncedLyrics, source: 'lrclib' });
    }

    console.log(`[가사 검색] ❌ lrclib에서 가사를 찾지 못함 (검색어: ${[...tried].map(k => Object.values(JSON.parse(k)).join(' / ')).join(' | ')})`);

    // [마지막] 유튜브 자막: 지금 재생 중인 영상만 가능 (페이지의 플레이어가 자막을 불러와야 하므로)
    //   자막 언어는 제목 → 가수 이름의 언어 순으로 우선 (예: 제목이 일본어면 일본어 자막)
    if (videoId && playerState.videoId === videoId) {
        const langs = [...new Set([detectTextLang(title), detectTextLang(cleanArtist)].filter(Boolean))];
        // 공식 음원(자동 생성 음원 영상)은 자막이 없는 경우가 많으므로 같은 곡의 뮤직비디오도 후보로 전달
        const candidates = pageCaptions.has(videoId) ? [] : await findMusicVideoIds(cleanTitle, cleanArtist, videoId);
        const lyrics = await requestPageCaptions(videoId, langs, candidates);
        if (lyrics) return res.json({ lyrics, source: 'youtube' });
    }

    // [최후] 원곡 가수 다수결: 제목에 원곡 가수가 없고 커버라서 길이도 다른 경우 (예: "Alice in 冷凍庫" 라이브 커버 273초 ↔ 원곡 342초)
    //   원제로만 검색한 결과 중 곡명이 정확히 같은 싱크 가사가 2개 이상이고, 그 절반 이상이 같은 가수면 그 가수의 원곡으로 봄
    //   (커버는 전주 길이 등이 달라 싱크가 어긋날 수 있음 → ↑/↓ 키로 조절)
    {
        const sameTitle = exactTitlePool.filter(r => r.syncedLyrics && original.tracks.some(t => normalize(t) === normalize(r.trackName))
            && (!titleExpect || detectTextLang(r.syncedLyrics) === titleExpect)); // 일본어 제목이면 일본어 가사만 (로마자 표기 제외)
        // 가수 칸의 이름들 (예: "めありー/Orangestar", "Orangestar feat.IA" → 각각의 이름)
        const artistNames = (r) => [...new Set((r.artistName || '').split(/\s*[\/&,、]\s*|\s*\b(?:feat|ft)\.?\s*/i).map(normalize).filter(Boolean))];
        // 결과마다 등장한 이름을 세어 가장 많이 나온 이름을 원곡 가수로 봄
        const counts = new Map();
        for (const r of sameTitle) for (const n of artistNames(r)) counts.set(n, (counts.get(n) || 0) + 1);
        const [topArtist, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
        if (topArtist && sameTitle.length >= 2 && topCount * 2 >= sameTitle.length) {
            // 그 가수가 첫 번째 이름인 결과(원곡) 우선, 그다음 재생 중인 곡과 길이가 가까운 순
            const pick = sameTitle.filter(r => artistNames(r).includes(topArtist))
                .sort((a, b) => (artistNames(b)[0] === topArtist) - (artistNames(a)[0] === topArtist) || byDuration(a, b))[0];
            console.log(`[가사 검색] 📜 lrclib 가사 사용 - 원곡 가수 추정(${topCount}/${sameTitle.length}건) (${pick.trackName} / ${pick.artistName}, ${pick.duration}s)`);
            return res.json({ lyrics: pick.syncedLyrics, source: 'lrclib' });
        }
    }

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
                rendererSocket.send(JSON.stringify(data));
            }
        } catch (e) { }
    });
    ws.on('close', () => { if (rendererSocket === ws) rendererSocket = null; });
});

app.listen(PORT, '127.0.0.1', () => {
    console.log(`[HTTP] 통합 서버 실행 중: http://127.0.0.1:${PORT}`);
    console.log(`[ WS ] WebSocket 실행 중: ws://127.0.0.1:${WS_PORT}`);
});