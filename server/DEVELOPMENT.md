# Toca Ficha Dr. — Development Guide

## Prerequisites

- **Node.js** 18+ (for build tools)
- **Python** 3.11+ (for backend)
- **Google Chrome** 114+ (for testing)
- **Git**

## Repository Structure

```
tocafichadr-extension/
├── backend/              # Flask API (Mac Mini)
│   ├── emr_automation/   # Core automation logic
│   ├── data/             # SQLite databases
│   ├── logs/             # Application logs
│   ├── venv/             # Python virtual environment
│   ├── requirements.txt  # Python dependencies
│   └── run_dashboard.py  # Entry point
├── sidepanel/            # Side panel UI
│   ├── sidepanel.html
│   ├── sidepanel.js
│   └── sidepanel.css
├── popup/                # Popup UI
│   ├── popup.html
│   ├── popup.js
│   └── popup.css
├── content/              # Content scripts
│   ├── dom-engine.js
│   ├── audio-capture.js
│   ├── cid.js
│   ├── api-client.js
│   ├── vad-helpers.js
│   └── bridge.js
├── background/           # Service worker
│   └── service-worker.bundle.js
├── offscreen/            # Offscreen document
│   ├── offscreen.html
│   └── offscreen.js
├── shared/               # Shared utilities
│   └── console-shipper.js
├── icons/                # Extension icons
├── manifest.json         # Extension manifest
└── docs/                 # Documentation
```

## Local Development Setup

### 1. Clone Repository

```bash
cd ~/Dev
git clone <repo-url> tocafichadr-extension
cd tocafichadr-extension
```

### 2. Backend Setup

```bash
cd backend

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure environment
cp .env.example .env
# Edit .env:
# - CLERK_SECRET_KEY
# - OPENAI_API_KEY
# - GROQ_API_KEY (optional, for faster STT)
# - STRIPE_SECRET_KEY

# Run development server
python run_dashboard.py
```

**Backend will be available at:** http://localhost:5050

### 3. Extension Setup

```bash
# Install Node dependencies (for build tools)
npm ci

# Build extension
npm run build

# Or for development (watch mode)
npm run dev
```

### 4. Load Extension in Chrome

1. Open Chrome → chrome://extensions
2. Enable "Developer mode" (top right)
3. Click "Load unpacked"
4. Select the `tocafichadr-extension` folder
5. Extension appears in toolbar

## Development Workflow

### Testing Changes

**Backend changes:**
```bash
cd backend
source venv/bin/activate
python run_dashboard.py
# Server auto-reloads on file changes
```

**Extension changes:**
```bash
# After modifying content scripts or popup:
npm run build

# Then reload extension in chrome://extensions
# Click refresh icon on extension card
```

**Testing on G-Hosp:**
1. Navigate to https://prbentogoncalves.g-hosp.com.br
2. Log in with test credentials
3. Open extension side panel (click icon)
4. Test recording, SOAP generation, CID suggestion

### Debugging

**Extension debugging:**
1. Right-click extension icon → "Inspect popup" (for popup)
2. chrome://extensions → Click "service worker" link (for SW)
3. On G-Hosp page → F12 → Sources → Content scripts (for content scripts)

**Backend debugging:**
```bash
# Run with debug logging
FLASK_ENV=development python run_dashboard.py

# Or use Python debugger
python -m pdb run_dashboard.py
```

## Building for Production

```bash
# Build optimized extension
npm run build

# Create ZIP for Web Store
npm run package

# Output: dist/tocafichadr-v{version}.zip
```

## Code Structure Guidelines

### Content Scripts

**Adding a new automation:**
```javascript
// In content/dom-engine.js
async function myNewAutomation(data) {
    // 1. Find target element
    const element = document.querySelector('#my-field');
    
    // 2. Fill data
    element.value = data.value;
    
    // 3. Trigger events
    element.dispatchEvent(new Event('input'));
    
    // 4. Click button if needed
    document.querySelector('#save-btn').click();
}
```

### Backend Routes

**Adding a new API endpoint:**
```python
# In backend/emr_automation/extension_api.py
from flask import Blueprint

api = Blueprint('api', __name__)

@api.route('/my-feature', methods=['POST'])
def my_feature():
    data = request.json
    # Implementation
    return jsonify({"success": True})
```

## Testing

### Unit Tests

```bash
cd backend
source venv/bin/activate
pytest
```

### Manual Testing Checklist

- [ ] Extension loads without errors
- [ ] Popup opens and shows login
- [ ] Clerk authentication works
- [ ] Side panel opens on G-Hosp
- [ ] Audio recording captures sound
- [ ] Transcription returns text
- [ ] SOAP note generates correctly
- [ ] CID suggestion appears
- [ ] SOAP injects into G-Hosp form
- [ ] Template selection works
- [ ] Discharge workflow completes
- [ ] Usage stats update

## Environment Variables Reference

### Backend (.env)

| Variable | Required | Description |
|----------|----------|-------------|
| CLERK_SECRET_KEY | Yes | Clerk API key |
| OPENAI_API_KEY | Yes | OpenAI API access |
| GROQ_API_KEY | No | Groq API (faster STT) |
| STRIPE_SECRET_KEY | Yes | Stripe secret |
| STRIPE_WEBHOOK_SECRET | Yes | Stripe webhook |
| FLASK_ENV | No | development/production |
| FLASK_PORT | No | Default: 5050 |

## Common Issues

### Extension Not Loading
- Check manifest.json is valid JSON
- Ensure all referenced files exist
- Check Chrome console for errors

### Backend Connection Failed
- Verify backend is running on port 5050
- Check CORS settings in backend
- Ensure correct API URL in extension

### Selectors Not Working
- G-Hosp may have updated their UI
- Check selector in browser DevTools
- Update selector in backend config

### Audio Not Recording
- Check microphone permissions in Chrome
- Ensure HTTPS context (required for WebRTC)
- Check offscreen document is created

## Git Workflow

```bash
# Create feature branch
git checkout -b feature/my-feature

# Make changes
git add .
git commit -m "feat: add my feature"

# Push and create PR
git push -u origin feature/my-feature
```

## Release Process

1. Update version in manifest.json
2. Update CHANGELOG.md
3. Build extension: `npm run build`
4. Package: `npm run package`
5. Upload to Chrome Web Store Developer Dashboard
6. Submit for review
7. Update backend (if API changes)

## Code Style

### JavaScript
- Use ES6+ features
- Prefer async/await over callbacks
- Use const/let, avoid var
- Document functions with JSDoc

### Python
- Follow PEP 8
- Use type hints
- Document with docstrings
- Maximum line length: 100
