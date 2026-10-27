"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadProxies = loadProxies;
exports.pickProxy = pickProxy;
exports.markProxyFailure = markProxyFailure;
exports.markProxySuccess = markProxySuccess;
exports.buildTunnel = buildTunnel;
exports.proxiedRequest = proxiedRequest;
exports.detectCountry = detectCountry;
exports.resetIpCache = resetIpCache;
exports.getProxyState = getProxyState;
exports.setProxyCursor = setProxyCursor;
exports.getProxyCursor = getProxyCursor;
const net = __importStar(require("node:net"));
const tls = __importStar(require("node:tls"));
const http = __importStar(require("node:http"));
const https = __importStar(require("node:https"));
const node_url_1 = require("node:url");
let proxyCursor = 0;
const proxyState = new Map();
function parseProxy(url) {
    const u = new node_url_1.URL(url);
    const protocol = u.protocol === 'https:' ? 'https' : 'http';
    const auth = u.username
        ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
        : undefined;
    return { host: u.hostname, port: Number(u.port || (protocol === 'https' ? 443 : 8080)), auth, protocol };
}
function loadProxies(envVar = 'PROXY_URLS') {
    const raw = process.env[envVar];
    if (!raw)
        return [];
    const list = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    const endpoints = list.map((url) => ({ url, protocol: 'http', failures: 0 }));
    for (const ep of endpoints)
        proxyState.set(ep.url, ep);
    return endpoints;
}
function pickProxy(proxies) {
    const live = proxies.filter((p) => (p.failures || 0) < 3);
    if (!live.length)
        return null;
    let best = null;
    let bestScore = -Infinity;
    for (let i = 0; i < live.length; i++) {
        const p = live[i];
        const age = p.lastUsed ? (Date.now() - p.lastUsed) / 1000 : 999;
        const score = age + i * 0.001 - (p.failures || 0) * 10;
        if (score > bestScore) {
            bestScore = score;
            best = p;
        }
    }
    if (!best)
        return null;
    best.lastUsed = Date.now();
    return best;
}
function markProxyFailure(proxy) {
    proxy.failures = (proxy.failures || 0) + 1;
}
function markProxySuccess(proxy) {
    proxy.failures = 0;
}
function buildTunnel(proxyUrl, target) {
    return new Promise((resolve, reject) => {
        const proxy = parseProxy(proxyUrl);
        const socket = net.connect({ host: proxy.host, port: proxy.port }, () => {
            const connectReq = `CONNECT ${target.host}:${target.port} HTTP/1.1\r\n` +
                `Host: ${target.host}:${target.port}\r\n` +
                (proxy.auth ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n` : '') +
                `\r\n`;
            socket.write(connectReq);
        });
        let buffer = '';
        let cleaned = false;
        const cleanup = () => {
            if (cleaned)
                return;
            cleaned = true;
            socket.removeAllListeners('data');
            socket.removeAllListeners('error');
        };
        socket.once('error', (err) => {
            cleanup();
            reject(err);
        });
        socket.once('data', (chunk) => {
            buffer += chunk.toString('utf-8');
            const idx = buffer.indexOf('\r\n\r\n');
            if (idx === -1)
                return;
            const head = buffer.slice(0, idx);
            const statusLine = head.split('\r\n')[0] || '';
            const ok = /^HTTP\/1\.[01]\s+2\d\d/.test(statusLine);
            cleanup();
            if (!ok) {
                socket.destroy();
                reject(new Error(`proxy CONNECT failed: ${statusLine}`));
                return;
            }
            if (target.protocol === 'https:') {
                const tlsSocket = tls.connect({
                    socket,
                    servername: target.host,
                    rejectUnauthorized: false
                });
                tlsSocket.once('secureConnect', () => resolve(tlsSocket));
                tlsSocket.once('error', (err) => {
                    tlsSocket.destroy();
                    reject(err);
                });
            }
            else {
                resolve(socket);
            }
        });
    });
}
function proxiedRequest(url, opts = {}) {
    const u = new node_url_1.URL(url);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const proxy = opts.proxy;
    const controller = new AbortController();
    const timeout = opts.timeout ?? 15000;
    const timer = setTimeout(() => controller.abort(), timeout);
    return new Promise((resolve) => {
        const finish = (payload) => {
            clearTimeout(timer);
            resolve(payload);
        };
        const send = (socket) => {
            const mergedHeaders = {
                Host: `${u.hostname}${u.port ? ':' + u.port : ''}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                ...opts.headers
            };
            const reqOpts = {
                host: u.hostname,
                port: u.port || (isHttps ? 443 : 80),
                path: u.pathname + u.search,
                method: opts.method || 'GET',
                agent: false,
                headers: mergedHeaders
            };
            if (socket)
                reqOpts.socket = socket;
            const req = lib.request(reqOpts, (r) => {
                const chunks = [];
                r.on('data', (c) => chunks.push(c));
                r.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf-8');
                    const ct = (r.headers['content-type'] || r.headers['Content-Type'] || '');
                    let parsed = text;
                    const trimmed = text.trim();
                    if (ct.includes('application/json') ||
                        ct.includes('text/json') ||
                        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
                        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
                        try {
                            parsed = JSON.parse(text);
                        }
                        catch {
                            parsed = text;
                        }
                    }
                    const headers = {};
                    Object.entries(r.headers).forEach(([k, v]) => {
                        if (typeof v === 'string')
                            headers[k.toLowerCase()] = v;
                    });
                    const setCookie = (r.headers['set-cookie'] || r.headers['Set-Cookie']);
                    finish({
                        statusCode: r.statusCode || 0,
                        body: parsed,
                        headers,
                        raw: text,
                        setCookie: setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : undefined
                    });
                });
                r.on('error', () => finish({ statusCode: 0, body: null, headers: {}, error: 'response error' }));
            });
            req.on('error', (err) => {
                finish({ statusCode: 0, body: null, headers: {}, error: err.message });
            });
            if (opts.body)
                req.write(opts.body);
            req.setTimeout(timeout, () => req.destroy());
            req.end();
        };
        if (proxy) {
            buildTunnel(proxy.url, { host: u.hostname, port: reqPort(u), protocol: u.protocol })
                .then(send)
                .catch((err) => finish({ statusCode: 0, body: null, headers: {}, error: err.message }));
        }
        else {
            send(null);
        }
    });
}
function reqPort(u) {
    if (u.port)
        return Number(u.port);
    return u.protocol === 'https:' ? 443 : 80;
}
let cachedIpCountry = null;
const IP_LOOKUP_TTL_MS = 60 * 60 * 1000;
async function detectCountry(ipLookupUrl = 'https://api.iplocation.net/?cmd=get-ip', geoLookupUrl = 'https://api.iplocation.net/') {
    if (cachedIpCountry && Date.now() - cachedIpCountry.fetchedAt < IP_LOOKUP_TTL_MS) {
        return { ip: cachedIpCountry.ip, country: cachedIpCountry.country };
    }
    const ipResp = await proxiedRequest(ipLookupUrl);
    const ip = ipResp.body?.ip || '1.1.1.1';
    const geoResp = await proxiedRequest(geoLookupUrl, {
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
        body: JSON.stringify({ ip })
    });
    const country = geoResp.body?.country_code2 || 'US';
    cachedIpCountry = { ip, country, fetchedAt: Date.now() };
    return { ip, country };
}
function resetIpCache() {
    cachedIpCountry = null;
}
function getProxyState() {
    return proxyState;
}
function setProxyCursor(idx) {
    proxyCursor = idx;
}
function getProxyCursor() {
    return proxyCursor;
}
