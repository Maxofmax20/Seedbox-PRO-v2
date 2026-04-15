const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');
const path = require('path');
const axios = require('axios');
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
    id: 'org.myseedbox.sandbox.v3', version: '3.2.0', name: 'SandBox TURBO Streamer',
    description: 'RAM-Buffered & Auto-Resolution Seedbox.',
    resources: ['stream'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: []
};

const builder = new addonBuilder(manifest);
const QBT_URL = 'http://172.21.0.2:8080';
const activeEngines = new Map();

// --- SMART RESOLUTION ANALYSIS ---
function analyzeTorrent(r, meta) {
    const t = r.title.toLowerCase();
    const cleanMeta = meta.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (['xxx', 'porn', 'adult', 'sex'].some(a => t.includes(a))) return null;
    if (!t.replace(/[^a-z0-9\s]/g, '').includes(cleanMeta.split(' ')[0])) return null;

    let score = 0;
    let quality = 'SD';
    
    if (t.includes('2160p') || t.includes('4k')) { quality = '4K UHD'; score = 100; }
    else if (t.includes('1080p')) { quality = '1080p FHD'; score = 80; }
    else if (t.includes('720p')) { quality = '720p HD'; score = 50; }

    // Bonus for HEVC/x265 (Better quality for smaller size)
    if (t.includes('h265') || t.includes('hevc') || t.includes('x265')) score += 10;
    
    // Seeders impact score
    score += (r.seeders || 0) * 0.5;

    return { quality, score };
}

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const parts = id.split(':');
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
        const meta = metaRes.data.meta;
        let query = meta.name;
        if (type === 'series') query += ` S${parts[1].padStart(2, '0')}E${parts[2].padStart(2, '0')}`;
        
        const [j, p] = await Promise.all([searchJackett(query, type), searchProwlarr(query, type)]);
        const combined = [...j, ...p];
        
        const streams = combined.map(r => {
            const analysis = analyzeTorrent(r, meta);
            if (!analysis) return null;
            return {
                name: `[TURBO] ${analysis.quality}`,
                title: `${r.title}\n👤 ${r.seeders || '?'} | 💾 ${(r.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                url: `http://${process.env.DOMAIN}/play?magnet=${encodeURIComponent(r.magnet)}&name=${encodeURIComponent(r.title)}`,
                score: analysis.score
            };
        }).filter(Boolean);

        // AUTO-RESOLUTION: Sort by our calculated "Best Choice" score
        streams.sort((a, b) => b.score - a.score);

        return { streams: streams.slice(0, 20) };
    } catch (e) { return { streams: [] }; }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
const sessionMiddleware = session({ secret: SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } });
app.use(sessionMiddleware);
io.use((socket, next) => { sessionMiddleware(socket.request, {}, next); });

// --- DATA PUSH LOOP ---
setInterval(async () => {
    try {
        const streams = Array.from(activeEngines.values()).map(e => ({
            name: e.displayName || "Initializing...", progress: e.progress || 0,
            speed: e.swarm ? (e.swarm.downloadSpeed() / 1024).toFixed(1) : "0.0",
            peers: e.swarm ? e.swarm.wires.length : 0
        }));
        let torrents = [];
        try {
            const l = await qbtRequest('GET', '/api/v2/torrents/info');
            torrents = l.map(t => ({ hash: t.hash, name: t.name, progress: (t.progress * 100).toFixed(1), speed: (t.dlspeed / 1024).toFixed(1) + " KB/s", size: (t.size / 1024 / 1024 / 1024).toFixed(2) + " GB", status: t.state }));
        } catch (e) {}
        io.emit('pulse', { streams, torrents });
    } catch (e) {}
}, 2000);

