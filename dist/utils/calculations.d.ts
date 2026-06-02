/**
 * Generate a human-readable unique ID for an entity
 * Format: PREFIX-YYYYMMDD-XXXX (sequence padded to 4 digits)
 */
export declare const generateEntityId: (prefix: string, sequence: number) => string;
/**
 * @deprecated Use calculateLoanProduct from loanCalculator.ts for new loans
 * Calculate flat-rate loan interest and installment schedule
 */
export interface LoanCalcParams {
    principal: number;
    interestRate: number;
    interestType: 'daily' | 'monthly';
    durationMonths: number;
    startDate: Date;
}
export interface InstallmentScheduleItem {
    installmentNumber: number;
    dueDate: Date;
    principalAmount: number;
    interestAmount: number;
    installmentAmount: number;
}
export interface LoanCalcResult {
    totalInterest: number;
    totalPayable: number;
    installmentAmount: number;
    schedule: InstallmentScheduleItem[];
}
export declare const calculateLoan: (params: LoanCalcParams) => LoanCalcResult;
/**
 * Calculate late fee
 */
export declare const calculateLateFee: (outstandingAmount: number, lateFeePercentage: number, daysLate: number) => number;
/**
 * Format currency in LKR
 */
export declare const formatLKR: (amount: number) => string;
/**
 * Calculate savings interest
 */
export declare const calculateSavingsInterest: (balance: number, annualRate: number, frequency: "daily" | "monthly" | "yearly") => number;
//# sourceMappingURL=calculations.d.ts.map