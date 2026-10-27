"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.QQMusicProvider = void 0;
const http_1 = require("../utils/http");
const text_1 = require("../utils/text");
const SEARCH = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg';
const LYRIC = 'https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg';
class QQMusicProvider {
    constructor() {
        this.name = 'QQMusic';
    }
    async setup() {
        return true;
    }
    async search(query) {
        const params = new URLSearchParams({
            key: query,
            format: 'json',
            outCharset: 'utf-8',
            platform: 'yqq',
            needNewCode: '0'
        });
        const r = await (0, http_1.makeRequest)(`${SEARCH}?${params}`, {
            headers: { Referer: 'https://y.qq.com/' }
        });
        if (r.error || r.statusCode !== 200 || !r.body?.data?.song) {
            (0, http_1.log)('debug', this.name, `search failed: ${r.error || r.statusCode}`);
            return [];
        }
        const items = r.body.data.song.itemlist || r.body.data.song.songlist || [];
        return items.map((s) => ({
            provider: this.name,
            name: s.name || s.songname,
            artist: typeof s.singer === 'string' ? s.singer : s.singer.map((x) => x.name).join(', '),
            album: s.albumname,
            duration: s.interval,
            trackId: s.mid || s.songmid
        }));
    }
    async getById(trackId) {
        const params = new URLSearchParams({
            songmid: String(trackId),
            format: 'json',
            outCharset: 'utf-8',
            platform: 'yqq',
            needNewCode: '0',
            callback: 'MusicJsonCallback'
        });
        const r = await (0, http_1.makeRequest)(`${LYRIC}?${params}`, {
            headers: { Referer: 'https://y.qq.com/' }
        });
        if (r.error || r.statusCode !== 200 || !r.body)
            return null;
        let raw = r.body;
        if (typeof raw === 'string') {
            raw = raw.replace(/^MusicJsonCallback\(/, '').replace(/\);?$/, '').trim();
        }
        try {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed.code !== 0 || !parsed.lyric)
                return null;
            let lyric = parsed.lyric;
            try {
                const decoded = Buffer.from(lyric, 'base64').toString('utf-8');
                if (/\[\d{1,2}:\d{1,2}\.\d{2,3}\]/.test(decoded) || /\[(ti|ar|al|by|offset):/.test(decoded)) {
                    lyric = decoded;
                }
            }
            catch {
                /* not base64 */
            }
            lyric = (0, text_1.decodeEntities)(lyric);
            return {
                synced: /\[\d{1,2}:\d{1,2}\.\d{2,3}\]/.test(lyric) ? lyric : undefined,
                unsynced: /\[\d{1,2}:\d{1,2}\.\d{2,3}\]/.test(lyric) ? undefined : lyric
            };
        }
        catch {
            return null;
        }
    }
    async getLyrics(query) {
        const results = await this.search(query);
        const top = results[0];
        if (!top?.trackId)
            return null;
        const track = await this.getById(top.trackId);
        if (!track)
            return null;
        return { ...track, name: top.name, artist: top.artist, album: top.album, duration: top.duration };
    }
}
exports.QQMusicProvider = QQMusicProvider;
