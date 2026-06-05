import PDFDocument from 'pdfkit';
import { supabase } from '../config/supabase';
import { format } from 'date-fns';
import { v4 as uuidv4 } from 'uuid';

const BUCKET = process.env.STORAGE_BUCKET || 'gvc-finance-files';

// Fetch company settings (mirrors documents.ts helper)
const getCompanySettings = async () => {
  const { data } = await supabase.from('company_settings').select('*').limit(1).single();
  return data || {
    company_name: 'GVC Agro Finance',
    company_address: '123 Main Road, Town, Sri Lanka',
    company_phone: '011-1234567',
    company_email: 'info@gvcagro.lk'
  };
};

// Add standard company header to the PDF
const addHeader = (doc: PDFKit.PDFDocument, title: string, settings: any) => {
  doc.fontSize(22).font('Helvetica-Bold').text(settings.company_name, { align: 'center' });
  doc.fontSize(10).font('Helvetica').text(settings.company_address, { align: 'center' });
  doc.text(`Tel: ${settings.company_phone} | Email: ${settings.company_email}`, { align: 'center' });
  doc.moveDown(1.5);
  doc.fontSize(16).font('Helvetica-Bold').text(title, { align: 'center' });
  doc.moveDown(1);
};

export interface LoanFormData {
  loanCode: string;
  customerName: string;
  customerNic: string;
  customerPhone: string;
  customerAddress: string;
  customerCode: string;
  grossLoanAmount: number;
  netDisbursement: number;
  insuranceFeeAmount: number;
  documentationFee: number;
  totalFees: number;
  interestRateMonthly: number;
  totalInterest: number;
  totalPayable: number;
  installmentAmount: number;
  termCount: number;
  repaymentFrequency: string;
  creditDate: string;
  firstCollectionDate: string;
  endDate: string;
  purpose?: string | null;
  guarantorName?: string | null;
  guarantorPhone?: string | null;
  collateralNotes?: string | null;
  appliedByName: string;
  inChargeName: string;
  schedule: {
    installmentNumber: number;
    dueDate: string;
    principalAmount: number;
    interestAmount: number;
    installmentAmount: number;
  }[];
}

/**
 * Generates a Loan Application PDF as a Buffer.
 */
