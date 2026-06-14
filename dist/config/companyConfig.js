"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.COMPANY_CONFIG = void 0;
exports.getCompanySettings = getCompanySettings;
exports.formatAddressForPDF = formatAddressForPDF;
exports.getCompanyHeaderText = getCompanyHeaderText;
// OFFICIAL SOURCE OF TRUTH - Updated 2026-06-14
exports.COMPANY_CONFIG = {
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
async function getCompanySettings(supabase) {
    try {
        if (supabase) {
            const { data, error } = await supabase.from('company_settings').select('*').limit(1).single();
            if (!error && data) {
                return {
                    company_name: data.company_name || exports.COMPANY_CONFIG.company_name,
                    company_address: data.company_address || exports.COMPANY_CONFIG.company_address,
                    company_phone: data.company_phone || exports.COMPANY_CONFIG.company_phone,
                    company_email: data.company_email || exports.COMPANY_CONFIG.company_email,
                    currency_symbol: data.currency_symbol || exports.COMPANY_CONFIG.currency_symbol,
                    company_logo_path: data.company_logo_path || exports.COMPANY_CONFIG.company_logo_path
                };
            }
        }
    }
    catch (err) {
        console.warn('Failed to fetch company settings from database, using config defaults');
    }
    return exports.COMPANY_CONFIG;
}
/**
 * Format address with line breaks for PDF
 */
function formatAddressForPDF(address) {
    return address.split('\n').map(line => line.trim());
}
/**
 * Get formatted header text for documents
 */
function getCompanyHeaderText(settings) {
    return `${settings.company_name}
${settings.company_address}
Phone: ${settings.company_phone}`;
}
//# sourceMappingURL=companyConfig.js.map