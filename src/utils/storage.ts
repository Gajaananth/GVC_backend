import { supabase } from '../config/supabase';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const BUCKET = process.env.STORAGE_BUCKET || 'gvc-finance-files';

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf'
]);

const MAX_BYTES = 10 * 1024 * 1024; // 10MB

export async function uploadCustomerFile(
  customerId: string,
  documentType: string,
  file: Express.Multer.File
): Promise<{ url: string; path: string }> {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new Error('Only JPEG, PNG, WebP, and PDF files are allowed');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('File size must be under 10MB');
  }

  const ext = path.extname(file.originalname) || (file.mimetype === 'application/pdf' ? '.pdf' : '.jpg');
  const storagePath = `customers/${customerId}/${documentType}/${uuidv4()}${ext}`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false
    });

  if (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }

  const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return { url: publicData.publicUrl, path: storagePath };
}

export const DOCUMENT_FIELD_MAP: Record<string, string> = {
  nic_front: 'nic_front_url',
  nic_back: 'nic_back_url',
  photo: 'photo_url',
  application_form: 'application_form_url',
  home_photo: 'home_photo_url',
  shop_photo: 'shop_photo_url'
};