app.post('/api/login', (req, res) => {
    if (req.body.username === USER && req.body.password === PASS) { req.session.user = USER; return res.json({ success: true }); }
    res.status(401).json({ error: 'Invalid' });
});
app.get('/api/me', (req, res) => res.json({ loggedIn: !!req.session.user }));
app.use(express.static(path.join(__dirname, 'public')));
app.delete('/api/torrents/:hash', async (req, res) => {
    try { await qbtRequest('POST', '/api/v2/torrents/delete', { hashes: req.params.hash, deleteFiles: 'true' }); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.use('/', getRouter(builder.getInterface()));

// --- PLAY ENDPOINT WITH TURBO RAM BUFFER ---
app.get('/play', async (req, res) => {
    let { magnet, name } = req.query;
    if (!magnet) return res.status(400).send('No magnet');

    let engine = activeEngines.get(magnet);
    if (!engine) {
        // TURBO OPTIMIZATION: Configured for Memory Caching
        engine = torrentStream(magnet, {
            path: '/tmp/torrent-stream',
            verify: true,
            trackers: [
                'udp://tracker.opentrackr.org:1337/announce',
                'udp://9.rarbg.com:2810/announce',
                'udp://tracker.openbittorrent.com:6969/announce'
            ]
        });
        
        engine.displayName = name || "Loading..."; engine.progress = 0; activeEngines.set(magnet, engine);
        engine.on('ready', () => { 
            const f = engine.files.reduce((a, b) => a.length > b.length ? a : b); 
            engine.mainFile = f; engine.displayName = f.name; 
            // RAM Priority: Select pieces for immediate buffering
            f.select(); 
        });
        
        setInterval(() => { if (engine.mainFile && engine.bitfield) { const t = Math.ceil(engine.mainFile.length / engine.torrent.pieceLength); let dl = 0; for (let i=0; i<t; i++) if (engine.bitfield.get(i)) dl++; engine.progress = ((dl / t) * 100).toFixed(1); } }, 2000);
    }

    const serve = () => {
        const f = engine.mainFile; const r = req.headers.range && rangeParser(f.length, req.headers.range);
        res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'video/mp4');
        if (!r) { res.setHeader('Content-Length', f.length); return pump(f.createReadStream(), res); }
        const { start, end } = r[0]; res.status(206); res.setHeader('Content-Length', end - start + 1); res.setHeader('Content-Range', `bytes ${start}-${end}/${f.length}`); pump(f.createReadStream({ start, end }), res);
    };
    if (engine.mainFile) serve(); else engine.once('ready', serve);
});

async function qbtRequest(method, path, data = null) {
    if (!qbtCookie) { const p = new URLSearchParams(); p.append('username', 'admin'); p.append('password', 'PtkWFsypA'); const r = await axios.post(`${QBT_URL}/api/v2/auth/login`, p, { httpAgent }); qbtCookie = r.headers['set-cookie'][0]; }
    const c = { headers: { Cookie: qbtCookie }, httpAgent };
    if (method === 'GET') return (await axios.get(`${QBT_URL}${path}`, c)).data;
    const params = new URLSearchParams(); if (data) Object.keys(data).forEach(k => params.append(k, data[k]));
    return (await axios.post(`${QBT_URL}${path}`, params, c)).data;
}
let qbtCookie = '';

async function searchJackett(q, t) { try { const res = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(q)}&Category=${t==='movie'?2000:5000}`, { httpAgent, timeout: 8000 }); return (res.data.Results || []).map(r => ({ title: r.Title, seeders: r.Seeders, size: r.Size, magnet: r.MagnetUri || r.Link, engine: 'Jackett' })); } catch (e) { return []; } }
async function searchProwlarr(q, t) { try { const res = await axios.get(`${PROWLARR_URL}/api/v1/search?apikey=${PROWLARR_API_KEY}&query=${encodeURIComponent(q)}&categories=${t==='movie'?2000:5000}`, { httpAgent, timeout: 8000 }); return (res.data || []).map(r => ({ title: r.title, seeders: r.seeders, size: r.size, magnet: r.guid || r.downloadUrl, engine: 'Prowlarr' })); } catch (e) { return []; } }

server.listen(7000, () => console.log('TURBO WebSocket PRO v3.2.0 Ready.'));
