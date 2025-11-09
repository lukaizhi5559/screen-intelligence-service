# 🎯 Screen Intelligence MCP Service

Fast, local, semantic screen understanding with visual overlays for ThinkDrop AI.

## Features

- **🔍 Screen Analysis**: Query UI elements using accessibility APIs
- **🎨 Visual Overlays**: Show what the AI "sees" with highlights and guides
- **🖱️ UI Automation**: Click, type, and interact with applications
- **📊 Discovery Mode**: Inspect all UI elements like Playwright Inspector
- **⚡ Fast**: <100ms screen analysis (vs 3-4s with vision models)

## Architecture

```
Screen Intelligence MCP (Port 3008)
├── Accessibility Adapter (AX/UIA/AT-SPI)
├── Action Engine (@nut-tree/nut-js)
├── Overlay Manager (Visual feedback)
└── OpenCV Sidecar (Phase 4 - for canvas/games)
```

## Installation

```bash
cd mcp-services/screen-intelligence-service
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```bash
cp .env.example .env
```

## Usage

### Start the service

```bash
npm start
```

### Development mode (with auto-reload)

```bash
npm run dev
```

## API Endpoints

### Health Check
```
GET /service.health
```

### Capabilities
```
GET /service.capabilities
```

### Screen Analysis
```
POST /screen/describe
Body: {
  "showOverlay": true,
  "includeHidden": false
}
```

### Query Elements
```
POST /screen/query
Body: {
  "query": "Send button",
  "role": "button",
  "highlight": true
}
```

### Click Action
```
POST /screen/action/click
Body: {
  "target": { "x": 100, "y": 200 },
  "showGuide": true
}
```

### Type Action
```
POST /screen/action/type
Body: {
  "target": { "x": 100, "y": 200 },
  "text": "Hello World",
  "showConfirmation": true
}
```

### Show Overlay
```
POST /screen/overlay/highlight
Body: {
  "element": { "bounds": {...}, "label": "Send" },
  "duration": 3000
}
```

### Show Toast
```
POST /screen/overlay/toast
Body: {
  "message": "Action completed!",
  "type": "success",
  "duration": 3000
}
```

### Clear Overlays
```
POST /screen/overlay/clear
```

## Platform Support

### macOS ✅ (Phase 2 Complete)
- **Adapter**: `EnhancedMacOSAccessibilityAdapter`
- **Technology**: AppleScript + Accessibility API (AX)
- **Features**: Element caching, query methods, confidence scoring
- **Requirements**: Accessibility permissions
- **Grant permissions**: System Preferences > Security & Privacy > Privacy > Accessibility

### Windows 🚧 (TODO - Implementation Guide Available)
- **Adapter**: `WindowsUIAAdapter` (placeholder)
- **Technology**: UI Automation (UIA)
- **Implementation Options**:
  - node-ffi-napi for native COM APIs
  - edge-js for .NET UIA libraries
  - PowerShell bridge
- **See**: `PLATFORM_IMPLEMENTATION_GUIDE.md` for detailed instructions
- **Placeholder**: `src/adapters/accessibility/windows.js`

### Linux 🚧 (TODO - Implementation Guide Available)
- **Adapter**: `LinuxATSPIAdapter` (placeholder)
- **Technology**: AT-SPI (Assistive Technology Service Provider Interface)
- **Implementation Options**:
  - node-dbus for D-Bus communication
  - Python bridge to pyatspi2
  - X11 automation fallback
- **See**: `PLATFORM_IMPLEMENTATION_GUIDE.md` for detailed instructions
- **Placeholder**: `src/adapters/accessibility/linux.js`

### Development/Testing ✅
- **Adapter**: `MockAccessibilityAdapter`
- **Purpose**: Cross-platform development and testing
- **Auto-fallback**: Used when platform adapter unavailable

## Performance Targets

| Operation | Target | Vision Service |
|-----------|--------|----------------|
| Screen describe | <100ms | 3-4s |
| Element query | <50ms | N/A |
| Overlay show | <20ms | N/A |
| Full workflow | <500ms | 5-8s |

## Visual Feedback

### Color Scheme
- 🟢 **Green** (≥0.9): High confidence
- 🔵 **Blue** (0.8-0.9): Good confidence  
- 🟡 **Yellow** (0.6-0.8): Uncertain
- 🔴 **Red** (<0.6): Low confidence

### Overlay Types
1. **Discovery Mode**: Show all detected elements
2. **Highlight**: Focus on specific elements
3. **Guide**: Step-by-step workflow instructions
4. **Toast**: Notification messages

## Development

### Run tests
```bash
npm test
```

### Lint
```bash
npm run lint
```

### Format
```bash
npm run format
```

## Integration with ThinkDrop AI

The service will be registered in the main app's MCP registry:

```javascript
// In main app
const screenIntelligence = {
  name: 'screen-intelligence',
  url: 'http://localhost:3008',
  apiKey: process.env.SCREEN_INTELLIGENCE_API_KEY,
  enabled: true
};
```

## Roadmap

### Phase 1: Core Service ✅
- [x] MCP server setup
- [x] Basic routes
- [x] Health checks
- [x] Mock adapter

### Phase 2: Accessibility (In Progress)
- [x] macOS AX adapter (basic)
- [ ] Windows UIA adapter
- [ ] Enhanced element queries
- [ ] Coordinate conversion

### Phase 3: Overlay System
- [ ] Electron overlay window
- [ ] Highlight rendering
- [ ] Discovery mode UI
- [ ] Toast notifications

### Phase 4: OpenCV Fallback
- [ ] Python sidecar
- [ ] Template matching
- [ ] Change detection
- [ ] JSON bridge

### Phase 5: Actions
- [x] nut.js integration (basic)
- [ ] Verification
- [ ] Guide mode
- [ ] Multi-step workflows

### Phase 6: Integration
- [ ] Update parseIntent.cjs
- [ ] New screen-query node
- [ ] Fallback to vision service
- [ ] End-to-end testing

## License

MIT
