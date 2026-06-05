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
export declare function generateLoanApplicationPDF(data: LoanFormData): Promise<Buffer>;
/**
 * Uploads a loan application PDF buffer to Supabase Storage and returns the public URL.
 */
export declare function uploadLoanFormPDF(loanId: string, loanCode: string, pdfBuffer: Buffer): Promise<string>;
//# sourceMappingURL=pdfGenerator.d.ts.map