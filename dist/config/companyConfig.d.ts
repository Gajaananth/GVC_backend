/**
 * CENTRALIZED COMPANY CONFIGURATION
 * SOURCE OF TRUTH FOR ALL COMPANY DETAILS
 *
 * Any changes here automatically reflect in:
 * - All PDF headers and footers
 * - Excel exports
 * - Certificates
 * - Receipts
 * - Reports
 * - System documents
 */
export interface CompanySettings {
    company_name: string;
    company_address: string;
    company_phone: string;
    company_email: string;
    currency_symbol: string;
    company_logo_path?: string;
}
export declare const COMPANY_CONFIG: CompanySettings;
/**
 * Get company settings from centralized config
 * Falls back to database if available, otherwise uses hardcoded config
 */
export declare function getCompanySettings(supabase?: any): Promise<CompanySettings>;
/**
 * Format address with line breaks for PDF
 */
export declare function formatAddressForPDF(address: string): string[];
/**
 * Get formatted header text for documents
 */
export declare function getCompanyHeaderText(settings: CompanySettings): string;
//# sourceMappingURL=companyConfig.d.ts.map