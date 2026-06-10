# Toca Ficha Dr. — Deployment Guide

## Overview

Toca Ficha Dr. has two deployment targets:
1. **Chrome Web Store** — Extension distribution
2. **Mac Mini** — Backend API hosting

## Deployment Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     PRODUCTION ENVIRONMENT                   │
│                                                             │
│  ┌─────────────────────┐    ┌─────────────────────────────┐│
│  │   Chrome Web Store   │    │        Mac Mini             ││
│  │  (Extension Host)   │    │  ┌─────────────────────┐    ││
│  │                     │    │  │   Flask Backend     │    ││
│  │  tocafichadr-v3.    │◄───┼──│   Port 5051         │    ││
│  │      5.0.zip        │    │  └─────────────────────┘    ││
│  └─────────────────────┘    │            │                 ││
│                             │    ┌───────┴───────┐         ││
│                             │    │               │         ││
│                             │ ┌──▼──┐       ┌───▼──┐      ││
│                             │ │SQLite│       │Cloud-│      ││
│                             │ │      │       │flare │      ││
│                             │ └──┬──┘       │Tunnel│      ││
│                             │    └───────────┴──────┘      ││
│                             └──────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

## Chrome Web Store Deployment

### Prerequisites

- Chrome Web Store Developer account ($5 one-time fee)
- Extension ZIP file (`./scripts/build-package.sh`)
- Store listing assets (screenshots, description)
- Privacy policy URL

### Build and Package

```bash
# 1. Update version in manifest.json
# Format: "version": "3.8.0"

# 2. Build optimized extension
npm run build

# 3. Create ZIP for Web Store
./scripts/build-package.sh

# Output: tocafichadr-v3.8.0.zip
```

### Upload to Web Store

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Click "New Item"
3. Upload `tocafichadr-v3.8.0.zip`
4. Fill in store listing:
   - **Title:** Toca Ficha Dr. — EMR Automation
   - **Description:** (from STORE_LISTING.md)
   - **Category:** Productivity
   - **Language:** Portuguese (Brazil)
5. Upload screenshots (1280x800 or 640x400)
6. Add privacy policy link
7. Submit for review

**Review time:** 1-3 business days

### Update Existing Extension

```bash
# 1. Increment version in manifest.json
# 2. Build and package
npm run build
./scripts/build-package.sh

# 3. Upload new version in Developer Dashboard
# 4. Submit for review
```

## Backend Deployment (Mac Mini)

### Initial Setup

```bash
# 1. Ensure Python 3.11+ is installed
python3 --version

# 2. Navigate to backend
cd ~/Dev/tocafichadr-extension/backend

# 3. Create virtual environment (if not exists)
python3 -m venv venv
source venv/bin/activate

# 4. Install dependencies
pip install -r requirements.txt

# 5. Configure environment
cp .env.example .env
# Edit .env with production values
```

### Launchd Configuration

File: `~/Library/LaunchAgents/com.tocafichadr.cloud-api.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tocafichadr.cloud-api</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Users/christianoliveira/Dev/tocafichadr-extension/backend/venv/bin/python</string>
        <string>/Users/christianoliveira/Dev/tocafichadr-extension/backend/run_dashboard.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/Users/christianoliveira/Dev/tocafichadr-extension/backend</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/christianoliveira/Dev/tocafichadr-extension/backend/logs/launchd-out.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/christianoliveira/Dev/tocafichadr-extension/backend/logs/launchd-err.log</string>
</dict>
</plist>
```

### Service Management

```bash
# Load service (first time)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tocafichadr.cloud-api.plist

# Start
launchctl kickstart -k gui/$(id -u)/com.tocafichadr.cloud-api

# Stop
launchctl bootout gui/$(id -u)/com.tocafichadr.cloud-api

# Restart
launchctl kickstart -k gui/$(id -u)/com.tocafichadr.cloud-api

# Check status
launchctl list | grep com.tocafichadr

# View logs
tail -f ~/Dev/tocafichadr-extension/backend/logs/launchd-err.log
```

### Cloudflare Tunnel

File: `~/Library/LaunchAgents/com.tocafichadr.named-tunnel.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.tocafichadr.named-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/cloudflared</string>
        <string>tunnel</string>
        <string>--config</string>
        <string>/Users/christianoliveira/.cloudflared/config.yml</string>
        <string>run</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

## Database Migrations

### SQLite Schema Updates

```bash
cd ~/Dev/tocafichadr-extension/backend

# Backup database
cp data/usage.db data/usage.db.bak

# Run migration script
python scripts/migrate_add_clerk_user_id.py

# Verify
sqlite3 data/usage.db ".schema users"
```

## Environment Variables (Production)

| Variable | Value | Source |
|----------|-------|--------|
| CLERK_SECRET_KEY | sk_live_... | Clerk Dashboard |
| OPENAI_API_KEY | sk-... | OpenAI Dashboard |
| GROQ_API_KEY | gsk_... | Groq Dashboard |
| STRIPE_SECRET_KEY | sk_live_... | Stripe Dashboard |
| STRIPE_WEBHOOK_SECRET | whsec_... | Stripe Dashboard |
| FLASK_ENV | production | — |

## Monitoring

### Health Checks

```bash
# Backend health
curl http://localhost:5051/api/health

# Extension health (from Chrome console)
chrome.runtime.sendMessage({type: 'HEALTH_CHECK'})
```

### Log Monitoring

```bash
# Real-time backend logs
tail -f ~/Dev/tocafichadr-extension/backend/logs/launchd-err.log

# Extension logs (Chrome DevTools)
# Service Worker → Console
```

## Rollback Procedure

### Extension Rollback

```bash
# 1. Revert manifest version
git checkout HEAD~1 -- manifest.json

# 2. Rebuild
npm run build
./scripts/build-package.sh

# 3. Upload previous version to Web Store
```

### Backend Rollback

```bash
# 1. Stop service
launchctl bootout gui/$(id -u)/com.tocafichadr.cloud-api

# 2. Revert code
cd ~/Dev/tocafichadr-extension
git reset --hard HEAD~1

# 3. Restart service
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.tocafichadr.cloud-api.plist
```

## Security Checklist

- [ ] Production .env uses live API keys (not test)
- [ ] Clerk webhook secret is configured
- [ ] Stripe webhook secret is configured
- [ ] CORS only allows extension origins
- [ ] No debug mode in production
- [ ] Cloudflare Tunnel is running
- [ ] Auto-start on boot is configured
- [ ] Extension CSP is restrictive
- [ ] No patient data in logs

## Troubleshooting

### Backend Won't Start
```bash
# Check logs
tail -n 50 ~/Dev/tocafichadr-extension/backend/logs/launchd-err.log

# Test manually
cd ~/Dev/tocafichadr-extension/backend
source venv/bin/activate
python run_dashboard.py
```

### Extension Can't Connect to Backend
- Verify backend URL in extension settings
- Check CORS configuration
- Ensure Cloudflare Tunnel is running
- Test backend directly: curl http://localhost:5051/api/health
