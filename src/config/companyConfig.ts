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

// OFFICIAL SOURCE OF TRUTH - Updated 2026-06-14
export const COMPANY_CONFIG: CompanySettings = {
  company_name: 'GVC',
  company_address: 'SCHOOL ROAD, THANGAVELAYUTHAPURAM,\nAMPARA, THIRUKKOVIL,\nAMPARA, EASTERN PROVINCE,\nSRI LANKA, 32500',
  company_phone: '+94 754 317 396',
  company_email: 'info@gvcagro.lk',
  currency_symbol: '₨',
  company_logo_path: '/app/backend/logo.png' // Docker path in production
};

/**
 * Get company settings from centralized config
 * Falls back to database if available, otherwise uses hardcoded config
 */
export async function getCompanySettings(supabase?: any): Promise<CompanySettings> {
  try {
    if (supabase) {
      const { data, error } = await supabase.from('company_settings').select('*').limit(1).single();
      if (!error && data) {
        return {
          company_name: data.company_name || COMPANY_CONFIG.company_name,
          company_address: data.company_address || COMPANY_CONFIG.company_address,
          company_phone: data.company_phone || COMPANY_CONFIG.company_phone,
          company_email: data.company_email || COMPANY_CONFIG.company_email,
          currency_symbol: data.currency_symbol || COMPANY_CONFIG.currency_symbol,
          company_logo_path: data.company_logo_path || COMPANY_CONFIG.company_logo_path
        };
      }
    }
  } catch (err) {
    console.warn('Failed to fetch company settings from database, using config defaults');
  }
  return COMPANY_CONFIG;
}

/**
 * Format address with line breaks for PDF
 */
export function formatAddressForPDF(address: string): string[] {
  return address.split('\n').map(line => line.trim());
}

/**
 * Get formatted header text for documents
 */
export function getCompanyHeaderText(settings: CompanySettings): string {
  return `${settings.company_name}
${settings.company_address}
Phone: ${settings.company_phone}`;
}
