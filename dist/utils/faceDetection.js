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
        // Use ESM build — avoids hard dependency on @tensorflow/tfjs-node at startup
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
/**
 * Returns true if a face is detected, or true when ML is unavailable (server still runs on Render).
 */
async function hasFace(imageBuffer) {
    const ready = await loadFaceDetectionModels();
    if (!ready || !faceapi || !tf) {
        return true;
    }
    try {
        const { data, info } = await (0, sharp_1.default)(imageBuffer)
            .removeAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const tensor = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
        try {
            const detections = await faceapi.detectAllFaces(tensor, new faceapi.SsdMobilenetv1Options());
            return detections.length > 0;
        }
        finally {
            tf.dispose(tensor);
        }
    }
    catch (error) {
        console.error('Error during face detection:', error);
        return true;
    }
}
//# sourceMappingURL=faceDetection.js.map