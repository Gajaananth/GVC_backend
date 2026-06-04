"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOCUMENT_FIELD_MAP = void 0;
exports.uploadCustomerFile = uploadCustomerFile;
const supabase_1 = require("../config/supabase");
const uuid_1 = require("uuid");
const path_1 = __importDefault(require("path"));
const sharp_1 = __importDefault(require("sharp"));
const BUCKET = process.env.STORAGE_BUCKET || 'gvc-finance-files';
const ALLOWED_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/pdf'
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
async function uploadCustomerFile(customerId, documentType, file) {
    if (!ALLOWED_MIME.has(file.mimetype)) {
        throw new Error('Only JPEG, PNG, WebP, and PDF files are allowed');
    }
    if (file.size > MAX_BYTES) {
        throw new Error('File size must be under 10MB');
    }
    // Validate image dimensions for face photo (minimum 300x300)
    if (documentType === 'photo') {
        const metadata = await (0, sharp_1.default)(file.buffer).metadata();
        if (!metadata.width || !metadata.height || metadata.width < 300 || metadata.height < 300) {
            throw new Error('Face photo must be at least 300x300 pixels');
        }
        // NOTE: Advanced face detection could be added here.
    }
    const ext = path_1.default.extname(file.originalname) || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
    const storagePath = `customers/${customerId}/${documentType}/${(0, uuid_1.v4)()}${ext}`;
    const { error } = await supabase_1.supabase.storage
        .from(BUCKET)
        .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false
    });
    if (error) {
        throw new Error(`Upload failed: ${error.message}`);
    }
    const { data: publicData } = supabase_1.supabase.storage.from(BUCKET).getPublicUrl(storagePath);
    return { url: publicData.publicUrl, path: storagePath };
}
exports.DOCUMENT_FIELD_MAP = {
    nic_front: 'nic_front_url',
    nic_back: 'nic_back_url',
    photo: 'photo_url',
    application_form: 'application_form_url',
    home_photo: 'home_photo_url',
    shop_photo: 'shop_photo_url',
    loan_form: 'loan_form_url'
};
//# sourceMappingURL=storage.js.map