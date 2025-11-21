# Windows OCR Binary

Windows.Media.Ocr wrapper for ThinkDrop AI - Fast, native OCR for Windows 10+

## Features

- ✅ Native Windows 10+ OCR API
- ✅ Hardware-accelerated (GPU when available)
- ✅ Fast (1-3s per screenshot)
- ✅ Privacy-first (on-device processing)
- ✅ Free (no API costs)
- ✅ Similar quality to Apple Vision Framework

## Requirements

**To build:**
- Windows 10 or later
- .NET 6.0 SDK or later ([Download](https://dotnet.microsoft.com/download))

**To run:**
- Windows 10 version 1903 (build 18362) or later
- No additional dependencies (self-contained binary)

## Building

### Option 1: Using build script (Recommended)

```batch
cd bin/windows-ocr
build.bat
```

This will:
1. Build the project
2. Create a self-contained executable
3. Copy `windows-ocr.exe` to the parent `bin` directory

### Option 2: Manual build

```batch
cd bin/windows-ocr
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
copy bin\Release\net6.0-windows10.0.19041.0\win-x64\publish\WindowsOCR.exe ..\windows-ocr.exe
```

## Usage

### Command Line

```batch
windows-ocr.exe "path\to\image.png"
```

### Output Format

```json
{
  "success": true,
  "words": [
    {
      "text": "Hello",
      "bbox": [100, 200, 150, 220],
      "confidence": 1.0
    }
  ],
  "count": 1,
  "imageSize": [1920, 1080],
  "source": "windows_ocr"
}
```

### From Node.js

```javascript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function analyzeWithWindowsOCR(imagePath) {
  const { stdout } = await execAsync(
    `"./bin/windows-ocr.exe" "${imagePath}"`
  );
  return JSON.parse(stdout);
}

// Usage
const result = await analyzeWithWindowsOCR('screenshot.png');
console.log(`Found ${result.words.length} words`);
```

## Performance

**Typical performance on modern Windows PC:**
- Small image (1920x1080): ~1-2s
- Large image (2880x1800): ~2-3s
- Very large image (3840x2160): ~3-5s

**Comparison:**
- Windows.Media.Ocr: 1-3s ✅
- Apple Vision (macOS): 2-3s ✅
- Tesseract.js: 8-15s ❌

## Supported Languages

The OCR engine automatically uses the system's display language. Supported languages include:

- English (en-US, en-GB, etc.)
- Chinese (zh-CN, zh-TW)
- Spanish (es-ES, es-MX)
- French (fr-FR)
- German (de-DE)
- Japanese (ja-JP)
- Korean (ko-KR)
- And many more...

To check available languages on your system:
```powershell
Get-WindowsCapability -Online | Where-Object Name -like 'Language.OCR*'
```

## Troubleshooting

### "OCR engine not available"

Install OCR language packs:
```powershell
# Install English OCR
Add-WindowsCapability -Online -Name "Language.OCR~~~en-US~0.0.1.0"

# Or install via Settings > Time & Language > Language > Add a language
```

### "Failed to create OCR engine"

Make sure you're running Windows 10 version 1903 or later:
```powershell
winver
```

### Build errors

Make sure .NET 6.0 SDK is installed:
```batch
dotnet --version
```

Should show `6.0.x` or later.

## Architecture

```
Node.js OCR Service
    ↓
windows-ocr.exe (C# binary)
    ↓
Windows.Media.Ocr (UWP API)
    ↓
Hardware-accelerated OCR
    ↓
JSON output with words + bounding boxes
```

## Comparison with Other Solutions

| Feature | Windows.Media.Ocr | Tesseract.js | Azure OCR |
|---------|-------------------|--------------|-----------|
| **Speed** | 1-3s ✅ | 8-15s ❌ | 1-2s ✅ |
| **Accuracy** | Excellent | Good | Excellent |
| **Privacy** | On-device ✅ | On-device ✅ | Cloud ❌ |
| **Cost** | Free ✅ | Free ✅ | Paid ❌ |
| **Platform** | Windows 10+ | All | All |
| **GPU** | Yes ✅ | No ❌ | N/A |

## License

Part of ThinkDrop AI - MIT License
