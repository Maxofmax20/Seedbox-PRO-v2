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

// Config
const USER = process.env.DASHBOARD_USER || 'Demos';
const PASS = process.env.DASHBOARD_PASS || '1211982Samir?';
const SECRET = process.env.SESSION_SECRET || 'super-secret-key';

const PROWLARR_URL = 'http://prowlarr:9696';
const PROWLARR_API_KEY = 'd406af9644fb47fdbb7da3fac568067d';
const JACKETT_URL = 'http://jackett:9117';
const JACKETT_API_KEY = '98aj5khicxsvobijwt6wijocu9bugksl';

const manifest = {
    id: 'org.myseedbox.pro.final',
    version: '3.0.0',
    name: 'SandBox PRO Streamer',
    description: 'Triple-Engine Secure Seedbox Streamer.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);
const QBT_URL = 'http://172.21.0.2:8080';
const activeEngines = new Map();

// --- SEARCH ENGINES ---
async function searchProwlarr(query, type) {
    try {
        const cat = type === 'movie' ? 2000 : 5000;
        const res = await axios.get(`${PROWLARR_URL}/api/v1/search?apikey=${PROWLARR_API_KEY}&query=${encodeURIComponent(query)}&categories=${cat}`, { httpAgent, timeout: 5000 });
        return (res.data || []).map(r => ({ title: r.title, seeders: r.seeders, size: r.size, magnet: r.downloadUrl || r.guid }));
    } catch (e) { return []; }
}

async function searchJackett(query, type) {
    try {
        const cat = type === 'movie' ? 2000 : 5000;
        const res = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(query)}&Category=${cat}`, { httpAgent, timeout: 5000 });
        return (res.data.Results || []).map(r => ({ title: r.Title, seeders: r.Seeders, size: r.Size, magnet: r.MagnetUri || r.Link }));
    } catch (e) { return []; }
}

async function searchDirect(query) {
    try {
        const res = await axios.get(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, { timeout: 5000 });
        return (res.data || []).filter(r => r.id !== '0').map(r => ({
            title: r.name, seeders: r.seeders, size: r.size,
            magnet: `magnet:?xt=urn:btih:${r.info_hash}&dn=${encodeURIComponent(r.name)}`
        }));
    } catch (e) { return []; }
}

function analyzeTorrent(title, meta) {
    const t = title.toLowerCase();
    const cleanMeta = meta.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    if (['xxx', 'porn', 'adult', 'sex'].some(a => t.includes(a))) return null;
    if (['cam', 'hdcam', 'ts'].some(tr => t.split(/[\s\.]+/).includes(tr))) return null;
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

        let [pResults, jResults] = await Promise.all([searchProwlarr(query, type), searchJackett(query, type)]);
        let combined = [...pResults, ...jResults];
        if (combined.length === 0) combined = await searchDirect(query);
        
        const streams = combined.map(r => {
            const analysis = analyzeTorrent(r.title, meta);
            if (!analysis) return null;
            return {
                name: `Seedbox ${analysis.q}`,
                title: `${r.title}\n👤 ${r.seeders || '?'} | 💾 ${(r.size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                url: `http://${process.env.DOMAIN}/play?magnet=${encodeURIComponent(r.magnet)}`
            };
        }).filter(Boolean);

        return { streams: streams.slice(0, 20) };
    } catch (e) { return { streams: [] }; }
});

const app = express();
app.use(express.json());
app.use(session({ secret: SECRET, resave: false, saveUninitialized: false, cookie: { maxAge: 1000 * 60 * 60 * 24 * 30 } }));

function isAuthenticated(req, res, next) { if (req.session.user) return next(); res.status(401).json({ error: 'Unauthorized' }); }

app.post('/api/login', (req, res) => {
    if (req.body.username === USER && req.body.password === PASS) { req.session.user = USER; return res.json({ success: true }); }
    res.status(401).json({ error: 'Invalid' });
});

app.get('/api/me', (req, res) => res.json({ loggedIn: !!req.session.user }));
app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });

app.use('/api/torrents', isAuthenticated);
app.use('/api/files', isAuthenticated);
app.use('/status', isAuthenticated);
app.use('/api/files', express.static('/downloads'));
app.use('/', getRouter(builder.getInterface()));
app.use(express.static(path.join(__dirname, 'public')));

// --- UPDATED PLAY ENDPOINT ---
app.get('/play', async (req, res) => {
    let { magnet } = req.query;
    if (!magnet) return res.status(400).send('No magnet');

    console.log(`[PLAY] Request for: ${magnet.substring(0, 50)}...`);

    // 1. Resolve Magnet if it's a URL
    if (magnet.startsWith('http')) {
        try {
            console.log(`[PLAY] Resolving URL to Magnet...`);
            const head = await axios.head(magnet, { maxRedirects: 0, validateStatus: null });
            if (head.headers.location) {
                magnet = head.headers.location;
                console.log(`[PLAY] Resolved to: ${magnet.substring(0, 50)}...`);
            }
        } catch (e) { console.log(`[PLAY] URL Resolution failed, trying original.`); }
    }

    if (!magnet.includes('btih:')) {
        return res.status(400).send('Invalid magnet or link provided by provider.');
    }

    let engine = activeEngines.get(magnet);
    if (!engine) {
        engine = torrentStream(magnet, { path: '/tmp/torrent-stream' });
        engine.progress = 0; activeEngines.set(magnet, engine);
        engine.on('ready', () => { 
            const f = engine.files.reduce((a, b) => a.length > b.length ? a : b); 
            engine.mainFile = f; engine.name = f.name; 
            f.select(); 
        });
        setInterval(() => { if (engine.mainFile) { const t = Math.ceil(engine.mainFile.length / engine.torrent.pieceLength); let dl = 0; for (let i=0; i<t; i++) if (engine.bitfield.get(i)) dl++; engine.progress = ((dl / t) * 100).toFixed(1); } }, 5000);
    }

    const serve = () => {
        const f = engine.mainFile; const r = req.headers.range && rangeParser(f.length, req.headers.range);
        res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'video/mp4');
        if (!r) { res.setHeader('Content-Length', f.length); if (req.method === 'HEAD') return res.end(); return pump(f.createReadStream(), res); }
        const { start, end } = r[0];
        res.status(206); res.setHeader('Content-Length', end - start + 1); res.setHeader('Content-Range', `bytes ${start}-${end}/${f.length}`);
        pump(f.createReadStream({ start, end }), res);
    };

    if (engine.mainFile) serve(); else engine.once('ready', serve);
});

app.listen(7000, () => console.log('Seedbox PRO v1.0.19 running...'));
