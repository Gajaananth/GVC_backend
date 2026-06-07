import path from 'path';
import sharp from 'sharp';

type FaceApiModule = typeof import('@vladmandic/face-api');
type TfModule = typeof import('@tensorflow/tfjs');

export interface FaceValidationResult {
  valid: boolean;
  reason?: string;
}

let modelsLoaded = false;
let initFailed = false;
let faceapi: FaceApiModule | null = null;
let tf: TfModule | null = null;

const MODEL_URL = path.join(__dirname, '../../node_modules/@vladmandic/face-api/model');

async function loadFaceDetectionModels(): Promise<boolean> {
  if (modelsLoaded) return true;
  if (initFailed) return false;

  try {
    tf = await import('@tensorflow/tfjs');
    await tf.ready();

    faceapi = await import('@vladmandic/face-api/dist/face-api.esm.js') as FaceApiModule;
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_URL);
    modelsLoaded = true;
    return true;
  } catch (error) {
    initFailed = true;
    console.warn(
      'Face detection models unavailable (uploads will skip auto face check):',
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

export async function validateFacePhoto(imageBuffer: Buffer): Promise<FaceValidationResult> {
  const ready = await loadFaceDetectionModels();
  if (!ready || !faceapi || !tf) {
    return { valid: true };
  }

  try {
    const image = sharp(imageBuffer).removeAlpha();
    const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
    const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');

    try {
      const detections = await faceapi.detectAllFaces(
        tensor as Parameters<typeof faceapi.detectAllFaces>[0],
        new faceapi.SsdMobilenetv1Options()
      );

      if (detections.length === 0) {
        return { valid: false, reason: 'Please upload a clear customer face photo.' };
      }
      if (detections.length > 1) {
        return { valid: false, reason: 'Please upload a clear customer face photo with exactly one face.' };
      }

      const detection = detections[0];
      const box = detection.box;
      const imageArea = info.width * info.height;
      const faceArea = box.width * box.height;
      const minFaceAreaRatio = 0.03;
      if (faceArea / imageArea < minFaceAreaRatio) {
        return { valid: false, reason: 'Please upload a clear customer face photo.' };
      }
      if (box.x < info.width * 0.05 || box.y < info.height * 0.05 || box.x + box.width > info.width * 0.95 || box.y + box.height > info.height * 0.95) {
        return { valid: false, reason: 'Please upload a clear customer face photo.' };
      }

      const stats = await sharp(imageBuffer).stats();
      const brightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
      if (brightness < 40 || brightness > 240) {
        return { valid: false, reason: 'Please upload a clear customer face photo.' };
      }

      return { valid: true };
    } finally {
      tf.dispose(tensor);
    }
  } catch (error) {
    console.error('Error during face validation:', error);
    return { valid: true };
  }
}

export async function hasFace(imageBuffer: Buffer): Promise<boolean> {
  const result = await validateFacePhoto(imageBuffer);
  return result.valid;
}
