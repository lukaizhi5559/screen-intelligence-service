# YOLOv8-UI Model Setup

This directory should contain the YOLOv8 ONNX model for UI element detection.

## Quick Start: Download Pre-trained Model

### Option 1: Web Form UI Detection (Recommended)
```bash
# Download from HuggingFace
wget https://huggingface.co/foduucom/web-form-ui-field-detection/resolve/main/best.onnx -O yolov8-ui.onnx
```

This model detects web form UI elements like:
- Text inputs
- Buttons
- Checkboxes
- Radio buttons
- Dropdowns
- Labels

### Option 2: Export Your Own YOLOv8 Model

If you want to train on your own UI screenshots:

```bash
# Install ultralytics
pip install ultralytics

# Export YOLOv8 to ONNX
python -c "
from ultralytics import YOLO

# Load a pretrained model or your fine-tuned model
model = YOLO('yolov8n.pt')  # or 'path/to/your/trained/model.pt'

# Export to ONNX
model.export(format='onnx', imgsz=640)
"

# Move the exported model
mv yolov8n.onnx yolov8-ui.onnx
```

### Option 3: Fine-tune on UI Screenshots

Train YOLOv8 on the VNIS dataset (21 mobile UI element types):

```python
from ultralytics import YOLO

# Download VNIS dataset from: https://github.com/sbunian/VINS

# Train
model = YOLO("yolov8n.pt")
results = model.train(
    data="vnis.yaml",  # Your dataset config
    epochs=20,
    imgsz=640,
    device="cpu",  # or "cuda" if GPU available
    batch=16
)

# Export to ONNX
model.export(format='onnx')
```

## Model Requirements

- **Format**: ONNX
- **Input size**: 640x640 (default YOLOv8)
- **Input format**: Float32, shape [1, 3, 640, 640], RGB, normalized [0, 1]
- **Output format**: [1, 84, 8400] for 80 classes (or [1, 4+num_classes, 8400])

## Supported UI Element Classes

The service expects these UI element types:
- button
- input
- text
- icon
- checkbox
- radio
- dropdown
- link
- image
- label
- menu
- toolbar
- dialog
- panel
- card
- list
- table
- form

You can customize the class names in `yolov8DetectionService.js`.

## Performance

- **YOLOv8n (nano)**: ~6MB, 50-100ms inference on CPU
- **YOLOv8s (small)**: ~22MB, 100-150ms inference on CPU
- **YOLOv8m (medium)**: ~50MB, 150-250ms inference on CPU

For real-time screen analysis, we recommend **YOLOv8n** for the best speed/accuracy tradeoff.

## Troubleshooting

### Model not found error
```
⚠️  [YOLOv8] Model not found at /path/to/models/yolov8-ui.onnx
```

**Solution**: Download or export a model and place it in this directory as `yolov8-ui.onnx`.

### Wrong output shape
If you get dimension mismatch errors, ensure your model:
1. Was exported with `imgsz=640`
2. Uses the correct number of classes
3. Is in ONNX format (not PyTorch .pt)

### Slow inference
- Use YOLOv8n instead of larger variants
- Enable GPU if available: Change `executionProviders: ['cpu']` to `['cuda']` in the service
- Reduce input size (but may hurt accuracy)

## Resources

- [Ultralytics YOLOv8 Docs](https://docs.ultralytics.com/)
- [YOLOv8 ONNX Export Guide](https://docs.ultralytics.com/modes/export/)
- [VNIS Dataset](https://github.com/sbunian/VINS)
- [Web Form UI Detection Model](https://huggingface.co/foduucom/web-form-ui-field-detection)
