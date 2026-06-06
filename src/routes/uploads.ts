import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireCustomerAdmin, AuthRequest } from '../middleware/auth';
import { uploadCustomerFile, DOCUMENT_FIELD_MAP } from '../utils/storage';

const router = Router();
router.use(authenticateJWT);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const docTypeSchema = z.enum([
  'nic_front', 'nic_back', 'photo', 'application_form', 'home_photo', 'shop_photo', 'other'
]);

// POST /api/uploads/customers/:customerId — admin/owner only
router.post(
  '/customers/:customerId',
  requireCustomerAdmin,
  upload.single('file'),
  async (req: AuthRequest, res: Response): Promise<void> => {
    try {
      const documentType = docTypeSchema.parse(req.body.document_type);
      const file = req.file;

      if (!file) {
        res.status(400).json({ error: 'File is required' });
        return;
      }

      const { data: customer } = await supabase
        .from('customers')
        .select('id, customer_code, full_name')
        .eq('id', req.params.customerId)
        .single();

      if (!customer) {
        res.status(404).json({ error: 'Customer not found' });
        return;
      }

      // Branch isolation
      if (req.user?.role !== 'owner' && (customer as any).branch_id !== req.user.branch_id) {
        res.status(403).json({ error: 'Cannot upload documents for customers outside your branch' });
        return;
      }

      const { url } = await uploadCustomerFile(customer.id, documentType, file);

      await supabase.from('customer_documents').insert({
        customer_id: customer.id,
        document_type: documentType,
        file_url: url,
        file_name: file.originalname,
        mime_type: file.mimetype,
        uploaded_by: req.user!.id
      });

      const field = DOCUMENT_FIELD_MAP[documentType];
      if (field) {
        await supabase.from('customers').update({ [field]: url, updated_by: req.user!.id }).eq('id', customer.id);
      }

      await supabase.from('activity_logs').insert({
        user_id: req.user!.id,
        user_name: req.user!.full_name,
        user_role: req.user!.role,
        action: 'UPLOAD',
        entity_type: 'customer_document',
        entity_id: customer.id,
        entity_code: customer.customer_code,
        description: `Uploaded ${documentType} for ${customer.full_name}`
      });

      res.status(201).json({ data: { url, document_type: documentType }, message: 'Document uploaded' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: 'Invalid document type' });
        return;
      }
      res.status(400).json({ error: message });
    }
  }
);

// GET /api/uploads/customers/:customerId/documents
router.get('/customers/:customerId/documents', async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase
    .from('customer_documents')
    .select('*, users:uploaded_by(full_name)')
    .eq('customer_id', req.params.customerId)
    .order('uploaded_at', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ data });
});

export default router;
