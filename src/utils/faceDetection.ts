import * as tf from '@tensorflow/tfjs';
import * as faceapi from '@vladmandic/face-api';
import path from 'path';
import sharp from 'sharp';

// Load models
const MODEL_URL = path.join(__dirname, '../../node_modules/@vladmandic/face-api/model');

let modelsLoaded = false;

export async function loadFaceDetectionModels() {
  if (modelsLoaded) return;
  // Initialize tfjs
  await tf.ready();
  // Load the SSD Mobilenetv1 model for face detection
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_URL);
  modelsLoaded = true;
}

export async function hasFace(imageBuffer: Buffer): Promise<boolean> {
  await loadFaceDetectionModels();

  try {
    const { data, info } = await sharp(imageBuffer)
      .removeAlpha() // Ensure 3 channels (RGB)
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Create tensor from raw pixels
    const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');

    try {
      const detections = await faceapi.detectAllFaces(tensor as any, new faceapi.SsdMobilenetv1Options());
      return detections.length > 0;
    } finally {
      tf.dispose(tensor);
    }
  } catch (error) {
    console.error('Error during face detection:', error);
    return false;
  }
}
