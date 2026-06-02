import { Router, Response } from 'express';
import { supabase } from '../config/supabase';
import { authenticateJWT, requireOwner, AuthRequest } from '../middleware/auth';
import multer from 'multer';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify/sync';
import fs from 'fs';
import path from 'path';

const router = Router();
router.use(authenticateJWT);

const upload = multer({ dest: 'uploads/' });

// POST /api/import-export/import/customers
router.post('/import/customers', requireOwner, upload.single('file'), async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.file) {
    res.status(400).json({ error: 'No file uploaded' });
    return;
  }

  try {
    const results: any[] = [];
    fs.createReadStream(req.file.path)
      .pipe(parse({ columns: true, skip_empty_lines: true }))
      .on('data', (data) => {
        results.push({
          full_name: data.full_name,
          nic_number: data.nic_number,
          phone: data.phone,
          address: data.address,
          customer_code: data.customer_code || undefined, // Supabase triggers auto-gen if null usually, but let's assume valid data
          created_by: req.user!.id
        });
      })
      .on('end', async () => {
        const { data, error } = await supabase.from('customers').insert(results).select();
        fs.unlinkSync(req.file!.path); // Clean up

        if (error) {
          res.status(500).json({ error: error.message });
          return;
        }

        res.json({ message: `Successfully imported ${data.length} customers` });
      });
  } catch (error) {
    fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to process CSV' });
  }
});

// GET /api/import-export/export/customers
router.get('/export/customers', requireOwner, async (req: AuthRequest, res: Response): Promise<void> => {
  const { data, error } = await supabase.from('customers').select('*');
  
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const csv = stringify(data || [], { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=customers_export.csv');
  res.send(csv);
});

export default router;
