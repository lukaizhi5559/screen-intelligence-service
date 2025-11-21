using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Windows.Media.Ocr;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;
using System.Text.Json;

namespace WindowsOCR
{
    /// <summary>
    /// Windows.Media.Ocr wrapper for ThinkDrop AI
    /// Extracts text with bounding boxes from images
    /// Output: JSON with words array
    /// </summary>
    class Program
    {
        static async Task<int> Main(string[] args)
        {
            try
            {
                // Check command line arguments
                if (args.Length == 0)
                {
                    var error = new { error = "Usage: windows-ocr.exe <image-path>" };
                    Console.WriteLine(JsonSerializer.Serialize(error));
                    return 1;
                }

                string imagePath = args[0];

                // Validate image path
                if (!File.Exists(imagePath))
                {
                    var error = new { error = $"Image file not found: {imagePath}" };
                    Console.WriteLine(JsonSerializer.Serialize(error));
                    return 1;
                }

                // Load image
                StorageFile file = await StorageFile.GetFileFromPathAsync(Path.GetFullPath(imagePath));
                
                using (IRandomAccessStream stream = await file.OpenAsync(FileAccessMode.Read))
                {
                    // Decode image
                    BitmapDecoder decoder = await BitmapDecoder.CreateAsync(stream);
                    SoftwareBitmap bitmap = await decoder.GetSoftwareBitmapAsync();
                    
                    // Convert to BGRA8 format if needed (required by OCR engine)
                    if (bitmap.BitmapPixelFormat != BitmapPixelFormat.Bgra8 ||
                        bitmap.BitmapAlphaMode != BitmapAlphaMode.Premultiplied)
                    {
                        bitmap = SoftwareBitmap.Convert(bitmap, BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
                    }

                    // Create OCR engine (uses system language)
                    OcrEngine ocrEngine = OcrEngine.TryCreateFromUserProfileLanguages();
                    
                    if (ocrEngine == null)
                    {
                        // Fallback to English if system language not supported
                        var englishLanguage = new Windows.Globalization.Language("en-US");
                        ocrEngine = OcrEngine.TryCreateFromLanguage(englishLanguage);
                    }

                    if (ocrEngine == null)
                    {
                        var error = new { error = "Failed to create OCR engine. No supported languages found." };
                        Console.WriteLine(JsonSerializer.Serialize(error));
                        return 1;
                    }

                    // Perform OCR
                    OcrResult ocrResult = await ocrEngine.RecognizeAsync(bitmap);

                    // Convert to JSON format
                    var words = new List<object>();
                    
                    foreach (var line in ocrResult.Lines)
                    {
                        foreach (var word in line.Words)
                        {
                            // Windows OCR provides bounding rect
                            var rect = word.BoundingRect;
                            
                            words.Add(new
                            {
                                text = word.Text,
                                bbox = new[]
                                {
                                    (int)rect.Left,
                                    (int)rect.Top,
                                    (int)rect.Right,
                                    (int)rect.Bottom
                                },
                                // Windows OCR doesn't provide confidence scores
                                // Use 1.0 for all words (they're already filtered by the engine)
                                confidence = 1.0
                            });
                        }
                    }

                    // Build result
                    var result = new
                    {
                        success = true,
                        words = words,
                        count = words.Count,
                        imageSize = new[] { (int)bitmap.PixelWidth, (int)bitmap.PixelHeight },
                        source = "windows_ocr",
                        language = ocrResult.TextAngle.HasValue ? "detected" : "unknown"
                    };

                    // Output JSON
                    var options = new JsonSerializerOptions
                    {
                        WriteIndented = true
                    };
                    Console.WriteLine(JsonSerializer.Serialize(result, options));
                    
                    return 0;
                }
            }
            catch (Exception ex)
            {
                var error = new { error = $"OCR failed: {ex.Message}" };
                Console.WriteLine(JsonSerializer.Serialize(error));
                return 1;
            }
        }
    }
}
