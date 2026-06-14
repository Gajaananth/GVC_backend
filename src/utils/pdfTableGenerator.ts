import PDFDocument from 'pdfkit';
import { supabase } from '../config/supabase';
import { format } from 'date-fns';
import path from 'path';
import fs from 'fs';
import { getCompanySettings as getCentralizedCompanySettings, CompanySettings } from '../config/companyConfig';

export interface PDFTableColumn {
  header: string;
  key: string;
  width: number;
  align?: 'left' | 'center' | 'right';
}

// Fetch company settings using the centralized config
export const getCompanySettings = async (): Promise<CompanySettings> => {
  return await getCentralizedCompanySettings(supabase);
};

export const addStandardHeader = (doc: PDFKit.PDFDocument, title: string, settings: any, subtitle?: string) => {
  doc.y = doc.page.margins.top || 30;
  const logoPath = path.join(process.cwd(), 'logo.png');
  if (fs.existsSync(logoPath)) {
    doc.image(logoPath, (doc.page.width - 80) / 2, doc.y, { width: 80 });
    doc.y += 85; // Force explicit spacing instead of font-size dependent moveDown
  }

  doc.fontSize(22).font('Helvetica-Bold').fillColor('#166534').text(settings.company_name, { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#000000').text(settings.company_address, { align: 'center' });
  doc.text(`Tel: ${settings.company_phone} | Email: ${settings.company_email}`, { align: 'center' });
  doc.moveDown(1.5);
  doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
  if (subtitle) {
    doc.fontSize(12).font('Helvetica').text(subtitle, { align: 'center' });
  }
  doc.moveDown(1);
};

export const drawTable = (
  doc: PDFKit.PDFDocument,
  columns: PDFTableColumn[],
  rows: any[],
  settings: any,
  title: string,
  subtitle?: string
) => {
  const startX = 30; // Small margin to fit more columns
  const rowHeight = 20;

  const drawHeaders = (y: number) => {
    doc.rect(startX, y, doc.page.width - startX * 2, rowHeight).fillAndStroke('#f3f4f6', '#d1d5db');
    doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9);

    let xPos = startX + 5;
    for (const col of columns) {
      doc.text(col.header, xPos, y + 6, { width: col.width - 10, align: col.align || 'left' });
      xPos += col.width;
    }
    return y + rowHeight;
  };

  let rowY = drawHeaders(doc.y);
  doc.font('Helvetica').fontSize(9).fillColor('#000000');

  for (const row of rows) {
    // Check if we need a new page
    if (rowY > doc.page.height - 50) {
      doc.addPage();
      addStandardHeader(doc, title, settings, subtitle);
      rowY = drawHeaders(doc.y);
      doc.font('Helvetica').fontSize(9).fillColor('#000000');
    }

    doc.rect(startX, rowY, doc.page.width - startX * 2, rowHeight).stroke('#e5e7eb');

    let xPos = startX + 5;
    for (const col of columns) {
      const val = row[col.key] !== undefined && row[col.key] !== null ? String(row[col.key]) : '';
      doc.text(val, xPos, rowY + 6, { width: col.width - 10, align: col.align || 'left' });
      xPos += col.width;
    }
    rowY += rowHeight;
  }
  return rowY;
};