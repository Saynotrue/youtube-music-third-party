"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppleMusicProvider = void 0;
const http_1 = require("../utils/http");
const text_1 = require("../utils/text");
const PAXSENIX = 'https://lyrics.paxsenix.org';
const ITUNES_SEARCH = 'https://itunes.apple.com/search';
class AppleMusicProvider {
    constructor() {
        this.name = 'AppleMusic';
    }
    async setup() {
        return true;
    }
    async itunesSearch(query) {
        const params = new URLSearchParams({
            term: query,
            media: 'music',
            entity: 'song',
            limit: '5'
        });
        const r = await (0, http_1.makeRequest)(`${ITUNES_SEARCH}?${params}`);
        if (r.error || r.statusCode !== 200 || !r.body?.results)
            return [];
        return r.body.results.map((t) => ({
            provider: this.name,
            name: t.trackName,
            artist: t.artistName,
            album: t.collectionName,
            duration: Math.round(t.trackTimeMillis / 1000),
            trackId: t.trackId
        }));
    }
    async paxsenixFetch(id) {
        const r = await (0, http_1.makeRequest)(`${PAXSENIX}/apple-music/lyrics?id=${encodeURIComponent(String(id))}`);
        if (r.error || r.statusCode !== 200 || !r.body)
            return null;
        return r.body;
    }
    ttmlToLrc(ttml) {
        const out = [];
        const pRe = /<p\s+([^>]*)?>([\s\S]*?)<\/p>/g;
        let m;
        while ((m = pRe.exec(ttml)) !== null) {
            const attrs = m[1] || '';
            const body = m[2] || '';
            const beginMatch = attrs.match(/begin="([^"]+)"/);
            if (!beginMatch)
                continue;
            const beginMs = (0, text_1.timeToMs)(beginMatch[1] || '0');
            const text = body
                .replace(/<span[^>]*>/g, '')
                .replace(/<\/span>/g, '')
                .replace(/<br\s*\/?>/g, '\n')
                .replace(/<[^>]+>/g, '')
                .replace(/&amp;/g, '&')
                .replace(/&apos;/g, "'")
                .replace(/&quot;/g, '"')
                .trim();
            if (!text)
                continue;
            const minutes = Math.floor(beginMs / 60000);
            const seconds = (beginMs - minutes * 60000) / 1000;
            out.push(`[${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}] ${text}`);
        }
        return out.join('\n');
    }
    async getById(trackId) {
        const data = await this.paxsenixFetch(trackId);
        if (!data)
            return null;
        if (data.ttmlContent) {
            const lrc = this.ttmlToLrc(data.ttmlContent);
            if (lrc)
                return { synced: lrc };
        }
        if (data.elrc)
            return { synced: data.elrc };
        if (data.elrcMultiPerson)
            return { synced: data.elrcMultiPerson };
        if (data.plain)
            return { unsynced: data.plain };
        if (data.content?.length) {
            if (data.type === 'Syllable') {
                const lrc = data.content
                    .map((line) => {
                    const minutes = Math.floor(line.timestamp / 60000);
                    const seconds = (line.timestamp - minutes * 60000) / 1000;
                    const text = line.text.map((w) => w.text).join('').trim();
                    if (!text)
                        return '';
                    return `[${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}] ${text}`;
                })
                    .filter(Boolean)
                    .join('\n');
                return { synced: lrc };
            }
            const plain = data.content
                .map((line) => line.text.map((w) => w.text).join('').trim())
                .filter((s) => s)
                .join('\n');
            return { unsynced: plain };
        }
        return null;
    }
    async search(query) {
        return this.itunesSearch(query);
    }
    async getLyrics(query) {
        const results = await this.itunesSearch(query);
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
exports.AppleMusicProvider = AppleMusicProvider;
