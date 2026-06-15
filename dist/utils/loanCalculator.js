"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatTermSummary = exports.validateTermForFrequency = exports.TERM_CONFIG = exports.POYA_DAYS = void 0;
exports.getFirstCollectionDate = getFirstCollectionDate;
exports.getNextDueDate = getNextDueDate;
exports.calculateLoanProduct = calculateLoanProduct;
const date_fns_1 = require("date-fns");
const loanTermConfig_1 = require("./loanTermConfig");
Object.defineProperty(exports, "TERM_CONFIG", { enumerable: true, get: function () { return loanTermConfig_1.TERM_CONFIG; } });
Object.defineProperty(exports, "validateTermForFrequency", { enumerable: true, get: function () { return loanTermConfig_1.validateTermForFrequency; } });
Object.defineProperty(exports, "formatTermSummary", { enumerable: true, get: function () { return loanTermConfig_1.formatTermSummary; } });
// Array of Poya dates or other holidays to skip (YYYY-MM-DD format)
exports.POYA_DAYS = [
// Add 2026/2027 Poya days here if known, e.g., '2026-06-29'
];
function getNextBusinessDay(date) {
    let next = (0, date_fns_1.addDays)(date, 1);
    while ((0, date_fns_1.isWeekend)(next) || exports.POYA_DAYS.includes((0, date_fns_1.format)(next, 'yyyy-MM-dd'))) {
        next = (0, date_fns_1.addDays)(next, 1);
    }
    return next;
}
const round2 = (n) => Math.round(n * 100) / 100;
/** First collection date: always after credit (cash given to customer). */
function getFirstCollectionDate(creditDate, frequency) {
    switch (frequency) {
        case 'daily':
            return getNextBusinessDay(creditDate);
        case 'weekly':
            return (0, date_fns_1.addDays)(creditDate, 7);
        case 'biweekly':
            return (0, date_fns_1.addDays)(creditDate, 14);
        case 'monthly':
            return (0, date_fns_1.addMonths)(creditDate, 1);
        default:
            return (0, date_fns_1.addMonths)(creditDate, 1);
    }
}
function getNextDueDate(from, frequency) {
    switch (frequency) {
        case 'daily':
            return getNextBusinessDay(from);
        case 'weekly':
            return (0, date_fns_1.addWeeks)(from, 1);
        case 'biweekly':
            return (0, date_fns_1.addDays)(from, 14);
        case 'monthly':
            return (0, date_fns_1.addMonths)(from, 1);
        default:
            return (0, date_fns_1.addMonths)(from, 1);
    }
}
/** Split amount across N installments with remainder on last row (accurate totals). */
function splitAmount(total, parts) {
    const base = Math.floor((total / parts) * 100) / 100;
    const amounts = Array(parts).fill(base);
    const allocated = base * parts;
    amounts[parts - 1] = round2(total - base * (parts - 1));
    return amounts;
}
function calculateLoanProduct(input) {
    const frequency = input.repaymentFrequency;
    (0, loanTermConfig_1.validateTermForFrequency)(frequency, input.termCount);
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
    const cfg = loanTermConfig_1.TERM_CONFIG[frequency];
    // Convert term count to equivalent months for interest calculation
    // Interest is always monthly regardless of collection frequency
    let durationInMonths;
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
        ? (0, date_fns_1.parseISO)(input.creditDate)
        : input.creditDate;
    const firstCollection = getFirstCollectionDate(creditDate, frequency);
    const schedule = [];
    let due = firstCollection;
    for (let i = 0; i < termCount; i++) {
        schedule.push({
            installmentNumber: i + 1,
            dueDate: (0, date_fns_1.format)(due, 'yyyy-MM-dd'),
            principalAmount: principalParts[i],
            interestAmount: interestParts[i],
            installmentAmount: round2(principalParts[i] + interestParts[i])
        });
        if (i < termCount - 1) {
            due = getNextDueDate(due, frequency);
        }
    }
    const endDate = schedule[schedule.length - 1]?.dueDate || (0, date_fns_1.format)(firstCollection, 'yyyy-MM-dd');
    const totalDurationDays = (0, date_fns_1.differenceInCalendarDays)((0, date_fns_1.parseISO)(endDate), creditDate);
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
        termSummary: (0, loanTermConfig_1.formatTermSummary)(frequency, termCount),
        repaymentFrequency: frequency,
        totalInterest,
        totalPayable,
        installmentAmount,
        creditDate: (0, date_fns_1.format)(creditDate, 'yyyy-MM-dd'),
        firstCollectionDate: (0, date_fns_1.format)(firstCollection, 'yyyy-MM-dd'),
        endDate,
        totalDurationDays,
        schedule
    };
}
//# sourceMappingURL=loanCalculator.js.map