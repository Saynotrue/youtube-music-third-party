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
exports.makeRequest = makeRequest;
exports.log = log;
const https = __importStar(require("node:https"));
const http = __importStar(require("node:http"));
const node_url_1 = require("node:url");
const proxy_1 = require("./proxy");
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ipv4Agent = new https.Agent({ family: 4 });
const ipv4HttpAgent = new http.Agent({ family: 4 });
function pickAgent(protocol) {
    return protocol === 'http:' ? ipv4HttpAgent : ipv4Agent;
}
function rawRequest(url, method, headers, body, timeout, signal) {
    return new Promise((resolve) => {
        const u = new node_url_1.URL(url);
        const agent = pickAgent(u.protocol);
        const lib = u.protocol === 'https:' ? https : http;
        const mergedHeaders = {
            'User-Agent': DEFAULT_UA,
            Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...headers
        };
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method,
            agent,
            headers: mergedHeaders
        }, (r) => {
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
                        if (trimmed.startsWith("'") || /^\{'\w+':/.test(trimmed)) {
                            try {
                                const fixed = text
                                    .replace(/'/g, '"')
                                    .replace(/True/g, 'true')
                                    .replace(/False/g, 'false')
                                    .replace(/None/g, 'null');
                                parsed = JSON.parse(fixed);
                            }
                            catch {
                                parsed = text;
                            }
                        }
                        else {
                            parsed = text;
                        }
                    }
                }
                const responseHeaders = {};
                Object.entries(r.headers).forEach(([k, v]) => {
                    if (typeof v === 'string')
                        responseHeaders[k.toLowerCase()] = v;
                });
                const setCookie = (r.headers['set-cookie'] || r.headers['Set-Cookie']);
                resolve({
                    statusCode: r.statusCode || 0,
                    body: parsed,
                    headers: responseHeaders,
                    raw: text,
                    setCookie: setCookie ? (Array.isArray(setCookie) ? setCookie : [setCookie]) : undefined
                });
            });
            r.on('error', () => {
                resolve({ statusCode: 0, body: null, headers: {}, error: 'response error' });
            });
        });
        req.on('error', (reqErr) => {
            const message = reqErr instanceof Error ? reqErr.message : String(reqErr);
            resolve({ statusCode: 0, body: null, headers: {}, error: message });
        });
        if (signal) {
            if (signal.aborted)
                req.destroy();
            else
                signal.addEventListener('abort', () => req.destroy());
        }
        if (body)
            req.write(body);
        req.setTimeout(timeout, () => req.destroy());
        req.end();
    });
}
function makeRequest(url, options = {}) {
    const { method = 'GET', headers = {}, body, timeout = 15000, signal, family, proxy } = options;
    if (proxy) {
        return (0, proxy_1.proxiedRequest)(url, {
            method,
            headers,
            body,
            timeout,
            proxy: proxy
        });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    if (signal) {
        if (signal.aborted)
            controller.abort();
        else
            signal.addEventListener('abort', () => controller.abort());
    }
    if (family === 4 || family === undefined) {
        return rawRequest(url, method, headers, body, timeout, signal).finally(() => clearTimeout(timer));
    }
    return fetch(url, {
        method,
        headers: {
            'User-Agent': DEFAULT_UA,
            Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            ...headers
        },
        body,
        signal: controller.signal,
        redirect: 'follow'
    })
        .then(async (res) => {
        clearTimeout(timer);
        const contentType = res.headers.get('content-type') || '';
        const raw = await res.text();
        let parsed = raw;
        if (contentType.includes('application/json') || raw.trim().startsWith('{') || raw.trim().startsWith('[')) {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                parsed = raw;
            }
        }
        const responseHeaders = {};
        res.headers.forEach((value, key) => {
            responseHeaders[key.toLowerCase()] = value;
        });
        return {
            statusCode: res.status,
            body: parsed,
            headers: responseHeaders,
            raw,
            setCookie: (res.headers.getSetCookie && res.headers.getSetCookie()) || undefined
        };
    })
        .catch((err) => {
        clearTimeout(timer);
        const message = err instanceof Error ? err.message : String(err);
        return { statusCode: 0, body: null, headers: {}, error: message };
    });
}
function log(level, tag, message) {
    const colors = {
        debug: '\x1b[90m',
        info: '\x1b[36m',
        warn: '\x1b[33m',
        error: '\x1b[31m'
    };
    const reset = '\x1b[0m';
    const color = colors[level] || '';
    // eslint-disable-next-line no-console
    console.log(`${color}[${level.toUpperCase()}][${tag}]${reset} ${message}`);
}
