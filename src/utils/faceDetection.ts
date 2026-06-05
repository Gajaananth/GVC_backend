import path from 'path';
import sharp from 'sharp';

type FaceApiModule = typeof import('@vladmandic/face-api');
type TfModule = typeof import('@tensorflow/tfjs');

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

    // Use ESM build — avoids hard dependency on @tensorflow/tfjs-node at startup
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

/**
 * Returns true if a face is detected, or true when ML is unavailable (server still runs on Render).
 */
export async function hasFace(imageBuffer: Buffer): Promise<boolean> {
  const ready = await loadFaceDetectionModels();
  if (!ready || !faceapi || !tf) {
    return true;
  }

  try {
    const { data, info } = await sharp(imageBuffer)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');

    try {
      const detections = await faceapi.detectAllFaces(
        tensor as Parameters<typeof faceapi.detectAllFaces>[0],
        new faceapi.SsdMobilenetv1Options()
      );
      return detections.length > 0;
    } finally {
      tf.dispose(tensor);
    }
  } catch (error) {
    console.error('Error during face detection:', error);
    return true;
  }
}
