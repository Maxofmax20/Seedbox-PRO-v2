const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const session = require('express-session');
const path = require('path');
const axios = require('axios');
const http = require('http');
const torrentStream = require('torrent-stream');
const rangeParser = require('range-parser');
const pump = require('pump');
const multer = require('multer');
const fs = require('fs');
const FormData = require('form-data');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const upload = multer({ dest: '/tmp/uploads/' });

// Security Config
const USER = process.env.DASHBOARD_USER || 'Demos';
const PASS = process.env.DASHBOARD_PASS || '1211982Samir?';
const SECRET = process.env.SESSION_SECRET || 'super-secret-key';

const JACKETT_URL = 'http://jackett:9117';
const JACKETT_API_KEY = '98aj5khicxsvobijwt6wijocu9bugksl';
const PROWLARR_URL = 'http://prowlarr:9696';
const PROWLARR_API_KEY = 'd406af9644fb47fdbb7da3fac568067d';

const manifest = {
    id: 'org.myseedbox.sandbox.v3',
    version: '3.0.3',
    name: 'SandBox PRO Streamer',
    description: 'Triple-Engine Combined Streamer.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);
const QBT_URL = 'http://172.21.0.2:8080';
const activeEngines = new Map();

// --- SEARCH ENGINES ---
async function searchJackett(query, type) {
    try {
        const cat = type === 'movie' ? 2000 : 5000;
        const res = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(query)}&Category=${cat}`, { httpAgent, timeout: 10000 });
        return (res.data.Results || []).map(r => ({ title: r.Title, seeders: r.Seeders, size: r.Size, magnet: r.MagnetUri || r.Link, engine: 'Jackett' }));
    } catch (e) { return []; }
}

async function searchProwlarr(query, type) {
    try {
        const cat = type === 'movie' ? 2000 : 5000;
        const res = await axios.get(`${PROWLARR_URL}/api/v1/search?apikey=${PROWLARR_API_KEY}&query=${encodeURIComponent(query)}&categories=${cat}`, { httpAgent, timeout: 10000 });
        return (res.data || []).map(r => ({ title: r.title, seeders: r.seeders, size: r.size, magnet: r.guid || r.downloadUrl, engine: 'Prowlarr' }));
    } catch (e) { return []; }
}

async function searchDirect(query) {
    try {
        const res = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, { timeout: 5000 });
        return (res.data || []).filter(r => r.id !== '0').map(r => ({ title: r.name, seeders: r.seeders, size: r.size, magnet: `magnet:?xt=urn:btih:${r.info_hash}&dn=${encodeURIComponent(r.name)}`, engine: 'Direct' }));
    } catch (e) { return []; }
}

function analyzeTorrent(title, meta) {
    const t = title.toLowerCase();
    const cleanMeta = meta.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (['xxx', 'porn', 'adult', 'sex'].some(a => t.includes(a))) return null;
    if (!t.replace(/[^a-z0-9\s]/g, '').includes(cleanMeta.split(' ')[0])) return null;
    let q = 'SD';
    if (t.includes('2160p') || t.includes('4k')) q = '4K UHD';
    else if (t.includes('1080p')) q = '1080p FHD';
    else if (t.includes('720p')) q = '720p HD';
    return { q };
}

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const parts = id.split(':');
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
        const meta = metaRes.data.meta;
        let query = meta.name;
        if (type === 'series') query += ` S${parts[1].padStart(2, '0')}E${parts[2].padStart(2, '0')}`;
        const [j, p, d] = await Promise.all([searchJackett(query, type), searchProwlarr(query, type), searchDirect(query)]);
        const combined = [...j, ...p, ...d];
        const streams = combined.map(r => {
            const analysis = analyzeTorrent(r.title, meta);
            if (!analysis) return null;
            return {
                name: `[${r.engine}] ${analysis.q}`,
                title: `${r.title}\n👤 ${r.seeders || '?'} | 💾 ${(r.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                url: `http://${process.env.DOMAIN}/play?magnet=${encodeURIComponent(r.magnet)}&name=${encodeURIComponent(r.title)}`
            };
        }).filter(Boolean);
        streams.sort((a, b) => parseInt(b.title.match(/👤 (\d+)/)?.[1] || 0) - parseInt(a.title.match(/👤 (\d+)/)?.[1] || 0));
        return { streams: streams.slice(0, 25) };
    } catch (e) { return { streams: [] }; }
});

const app = express();
app.use(express.json());
app.use(session({ secret: SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } }));

