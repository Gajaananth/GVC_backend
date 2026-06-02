import { TERM_CONFIG, validateTermForFrequency, formatTermSummary } from './loanTermConfig';
export type RepaymentFrequency = 'daily' | 'weekly' | 'biweekly' | 'monthly';
export interface LoanProductInput {
    grossLoanAmount: number;
    insuranceFeePercent: number;
    insuranceFeeFixed: number;
    documentationFee: number;
    interestRatePerPeriod: number;
    termCount: number;
    repaymentFrequency: RepaymentFrequency;
    creditDate: string | Date;
}
export interface LoanProductResult {
    grossLoanAmount: number;
    insuranceFeeAmount: number;
    documentationFee: number;
    totalFees: number;
    netDisbursement: number;
    principalForRepayment: number;
    interestRatePerPeriod: number;
    termCount: number;
    termUnit: string;
    termSummary: string;
    repaymentFrequency: RepaymentFrequency;
    totalInterest: number;
    totalPayable: number;
    installmentAmount: number;
    creditDate: string;
    firstCollectionDate: string;
    endDate: string;
    totalDurationDays: number;
    schedule: {
        installmentNumber: number;
        dueDate: string;
        principalAmount: number;
        interestAmount: number;
        installmentAmount: number;
    }[];
}
/** First collection date: always after credit (cash given to customer). */
export declare function getFirstCollectionDate(creditDate: Date, frequency: RepaymentFrequency): Date;
export declare function getNextDueDate(from: Date, frequency: RepaymentFrequency): Date;
export declare function calculateLoanProduct(input: LoanProductInput): LoanProductResult;
export { TERM_CONFIG, validateTermForFrequency, formatTermSummary };
//# sourceMappingURL=loanCalculator.d.ts.map