"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MusixmatchProvider = void 0;
const http_1 = require("../utils/http");
const APP_ID = 'web-desktop-app-v1.0';
const ROOT = 'https://apic-desktop.musixmatch.com/ws/1.1';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_COOKIE = 'AWSELB=unknown; x-mxm-user-id=undefined; x-mxm-token-guid=undefined; mxm-encrypted-token=';
class MusixmatchProvider {
    constructor() {
        this.name = 'Musixmatch';
        this.token = null;
        this.tokenExpiry = 0;
        this.cookies = new Map();
        this.secret = null;
        this.secretTried = false;
    }
    async setup() {
        return true;
    }
    parseCookies(header) {
        if (!header)
            return;
        const list = Array.isArray(header)
            ? header.filter((h) => typeof h === 'string')
            : header.split(/,(?=[^;]+=)/);
        for (const part of list) {
            const segment = part.split(';')[0];
            if (!segment)
                continue;
            const eq = segment.indexOf('=');
            if (eq > 0) {
                const key = segment.slice(0, eq).trim();
                const value = segment.slice(eq + 1).trim();
                if (key)
                    this.cookies.set(key, value);
            }
        }
    }
    getCookieHeader() {
        if (!this.cookies.size)
            return DEFAULT_COOKIE;
        return Array.from(this.cookies, ([k, v]) => `${k}=${v}`).join('; ');
    }
    async fetchSecret() {
        if (this.secret)
            return this.secret;
        if (this.secretTried)
            return '';
        this.secretTried = true;
        const r = await (0, http_1.makeRequest)('https://www.musixmatch.com/search', {
            headers: {
                'User-Agent': DEFAULT_UA,
                Cookie: 'mxm_bab=AB',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        if (!r.body)
            return '';
        const html = String(r.body);
        const match = html.match(/src="([^"]*\/static\/chunks\/[^"]*_app[^"]*\.js)"/);
        if (!match)
            return '';
        let url = match[1] || '';
        if (!url.startsWith('http')) {
            url = url.startsWith('//') ? `https:${url}` : `https://www.musixmatch.com${url}`;
        }
        const js = await (0, http_1.makeRequest)(url, { headers: { 'User-Agent': DEFAULT_UA } });
        if (!js.body)
            return '';
        const text = String(js.body);
        const encoded = text.match(/from\(['"]([A-Za-z0-9+/=]+)['"]\)\s*\.split/);
        if (!encoded)
            return '';
        try {
            const reversed = (encoded[1] || '').split('').reverse().join('');
            this.secret = Buffer.from(reversed, 'base64').toString('utf-8');
            return this.secret;
        }
        catch {
            return '';
        }
    }
    signUrl(url, secret) {
        const dt = new Date();
        const date = `${dt.getUTCFullYear()}${String(dt.getUTCMonth() + 1).padStart(2, '0')}${String(dt.getUTCDate()).padStart(2, '0')}`;
        const { createHmac } = require('node:crypto');
        const sig = createHmac('sha256', secret).update(`${url}${date}`).digest('base64');
        return `${url}&signature=${encodeURIComponent(sig)}&signature_protocol=sha256`;
    }
    async ensureToken(force = false) {
        const now = Date.now();
        if (!force && this.token && now < this.tokenExpiry)
            return this.token;
        const r = await (0, http_1.makeRequest)(`${ROOT}/token.get?app_id=${APP_ID}`, {
            headers: {
                'User-Agent': DEFAULT_UA,
                Accept: 'application/json,text/plain,*/*',
                'Accept-Language': 'en-US,en;q=0.9',
                Cookie: this.getCookieHeader()
            }
        });
        if (r.headers['set-cookie'])
            this.parseCookies(r.headers['set-cookie']);
        if (r.error || r.statusCode !== 200)
            return null;
        const code = r.body?.message?.header?.status_code;
        const ut = r.body?.message?.body?.user_token;
        if (code !== 200 || !ut) {
            this.token = null;
            return null;
        }
        this.token = ut;
        this.tokenExpiry = now + 10 * 60 * 1000;
        return ut;
    }
    async request(endpoint, params) {
        let token = await this.ensureToken();
        if (!token)
            return null;
        for (let attempt = 0; attempt < 2; attempt++) {
            const search = new URLSearchParams();
            search.set('app_id', APP_ID);
            search.set('usertoken', token);
            for (const [k, v] of Object.entries(params)) {
                if (v)
                    search.set(k, v);
            }
            const baseUrl = `${ROOT}/${endpoint}?${search.toString()}`;
            let url = baseUrl;
            if (!this.secret)
                await this.fetchSecret();
            if (this.secret)
                url = this.signUrl(baseUrl, this.secret);
            const r = await (0, http_1.makeRequest)(url, {
                headers: {
                    'User-Agent': DEFAULT_UA,
                    Accept: 'application/json',
                    Cookie: this.getCookieHeader()
                }
            });
            if (r.error || r.statusCode !== 200)
                return null;
            const code = r.body?.message?.header?.status_code;
            if (code === 401 || code === 402 || code === 403) {
                this.token = null;
                token = await this.ensureToken(true);
                if (!token)
                    return null;
                continue;
            }
            return r.body;
        }
        return null;
    }
    async search(query) {
        const r = await this.request('track.search', {
            q: query,
            page_size: '10',
            page: '1',
            s_track_rating: 'desc',
            f_has_lyrics: '1'
        });
        if (!r?.message?.body?.track_list)
            return [];
        return r.message.body.track_list.map((item) => ({
            provider: this.name,
            name: item.track.track_name,
            artist: item.track.artist_name,
            album: item.track.album_name,
            duration: item.track.track_length,
            trackId: item.track.track_id
        }));
    }
    async getById(trackId) {
        const id = String(trackId);
        const sub = await this.request('track.subtitle.get', {
            track_id: id,
            subtitle_format: 'mxm'
        });
        const subBody = sub?.message?.body?.subtitle?.subtitle_body;
        if (subBody) {
            try {
                const parsed = JSON.parse(subBody);
                if (Array.isArray(parsed) && parsed.length) {
                    const lrc = parsed
                        .map((item) => {
                        const total = item?.time?.total ?? 0;
                        const minutes = Math.floor(total / 60);
                        const seconds = (total - minutes * 60).toFixed(2);
                        return `[${String(minutes).padStart(2, '0')}:${seconds.padStart(5, '0')}] ${item?.text ?? ''}`;
                    })
                        .join('\n');
                    if (lrc.trim())
                        return { synced: lrc };
                }
            }
            catch {
                /* not JSON */
            }
        }
        const lyr = await this.request('track.lyrics.get', {
            track_id: id
        });
        const lyricsBody = lyr?.message?.body?.lyrics?.lyrics_body;
        if (lyricsBody)
            return { unsynced: lyricsBody };
        return null;
    }
    async getLyrics(query) {
        const results = await this.search(query);
        for (const r of results.slice(0, 5)) {
            if (!r.trackId)
                continue;
            const track = await this.getById(r.trackId);
            if (track) {
                return { ...track, name: r.name, artist: r.artist, album: r.album, duration: r.duration };
            }
        }
        return null;
    }
}
exports.MusixmatchProvider = MusixmatchProvider;
