"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.calculateSavingsInterest = exports.formatLKR = exports.calculateLateFee = exports.calculateLoan = exports.generateEntityId = void 0;
const date_fns_1 = require("date-fns");
/**
 * Generate a human-readable unique ID for an entity
 * Format: PREFIX-YYYYMMDD-XXXX (sequence padded to 4 digits)
 */
const generateEntityId = (prefix, sequence) => {
    const datePart = (0, date_fns_1.format)(new Date(), 'yyyyMMdd');
    const seqPart = String(sequence).padStart(4, '0');
    return `${prefix}-${datePart}-${seqPart}`;
};
exports.generateEntityId = generateEntityId;
const calculateLoan = (params) => {
    const { principal, interestRate, interestType, durationMonths, startDate } = params;
    let totalInterest;
    if (interestType === 'monthly') {
        // Monthly flat rate: interest = principal × rate × months / 100
        totalInterest = (principal * interestRate * durationMonths) / 100;
    }
    else {
        // Daily flat rate: convert to monthly equivalent
        const daysPerMonth = 30;
        const totalDays = durationMonths * daysPerMonth;
        totalInterest = (principal * interestRate * totalDays) / 100;
    }
    const totalPayable = principal + totalInterest;
    const installmentAmount = Math.round((totalPayable / durationMonths) * 100) / 100;
    const principalPerInstallment = Math.round((principal / durationMonths) * 100) / 100;
    const interestPerInstallment = Math.round((totalInterest / durationMonths) * 100) / 100;
    const schedule = [];
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
exports.calculateLoan = calculateLoan;
/**
 * Calculate late fee
 */
const calculateLateFee = (outstandingAmount, lateFeePercentage, daysLate) => {
    if (daysLate <= 0)
        return 0;
    return Math.round(((outstandingAmount * lateFeePercentage * daysLate) / 100) * 100) / 100;
};
exports.calculateLateFee = calculateLateFee;
/**
 * Format currency in LKR
 */
const formatLKR = (amount) => {
    return new Intl.NumberFormat('en-LK', {
        style: 'currency',
        currency: 'LKR',
        minimumFractionDigits: 2
    }).format(amount);
};
exports.formatLKR = formatLKR;
/**
 * Calculate savings interest
 */
const calculateSavingsInterest = (balance, annualRate, frequency) => {
    if (frequency === 'monthly') {
        return Math.round(((balance * annualRate) / 12 / 100) * 100) / 100;
    }
    if (frequency === 'daily') {
        return Math.round(((balance * annualRate) / 365 / 100) * 100) / 100;
    }
    return Math.round(((balance * annualRate) / 100) * 100) / 100;
};
exports.calculateSavingsInterest = calculateSavingsInterest;
//# sourceMappingURL=calculations.js.map