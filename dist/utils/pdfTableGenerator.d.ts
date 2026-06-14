import { CompanySettings } from '../config/companyConfig';
export interface PDFTableColumn {
    header: string;
    key: string;
    width: number;
    align?: 'left' | 'center' | 'right';
}
export declare const getCompanySettings: () => Promise<CompanySettings>;
export declare const addStandardHeader: (doc: PDFKit.PDFDocument, title: string, settings: any, subtitle?: string) => void;
export declare const drawTable: (doc: PDFKit.PDFDocument, columns: PDFTableColumn[], rows: any[], settings: any, title: string, subtitle?: string) => number;
//# sourceMappingURL=pdfTableGenerator.d.ts.map