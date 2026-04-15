const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const path = require('path');
const axios = require('axios');
const http = require('http');
const torrentStream = require('torrent-stream');
const rangeParser = require('range-parser');
const pump = require('pump');
const multer = require('multer');
const fs = require('fs');

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const upload = multer({ dest: '/tmp/uploads/' });

const manifest = {
    id: 'org.myseedbox.addon.v14',
    version: '1.0.14',
    name: 'Seedbox Torrentio PRO',
    description: 'Strict Metadata & Safety Filtered Seedbox with File Management.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

const builder = new addonBuilder(manifest);
const JACKETT_URL = 'http://jackett:9117';
const JACKETT_API_KEY = process.env.JACKETT_API_KEY;
const DOMAIN = process.env.DOMAIN || 'stremiosandbox.duckdns.org';
const QBT_URL = 'http://172.21.0.3:8080';
const activeEngines = new Map();

// --- STRICT ANALYSIS ENGINE ---
function analyzeTorrent(result, meta) {
    const title = result.Title.toLowerCase();
    const cleanMetaTitle = meta.name.toLowerCase().replace(/[^a-z0-9\s]/g, '');
    const adultTerms = ['xxx', 'porn', 'adult', 'sex', 'hentai', 'brazzers', 'bangbros', 'milf', 'anal', 'hardcore', 'erotic', 'nsfw'];
    if (adultTerms.some(term => title.includes(term))) return null;
    const trashTerms = ['cam', 'hdcam', 'ts', 'telesync', 'tc', 'hd-tc', 'scr', 'screener'];
    if (trashTerms.some(term => title.split(/[\s\.]+/).includes(term))) return null;
    const metaWords = cleanMetaTitle.split(' ');
    const torrentClean = title.replace(/[^a-z0-9\s]/g, '');
    if (metaWords.length > 0 && !torrentClean.includes(metaWords[0])) return null;
    if (meta.type === 'movie' && meta.year) {
        const year = meta.year.toString();
        const foundYear = title.match(/\b(19|20)\d{2}\b/);
        if (foundYear && !title.includes(year)) return null;
    }
    if (meta.type === 'series' && meta.season && meta.episode) {
        const s = meta.season.toString().padStart(2, '0');
        const e = meta.episode.toString().padStart(2, '0');
        const pattern = new RegExp(`s${s}e${e}`, 'i');
        const altPattern = new RegExp(`${meta.season}x${e}`, 'i');
        if (!pattern.test(title) && !altPattern.test(title)) return null;
    }
    let quality = 'SD';
    if (title.includes('2160p') || title.includes('4k')) quality = '4K UHD';
    else if (title.includes('1080p')) quality = '1080p FHD';
    else if (title.includes('720p')) quality = '720p HD';
    return { quality };
}

async function searchJackett(query, meta) {
    try {
        const cats = meta.type === 'movie' ? '2000' : '5000';
        const url = `${JACKETT_URL}/api/v2.0/indexers/all/results?apikey=${JACKETT_API_KEY}&Query=${encodeURIComponent(query)}&Category=${cats}`;
        const response = await axios.get(url, { httpAgent });
        const results = response.data.Results || [];
        return results.map(r => {
            const analysis = analyzeTorrent(r, meta);
            return analysis ? { ...r, ...analysis } : null;
        }).filter(Boolean);
    } catch (err) { return []; }
}

builder.defineStreamHandler(async ({ type, id }) => {
    try {
        const parts = id.split(':');
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/${type}/${parts[0]}.json`);
        const meta = metaRes.data.meta;
        meta.season = parts[1];
        meta.episode = parts[2];
        let query = meta.name;
        if (type === 'series') query += ` S${parts[1].padStart(2, '0')}E${parts[2].padStart(2, '0')}`;
        const results = await searchJackett(query, meta);
        return {
            streams: results.map(r => ({
                name: `Seedbox ${r.quality}`,
                title: `${r.Title}\n👤 ${r.Seeders || '?'} | 💾 ${(r.Size / 1024 / 1024 / 1024).toFixed(2)} GB`,
                url: `http://${DOMAIN}/play?magnet=${encodeURIComponent(r.MagnetUri || r.Link)}`
            })).slice(0, 15)
        };
    } catch (e) { return { streams: [] }; }
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// Serve downloads folder statically for direct downloading
app.use('/api/files', express.static('/downloads'));
app.use('/', getRouter(builder.getInterface()));

