/**
 * OCR Service — Google Cloud Vision REST API
 * Expo Go compatible: pure HTTP, no native modules.
 *
 * Requires: EXPO_PUBLIC_GOOGLE_VISION_KEY in .env
 * ⚠ Security note: API key is embedded in JS bundle and visible in network logs.
 *   Acceptable for MVP demo; restrict key to this app's package in Google Cloud Console.
 *
 * Strategy:
 *   1. Receive a cropped image URI (region below barcode)
 *   2. Check file size — guard against Cloud Vision's 10 MB base64 limit
 *   3. Convert to base64 and POST to TEXT_DETECTION endpoint
 *   4. Return the extracted text string
 */

import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';

const VISION_ENDPOINT = 'https://vision.googleapis.com/v1/images:annotate';
// Cloud Vision hard limit is 10 MB of base64 data (~7.5 MB raw image).
// We enforce 6 MB to leave margin.
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

export async function extractTextFromImage(imageUri: string): Promise<string> {
  const apiKey = process.env.EXPO_PUBLIC_GOOGLE_VISION_KEY;

  if (!apiKey || apiKey === 'YOUR_KEY_HERE') {
    throw new Error(
      'Missing EXPO_PUBLIC_GOOGLE_VISION_KEY. Add your Google Cloud Vision API key to .env.'
    );
  }

  // ── Size guard ───────────────────────────────────────────────────────────
  let uriToSend = imageUri;
  const info = await FileSystem.getInfoAsync(imageUri);

  if (info.exists && 'size' in info && (info as { size: number }).size > MAX_IMAGE_BYTES) {
    // Resize down: reduce to 50% quality which typically drops under 6 MB
    const resized = await ImageManipulator.manipulateAsync(
      imageUri,
      [{ resize: { width: 800 } }],
      { compress: 0.7, format: ImageManipulator.SaveFormat.JPEG }
    );
    uriToSend = resized.uri;
  }

  // ── Read as base64 ────────────────────────────────────────────────────────
  const base64 = await FileSystem.readAsStringAsync(uriToSend, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const body = {
    requests: [
      {
        image: { content: base64 },
        features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
      },
    ],
  };

  // ── POST to Vision API ────────────────────────────────────────────────────
  const response = await fetch(`${VISION_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloud Vision API error ${response.status}: ${errorText}`);
  }

  const json = await response.json();
  const fullText: string =
    json?.responses?.[0]?.fullTextAnnotation?.text ?? '';

  return fullText.trim();
}