export async function generateLoanApplicationPDF(data: LoanFormData): Promise<Buffer> {
  const settings = await getCompanySettings();

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50 });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // --- Page 1: Loan Application Form ---
      addHeader(doc, 'LOAN APPLICATION FORM', settings);

      // Reference box
      doc.rect(50, doc.y, 500, 55).stroke('#e5e7eb');
      doc.moveDown(0.3);
      doc.fontSize(11).font('Helvetica-Bold').text(`Loan Code: ${data.loanCode}`, 60);
      doc.font('Helvetica').text(`Application Date: ${format(new Date(), 'yyyy-MM-dd')}`, 60);
      doc.text(`Repayment Frequency: ${data.repaymentFrequency.toUpperCase()}`, 60);
      doc.moveDown(1.5);

      // Customer Details
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#166534').text('Customer Details');
      doc.fillColor('#000000').moveDown(0.3);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Name: ${data.customerName}`);
      doc.text(`Customer Code: ${data.customerCode}`);
      doc.text(`NIC: ${data.customerNic}`);
      doc.text(`Phone: ${data.customerPhone}`);
      doc.text(`Address: ${data.customerAddress}`);
      doc.moveDown(1);

      // Loan Details
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#166534').text('Loan Details');
      doc.fillColor('#000000').moveDown(0.3);

      const detailsTop = doc.y;
      doc.fontSize(11).font('Helvetica');

      // Left column
      doc.text(`Gross Loan Amount:`, 60, detailsTop);
      doc.font('Helvetica-Bold').text(`LKR ${data.grossLoanAmount.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`, 250, detailsTop);
      doc.font('Helvetica');

      const lineHeight = 18;
      let y = detailsTop + lineHeight;

      const rows = [
        ['Insurance Fee:', `LKR ${data.insuranceFeeAmount.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Documentation Fee:', `LKR ${data.documentationFee.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Total Fees:', `LKR ${data.totalFees.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Net Disbursement:', `LKR ${data.netDisbursement.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Monthly Interest Rate:', `${data.interestRateMonthly}%`],
        ['Total Interest:', `LKR ${data.totalInterest.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Total Payable:', `LKR ${data.totalPayable.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Installment Amount:', `LKR ${data.installmentAmount.toLocaleString('en-LK', { minimumFractionDigits: 2 })}`],
        ['Number of Installments:', `${data.termCount}`],
        ['Credit Date:', data.creditDate],
        ['First Collection Date:', data.firstCollectionDate],
        ['End Date:', data.endDate],
      ];

      for (const [label, value] of rows) {
        doc.font('Helvetica').text(label, 60, y);
        doc.font('Helvetica-Bold').text(value, 250, y);
        y += lineHeight;
      }

      doc.y = y + 10;

      if (data.purpose) {
        doc.font('Helvetica').text(`Purpose: ${data.purpose}`, 60);
        doc.moveDown(0.5);
      }

      // Guarantor Details
      if (data.guarantorName || data.guarantorPhone) {
        doc.moveDown(0.5);
        doc.fontSize(13).font('Helvetica-Bold').fillColor('#166534').text('Guarantor Details');
        doc.fillColor('#000000').moveDown(0.3);
        doc.fontSize(11).font('Helvetica');
        if (data.guarantorName) doc.text(`Name: ${data.guarantorName}`);
        if (data.guarantorPhone) doc.text(`Phone: ${data.guarantorPhone}`);
        if (data.collateralNotes) doc.text(`Collateral: ${data.collateralNotes}`);
      }

      // Staff Details
      doc.moveDown(1);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#166534').text('Staff Details');
      doc.fillColor('#000000').moveDown(0.3);
      doc.fontSize(11).font('Helvetica');
      doc.text(`Applied By: ${data.appliedByName}`);
      doc.text(`In-Charge Officer: ${data.inChargeName}`);

      // Signature Lines
      doc.moveDown(3);
      const sigY = doc.y;
      doc.font('Helvetica').text('........................................', 50, sigY);
      doc.text('Customer Signature', 50, sigY + 15);

      doc.text('........................................', 350, sigY);
      doc.text('Authorized Signature', 350, sigY + 15);

      doc.moveDown(4);
      doc.fontSize(9).fillColor('#6b7280').text(
        'This is a computer generated loan application form. The terms are subject to company policy.',
        { align: 'center' }
      );

      // --- Page 2: Repayment Schedule ---
      if (data.schedule.length > 0) {
        doc.addPage();
        addHeader(doc, 'REPAYMENT SCHEDULE', settings);

        doc.fontSize(11).font('Helvetica-Bold').fillColor('#000000');
        doc.text(`Loan Code: ${data.loanCode}`, 60);
        doc.text(`Customer: ${data.customerName} (${data.customerCode})`, 60);
        doc.moveDown(1);

        // Table Header
        const tableX = 50;
        const colWidths = [50, 110, 110, 110, 120];
        const headers = ['#', 'Due Date', 'Principal (LKR)', 'Interest (LKR)', 'Installment (LKR)'];
        const headerY = doc.y;

        doc.rect(tableX, headerY, 500, 20).fillAndStroke('#f3f4f6', '#d1d5db');
        doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9);

        let xPos = tableX + 5;
        for (let h = 0; h < headers.length; h++) {
          doc.text(headers[h], xPos, headerY + 5, { width: colWidths[h] - 10 });
          xPos += colWidths[h];
        }

        // Table Rows
        let rowY = headerY + 20;
        doc.font('Helvetica').fontSize(9).fillColor('#000000');

        for (const row of data.schedule) {
          // Add new page if we run out of space
          if (rowY > doc.page.height - 80) {
            doc.addPage();
            addHeader(doc, 'REPAYMENT SCHEDULE (Continued)', settings);
            rowY = doc.y;

            // Re-draw header
            doc.rect(tableX, rowY, 500, 20).fillAndStroke('#f3f4f6', '#d1d5db');
            doc.fillColor('#374151').font('Helvetica-Bold').fontSize(9);
            xPos = tableX + 5;
            for (let h = 0; h < headers.length; h++) {
              doc.text(headers[h], xPos, rowY + 5, { width: colWidths[h] - 10 });
              xPos += colWidths[h];
            }
            rowY += 20;
            doc.font('Helvetica').fontSize(9).fillColor('#000000');
          }

          doc.rect(tableX, rowY, 500, 18).stroke('#e5e7eb');
          xPos = tableX + 5;
          const values = [
            String(row.installmentNumber),
            row.dueDate,
            row.principalAmount.toFixed(2),
            row.interestAmount.toFixed(2),
            row.installmentAmount.toFixed(2)
          ];

          for (let v = 0; v < values.length; v++) {
            doc.text(values[v], xPos, rowY + 4, { width: colWidths[v] - 10 });
            xPos += colWidths[v];
          }
          rowY += 18;
        }

        // Totals row
        doc.rect(tableX, rowY, 500, 22).fillAndStroke('#e8f5e9', '#d1d5db');
        doc.fillColor('#000000').font('Helvetica-Bold').fontSize(9);
        doc.text('TOTAL', tableX + 5, rowY + 6, { width: colWidths[0] + colWidths[1] - 10 });
        xPos = tableX + colWidths[0] + colWidths[1] + 5;
        doc.text(data.grossLoanAmount.toFixed(2), xPos, rowY + 6, { width: colWidths[2] - 10 });
        xPos += colWidths[2];
        doc.text(data.totalInterest.toFixed(2), xPos, rowY + 6, { width: colWidths[3] - 10 });
        xPos += colWidths[3];
        doc.text(data.totalPayable.toFixed(2), xPos, rowY + 6, { width: colWidths[4] - 10 });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Uploads a loan application PDF buffer to Supabase Storage and returns the public URL.
 */
export async function uploadLoanFormPDF(loanId: string, loanCode: string, pdfBuffer: Buffer): Promise<string> {
  const storagePath = `loans/${loanId}/loan_form_${loanCode}_${uuidv4()}.pdf`;

  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, pdfBuffer, {
      contentType: 'application/pdf',
      upsert: false
    });

  if (error) {
    throw new Error(`Failed to upload loan form PDF: ${error.message}`);
  }

  const { data: publicData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  return publicData.publicUrl;
}