// qBittorrent interaction
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
    
    if (isMultipart) {
        // data should be a FormData-like object or we use axios directly with data
        return (await axios.post(`${QBT_URL}${path}`, data, { ...config, headers: { ...config.headers, ...data.getHeaders() } })).data;
    }

    const params = new URLSearchParams();
    if (data) Object.keys(data).forEach(key => params.append(key, data[key]));
    return (await axios.post(`${QBT_URL}${path}`, params, config)).data;
}

app.get('/api/torrents', async (req, res) => {
    try {
        const list = await qbtRequest('GET', '/api/v2/torrents/info');
        res.json(list.map(t => ({
            hash: t.hash, name: t.name,
            progress: (t.progress * 100).toFixed(1),
            speed: (t.dlspeed / 1024).toFixed(1) + " KB/s",
            size: (t.size / 1024 / 1024 / 1024).toFixed(2) + " GB",
            status: t.state,
            save_path: t.save_path
        })));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/torrents/:hash', async (req, res) => {
    try {
        await qbtRequest('POST', '/api/v2/torrents/delete', { hashes: req.params.hash, deleteFiles: 'true' });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add torrent via magnet link
app.post('/api/torrents/add', async (req, res) => {
    try {
        const { magnet } = req.body;
        await qbtRequest('POST', '/api/v2/torrents/add', { urls: magnet });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add torrent via file upload
const FormData = require('form-data');
app.post('/api/torrents/upload', upload.single('torrent'), async (req, res) => {
    try {
        const form = new FormData();
        form.append('torrents', fs.createReadStream(req.file.path));
        await qbtRequest('POST', '/api/v2/torrents/add', form, true);
        fs.unlinkSync(req.file.path); // Clean up temp file
        res.json({ success: true });
    } catch (e) { 
        if (req.file) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: e.message }); 
    }
});

app.get('/status', (req, res) => {
    res.json(Array.from(activeEngines.values()).map(e => ({
        name: e.name || "Initializing...", progress: e.progress,
        speed: (e.swarm.downloadSpeed() / 1024).toFixed(2), peers: e.swarm.wires.length
    })));
});

app.get('/play', (req, res) => {
    const { magnet } = req.query;
    let engine = activeEngines.get(magnet);
    if (!engine) {
        engine = torrentStream(magnet, { path: '/tmp/torrent-stream' });
        engine.progress = 0;
        activeEngines.set(magnet, engine);
        engine.on('ready', () => {
            const file = engine.files.reduce((a, b) => a.length > b.length ? a : b);
            engine.mainFile = file; engine.name = file.name;
            file.select();
        });
        setInterval(() => {
            if (engine.mainFile) {
                const totalPieces = Math.ceil(engine.mainFile.length / engine.torrent.pieceLength);
                let downloaded = 0;
                for (let i = 0; i < totalPieces; i++) { if (engine.bitfield.get(i)) downloaded++; }
                engine.progress = ((downloaded / totalPieces) * 100).toFixed(1);
            }
        }, 5000);
    }
    const serveFile = () => {
        const file = engine.mainFile;
        const range = req.headers.range && rangeParser(file.length, req.headers.range);
        res.setHeader('Accept-Ranges', 'bytes'); res.setHeader('Content-Type', 'video/mp4');
        if (!range) {
            res.setHeader('Content-Length', file.length);
            if (req.method === 'HEAD') return res.end();
            return pump(file.createReadStream(), res);
        }
        const { start, end } = range[0];
        res.status(206);
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
        pump(file.createReadStream({ start, end }), res);
    };
    if (engine.mainFile) serveFile(); else engine.once('ready', serveFile);
});

app.listen(7000, () => console.log('Seedbox PRO v1.0.14 running...'));