function isAuthenticated(req, res, next) { 
    if (req.session.user) return next(); 
    res.status(401).json({ error: 'Unauthorized' }); 
}

app.post('/api/login', (req, res) => {
    if (req.body.username === USER && req.body.password === PASS) { req.session.user = USER; return res.json({ success: true }); }
    res.status(401).json({ error: 'Invalid' });
});

app.get('/api/me', (req, res) => res.json({ loggedIn: !!req.session.user }));
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

// Serve static UI
app.use(express.static(path.join(__dirname, 'public')));

// Protected APIs
app.get('/api/torrents', isAuthenticated, async (req, res) => {
    try {
        const l = await qbtRequest('GET', '/api/v2/torrents/info');
        res.json(l.map(t => ({ hash: t.hash, name: t.name, progress: (t.progress * 100).toFixed(1), speed: (t.dlspeed / 1024).toFixed(1) + " KB/s", size: (t.size / 1024 / 1024 / 1024).toFixed(2) + " GB", status: t.state })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/torrents/:hash', isAuthenticated, async (req, res) => {
    try { await qbtRequest('POST', '/api/v2/torrents/delete', { hashes: req.params.hash, deleteFiles: 'true' }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/status', isAuthenticated, (req, res) => {
    const list = Array.from(activeEngines.values()).map(e => ({
        name: e.displayName || "Initializing...",
        progress: e.progress || 0,
        speed: e.swarm ? (e.swarm.downloadSpeed() / 1024).toFixed(1) : "0.0",
        peers: e.swarm ? e.swarm.wires.length : 0
    }));
    res.json(list);
});

app.use('/', getRouter(builder.getInterface()));

// --- PLAY ENDPOINT ---
app.get('/play', async (req, res) => {
    let { magnet, name } = req.query;
    if (!magnet) return res.status(400).send('No magnet');

    // Handle redirects
    if (magnet.startsWith('http')) {
        try {
            const head = await axios.head(magnet, { maxRedirects: 0, validateStatus: null });
            if (head.headers.location) magnet = head.headers.location;
        } catch (e) {}
    }

    let engine = activeEngines.get(magnet);
    if (!engine) {
        engine = torrentStream(magnet, { path: '/tmp/torrent-stream' });
        engine.displayName = name || "Loading Torrent...";
        engine.progress = 0;
        activeEngines.set(magnet, engine);

        engine.on('ready', () => {
            const f = engine.files.reduce((a, b) => a.length > b.length ? a : b);
            engine.mainFile = f;
            engine.displayName = f.name;
            f.select();
        });

        // Progress Loop
        const pInterval = setInterval(() => {
            if (engine.mainFile && engine.bitfield) {
                const total = Math.ceil(engine.mainFile.length / engine.torrent.pieceLength);
                let dl = 0;
                for (let i = 0; i < total; i++) if (engine.bitfield.get(i)) dl++;
                engine.progress = ((dl / total) * 100).toFixed(1);
            }
        }, 3000);

        engine.on('close', () => {
            clearInterval(pInterval);
            activeEngines.delete(magnet);
        });
    }

    const serve = () => {
        const f = engine.mainFile;
        const r = req.headers.range && rangeParser(f.length, req.headers.range);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', 'video/mp4');
        if (!r) {
            res.setHeader('Content-Length', f.length);
            if (req.method === 'HEAD') return res.end();
            return pump(f.createReadStream(), res);
        }
        const { start, end } = r[0];
        res.status(206);
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${f.length}`);
        pump(f.createReadStream({ start, end }), res);
    };

    if (engine.mainFile) serve();
    else engine.once('ready', serve);
});

// qBittorrent Helper
let qbtCookie = '';
async function qbtRequest(method, path, data = null) {
    if (!qbtCookie) {
        const p = new URLSearchParams(); p.append('username', 'admin'); p.append('password', 'PtkWFsypA');
        const r = await axios.post(`${QBT_URL}/api/v2/auth/login`, p, { httpAgent });
        qbtCookie = r.headers['set-cookie'][0];
    }
    const c = { headers: { Cookie: qbtCookie }, httpAgent };
    if (method === 'GET') return (await axios.get(`${QBT_URL}${path}`, c)).data;
    const params = new URLSearchParams(); if (data) Object.keys(data).forEach(k => params.append(k, data[k]));
    return (await axios.post(`${QBT_URL}${path}`, params, c)).data;
}

app.listen(7000, () => console.log('SandBox PRO v3.0.3 Ready.'));
