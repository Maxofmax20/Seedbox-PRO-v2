# 🚀 Seedbox PRO v2.0

A high-performance, private seedbox and media server stack. Integrated with Stremio, Jellyfin, and Jackett.

## 💎 Features
- **Stremio Integration**: Stream torrents directly to your Stremio player.
- **PRO Dashboard**: Modern Web UI to manage downloads, upload .torrent files, and download media.
- **Smart Filtering**: Automatically blocks adult content and low-quality CAM/TS recordings.
- **Reverse Proxy**: Built-in DuckDNS and Caddy support for a clean domain (no ports needed).
- **Metadata Analysis**: Ensures you get the exact movie or episode you requested.

## 🛠️ Setup
1. Clone this repo.
2. Copy `.env.example` to `.env` and fill in your keys.
3. Run `docker-compose up -d --build`.
4. Access your dashboard at your configured domain.

## 📦 Stack
- **qBittorrent**: Core downloader.
- **Jellyfin**: Media streaming server.
- **Jackett**: Torrent indexer API.
- **Cloudflare Tunnel**: Secure firewall bypass.
- **DuckDNS**: Dynamic DNS.
- **Custom Node.js Addon**: Stremio provider and management dashboard.

