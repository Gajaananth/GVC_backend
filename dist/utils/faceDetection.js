"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateFacePhoto = validateFacePhoto;
exports.hasFace = hasFace;
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
let modelsLoaded = false;
let initFailed = false;
let faceapi = null;
let tf = null;
const MODEL_URL = path_1.default.join(__dirname, '../../node_modules/@vladmandic/face-api/model');
async function loadFaceDetectionModels() {
    if (modelsLoaded)
        return true;
    if (initFailed)
        return false;
    try {
        tf = await Promise.resolve().then(() => __importStar(require('@tensorflow/tfjs')));
        await tf.ready();
        faceapi = await Promise.resolve().then(() => __importStar(require('@vladmandic/face-api/dist/face-api.esm.js')));
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_URL);
        modelsLoaded = true;
        return true;
    }
    catch (error) {
        initFailed = true;
        console.warn('Face detection models unavailable (uploads will skip auto face check):', error instanceof Error ? error.message : error);
        return false;
    }
}
async function validateFacePhoto(imageBuffer) {
    const ready = await loadFaceDetectionModels();
    if (!ready || !faceapi || !tf) {
        return { valid: true };
    }
    try {
        const image = (0, sharp_1.default)(imageBuffer).removeAlpha();
        const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
        const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
        try {
            const detections = await faceapi.detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options());
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
            const stats = await (0, sharp_1.default)(imageBuffer).stats();
            const brightness = (stats.channels[0].mean + stats.channels[1].mean + stats.channels[2].mean) / 3;
            if (brightness < 40 || brightness > 240) {
                return { valid: false, reason: 'Please upload a clear customer face photo.' };
            }
            return { valid: true };
        }
        finally {
            tf.dispose(tensor);
        }
    }
    catch (error) {
        console.error('Error during face validation:', error);
        return { valid: true };
    }
}
async function hasFace(imageBuffer) {
    const result = await validateFacePhoto(imageBuffer);
    return result.valid;
}
//# sourceMappingURL=faceDetection.js.map