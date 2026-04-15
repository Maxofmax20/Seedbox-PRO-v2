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
const USER = process.env.DASHBOARD_USER || 'admin';
const PASS = process.env.DASHBOARD_PASS || 'PtkWFsypA';
const SECRET = process.env.SESSION_SECRET || 'super-secret-key';

const manifest = {
    id: 'org.myseedbox.addon.v15',
    version: '1.0.15',
    name: 'Seedbox Torrentio PRO',
    description: 'Secure Metadata & Safety Filtered Seedbox.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);
const JACKETT_URL = 'http://jackett:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY;
const QBT_URL = 'http://172.21.0.3:8080';
const activeEngines = new Map();

// --- AUTH MIDDLEWARE ---
function isAuthenticated(req, res, next) {
    if (req.session.user) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

// --- qBittorrent Interaction ---
let qbtCookie = '';
async function qbtRequest(method, path, data = null, isMultipart = false) {
    if (!qbtCookie) {
        const params = new URLSearchParams();
        params.append('username', 'admin');
        params.append('password', 'PtkWFsypA');
        const res = await axios.post(`${QBT_URL}/api/v2/auth/login`, params, { httpAgent });
        qbtCookie = res.headers['set-cookie'][0];
    }
    const config = { headers: { Cookie: qbtCookie }, httpAgent };
    if (method === 'GET') return (await axios.get(`${QBT_URL}${path}`, config)).data;
    if (isMultipart) return (await axios.post(`${QBT_URL}${path}`, data, { ...config, headers: { ...config.headers, ...data.getHeaders() } })).data;
    const params = new URLSearchParams();
    if (data) Object.keys(data).forEach(key => params.append(key, data[key]));
    return (await axios.post(`${QBT_URL}${path}`, params, config)).data;
}

// --- STREMIO HANDLER (No Auth Needed for Stremio App) ---
builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const parts = id.split(':');
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
        const meta = metaRes.data.meta;
        let query = meta.name;
        if (type === 'series') query += ` S${parts[1].padStart(2, '0')}E${parts[2].padStart(2, '0')}`;
        const res = await axios.get(`${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(query)}&Category=${type==='movie'?'2000':'5000'}`, { httpAgent });
        const results = (res.data.Results || []).slice(0, 15);
        return {
            streams: results.map(r => ({
                name: `Seedbox Stream`,
                title: `${r.Title}\n👤 ${r.Seeders || '?'} | 💾 ${(r.Size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                url: `http://${process.env.DOMAIN}/play?magnet=${encodeURIComponent(r.MagnetUri || r.Link)}`
            }))
        };
    } catch (e) { return { streams: [] }; }
});

const app = express();
app.use(express.json());

// Session Setup
app.use(session({
    secret: SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 24 hours
}));

// 1. Login Endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === USER && password === PASS) {
        req.session.user = username;
        return res.json({ success: true });
    }
    res.status(401).json({ error: 'Invalid credentials' });
});

// 2. Auth Check for Dashboard
app.get('/api/me', (req, res) => {
    if (req.session.user) return res.json({ loggedIn: true });
    res.json({ loggedIn: false });
});

// 3. Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Protect All Management APIs
app.use('/api/torrents', isAuthenticated);
app.use('/api/files', isAuthenticated);
app.use('/status', isAuthenticated);

// Serve Files
app.use('/api/files', express.static('/downloads'));
app.use('/', getRouter(builder.getInterface()));
app.use(express.static(path.join(__dirname, 'public')));

// Management Endpoints
app.get('/api/torrents', async (req, res) => {
    try {
        const list = await qbtRequest('GET', '/api/v2/torrents/info');
        res.json(list.map(t => ({ hash: t.hash, name: t.name, progress: (t.progress * 100).toFixed(1), speed: (t.dlspeed / 1024).toFixed(1) + " KB/s", size: (t.size / 1024 / 1024 / 1024).toFixed(2) + " GB", status: t.state })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/torrents/:hash', async (req, res) => {
    try {
        await qbtRequest('POST', '/api/v2/torrents/delete', { hashes: req.params.hash, deleteFiles: 'true' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/torrents/add', async (req, res) => {
    try {
        const { magnet } = req.body;
        await qbtRequest('POST', '/api/v2/torrents/add', { urls: magnet });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/torrents/upload', upload.single('torrent'), async (req, res) => {
    try {
        const form = new FormData();
        form.append('torrents', fs.createReadStream(req.file.path));
        await qbtRequest('POST', '/api/v2/torrents/add', form, true);
        fs.unlinkSync(req.file.path);
        res.json({ success: true });
    } catch (e) { if (req.file) fs.unlinkSync(req.file.path); res.status(500).json({ error: e.message }); }
});

app.get('/status', (req, res) => {
    res.json(Array.from(activeEngines.values()).map(e => ({ name: e.name || "Initializing...", progress: e.progress, speed: (e.swarm.downloadSpeed() / 1024).toFixed(2), peers: e.swarm.wires.length })));
});

app.get('/play', (req, res) => {
    const { magnet } = req.query;
    let engine = activeEngines.get(magnet);
    if (!engine) {
        engine = torrentStream(magnet, { path: '/tmp/torrent-stream' });
        engine.progress = 0; activeEngines.set(magnet, engine);
        engine.on('ready', () => { const file = engine.files.reduce((a, b) => a.length > b.length ? a : b); engine.mainFile = file; engine.name = file.name; file.select(); });
        setInterval(() => { if (engine.mainFile) { const total = Math.ceil(engine.mainFile.length / engine.torrent.pieceLength); let dl = 0; for (let i=0; i<total; i++) if (engine.bitfield.get(i)) dl++; engine.progress = ((dl / total) * 100).toFixed(1); } }, 5000);
    }
    const serveFile = () => {
        const file = engine.mainFile;
        const range = req.headers.range && rangeParser(file.length, req.headers.range);
        res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'video/mp4');
        if (!range) { res.setHeader('Content-Length', file.length); if (req.method === 'HEAD') return res.end(); return pump(file.createReadStream(), res); }
        const { start, end } = range[0];
        res.status(206); res.setHeader('Content-Length', end - start + 1); res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
        pump(file.createReadStream({ start, end }), res);
    };
    if (engine.mainFile) serveFile(); else engine.once('ready', serveFile);
});

app.listen(7000, () => console.log('Secure Seedbox PRO running...'));
