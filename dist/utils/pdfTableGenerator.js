"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.drawTable = exports.addStandardHeader = exports.getCompanySettings = void 0;
const supabase_1 = require("../config/supabase");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const companyConfig_1 = require("../config/companyConfig");
// Fetch company settings using the centralized config
const getCompanySettings = async () => {
    return await (0, companyConfig_1.getCompanySettings)(supabase_1.supabase);
};
exports.getCompanySettings = getCompanySettings;
const addStandardHeader = (doc, title, settings, subtitle) => {
    const logoPath = path_1.default.join(process.cwd(), 'logo.png');
    if (fs_1.default.existsSync(logoPath)) {
        doc.image(logoPath, (doc.page.width - 80) / 2, doc.y, { width: 80 });
        doc.moveDown(5); // Make room for the logo
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
exports.addStandardHeader = addStandardHeader;
const drawTable = (doc, columns, rows, settings, title, subtitle) => {
    const startX = 30; // Small margin to fit more columns
    const rowHeight = 20;
    const drawHeaders = (y) => {
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
            (0, exports.addStandardHeader)(doc, title, settings, subtitle);
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
exports.drawTable = drawTable;
//# sourceMappingURL=pdfTableGenerator.js.map