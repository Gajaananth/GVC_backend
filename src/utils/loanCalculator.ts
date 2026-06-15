import { addDays, addMonths, addWeeks, format, parseISO, differenceInCalendarDays, isWeekend } from 'date-fns';
import { TERM_CONFIG, validateTermForFrequency, formatTermSummary } from './loanTermConfig';

// Array of Poya dates or other holidays to skip (YYYY-MM-DD format)
export const POYA_DAYS: string[] = [
  // Add 2026/2027 Poya days here if known, e.g., '2026-06-29'
];

function getNextBusinessDay(date: Date): Date {
  let next = addDays(date, 1);
  while (isWeekend(next) || POYA_DAYS.includes(format(next, 'yyyy-MM-dd'))) {
    next = addDays(next, 1);
  }
  return next;
}

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

const round2 = (n: number) => Math.round(n * 100) / 100;

/** First collection date: always after credit (cash given to customer). */
export function getFirstCollectionDate(creditDate: Date, frequency: RepaymentFrequency): Date {
  switch (frequency) {
    case 'daily':
      return getNextBusinessDay(creditDate);
    case 'weekly':
      return addDays(creditDate, 7);
    case 'biweekly':
      return addDays(creditDate, 14);
    case 'monthly':
      return addMonths(creditDate, 1);
    default:
      return addMonths(creditDate, 1);
  }
}

export function getNextDueDate(from: Date, frequency: RepaymentFrequency): Date {
  switch (frequency) {
    case 'daily':
      return getNextBusinessDay(from);
    case 'weekly':
      return addWeeks(from, 1);
    case 'biweekly':
      return addDays(from, 14);
    case 'monthly':
      return addMonths(from, 1);
    default:
      return addMonths(from, 1);
  }
}

/** Split amount across N installments with remainder on last row (accurate totals). */
function splitAmount(total: number, parts: number): number[] {
  const base = Math.floor((total / parts) * 100) / 100;
  const amounts = Array(parts).fill(base);
  const allocated = base * parts;
  amounts[parts - 1] = round2(total - base * (parts - 1));
  return amounts;
}

export function calculateLoanProduct(input: LoanProductInput): LoanProductResult {
  const frequency = input.repaymentFrequency;
  validateTermForFrequency(frequency, input.termCount);

  const gross = round2(input.grossLoanAmount);
  const insuranceFromPercent = round2((gross * (input.insuranceFeePercent || 0)) / 100);
  const insuranceFee = round2(insuranceFromPercent + (input.insuranceFeeFixed || 0));
  const documentationFee = round2(input.documentationFee || 0);
  const totalFees = round2(insuranceFee + documentationFee);

  if (totalFees >= gross) {
    throw new Error('Total fees cannot equal or exceed gross loan amount');
  }

  const netDisbursement = round2(gross - totalFees);
  const termCount = Math.max(1, Math.floor(input.termCount));
  const monthlyRate = input.interestRatePerPeriod || 0; // Always a MONTHLY rate
  const cfg = TERM_CONFIG[frequency];

  // Convert term count to equivalent months for interest calculation
  // Interest is always monthly regardless of collection frequency
  let durationInMonths: number;
  switch (frequency) {
    case 'daily':
      durationInMonths = termCount / 20;
      break;
    case 'weekly':
      durationInMonths = termCount / 4;
      break;
    case 'biweekly':
      durationInMonths = termCount / 2;
      break;
    case 'monthly':
    default:
      durationInMonths = termCount;
      break;
  }

  const totalInterest = round2((gross * monthlyRate * durationInMonths) / 100);
  const totalPayable = round2(gross + totalInterest);
  const installmentAmount = round2(totalPayable / termCount);

  const principalParts = splitAmount(gross, termCount);
  const interestParts = splitAmount(totalInterest, termCount);

  const creditDate = typeof input.creditDate === 'string'
    ? parseISO(input.creditDate)
    : input.creditDate;

  const firstCollection = getFirstCollectionDate(creditDate, frequency);
  const schedule: LoanProductResult['schedule'] = [];

  let due = firstCollection;
  for (let i = 0; i < termCount; i++) {
    schedule.push({
      installmentNumber: i + 1,
      dueDate: format(due, 'yyyy-MM-dd'),
      principalAmount: principalParts[i],
      interestAmount: interestParts[i],
      installmentAmount: round2(principalParts[i] + interestParts[i])
    });
    if (i < termCount - 1) {
      due = getNextDueDate(due, frequency);
    }
  }

  const endDate = schedule[schedule.length - 1]?.dueDate || format(firstCollection, 'yyyy-MM-dd');
  const totalDurationDays = differenceInCalendarDays(parseISO(endDate), creditDate);

  return {
    grossLoanAmount: gross,
    insuranceFeeAmount: insuranceFee,
    documentationFee,
    totalFees,
    netDisbursement,
    principalForRepayment: gross,
    interestRatePerPeriod: monthlyRate,
    termCount,
    termUnit: cfg.unit,
    termSummary: formatTermSummary(frequency, termCount),
    repaymentFrequency: frequency,
    totalInterest,
    totalPayable,
    installmentAmount,
    creditDate: format(creditDate, 'yyyy-MM-dd'),
    firstCollectionDate: format(firstCollection, 'yyyy-MM-dd'),
    endDate,
    totalDurationDays,
    schedule
  };
}

export { TERM_CONFIG, validateTermForFrequency, formatTermSummary };
