import { format } from 'date-fns';

/**
 * Generate a human-readable unique ID for an entity
 * Format: PREFIX-YYYYMMDD-XXXX (sequence padded to 4 digits)
 */
export const generateEntityId = (prefix: string, sequence: number): string => {
  const datePart = format(new Date(), 'yyyyMMdd');
  const seqPart = String(sequence).padStart(4, '0');
  return `${prefix}-${datePart}-${seqPart}`;
};

/**
 * Calculate flat-rate loan interest and installment schedule
 */
export interface LoanCalcParams {
  principal: number;
  interestRate: number;      // percentage, e.g. 2.5 means 2.5%
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

export const calculateLoan = (params: LoanCalcParams): LoanCalcResult => {
  const { principal, interestRate, interestType, durationMonths, startDate } = params;

  let totalInterest: number;

  if (interestType === 'monthly') {
    // Monthly flat rate: interest = principal × rate × months / 100
    totalInterest = (principal * interestRate * durationMonths) / 100;
  } else {
    // Daily flat rate: convert to monthly equivalent
    const daysPerMonth = 30;
    const totalDays = durationMonths * daysPerMonth;
    totalInterest = (principal * interestRate * totalDays) / 100;
  }

  const totalPayable = principal + totalInterest;
  const installmentAmount = Math.round((totalPayable / durationMonths) * 100) / 100;
  const principalPerInstallment = Math.round((principal / durationMonths) * 100) / 100;
  const interestPerInstallment = Math.round((totalInterest / durationMonths) * 100) / 100;

  const schedule: InstallmentScheduleItem[] = [];
  for (let i = 1; i <= durationMonths; i++) {
    const dueDate = new Date(startDate);
    dueDate.setMonth(dueDate.getMonth() + i);

    schedule.push({
      installmentNumber: i,
      dueDate,
      principalAmount: principalPerInstallment,
      interestAmount: interestPerInstallment,
      installmentAmount
    });
  }

  return { totalInterest, totalPayable, installmentAmount, schedule };
};

/**
 * Calculate late fee
 */
export const calculateLateFee = (
  outstandingAmount: number,
  lateFeePercentage: number,
  daysLate: number
): number => {
  if (daysLate <= 0) return 0;
  return Math.round(((outstandingAmount * lateFeePercentage * daysLate) / 100) * 100) / 100;
};

/**
 * Format currency in LKR
 */
export const formatLKR = (amount: number): string => {
  return new Intl.NumberFormat('en-LK', {
    style: 'currency',
    currency: 'LKR',
    minimumFractionDigits: 2
  }).format(amount);
};

/**
 * Calculate savings interest
 */
export const calculateSavingsInterest = (
  balance: number,
  annualRate: number,
  frequency: 'daily' | 'monthly' | 'yearly'
): number => {
  if (frequency === 'monthly') {
    return Math.round(((balance * annualRate) / 12 / 100) * 100) / 100;
  }
  if (frequency === 'daily') {
    return Math.round(((balance * annualRate) / 365 / 100) * 100) / 100;
  }
  return Math.round(((balance * annualRate) / 100) * 100) / 100;
};
