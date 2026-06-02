"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TERM_CONFIG = void 0;
exports.validateTermForFrequency = validateTermForFrequency;
exports.formatTermSummary = formatTermSummary;
exports.TERM_CONFIG = {
    daily: {
        unit: 'days',
        unitLabel: 'day',
        unitLabelPlural: 'days',
        min: 1,
        max: 180,
        default: 90,
        presets: [30, 60, 90, 120, 180],
        interestRateHint: 'Interest % charged each day on gross loan amount',
        collectionHint: 'First collection is the day after credit. Each installment is 1 day apart.'
    },
    weekly: {
        unit: 'weeks',
        unitLabel: 'week',
        unitLabelPlural: 'weeks',
        min: 1,
        max: 104,
        default: 12,
        presets: [4, 8, 12, 26, 52],
        interestRateHint: 'Interest % charged each week on gross loan amount',
        collectionHint: 'First collection is 7 days after credit. Each installment is 1 week apart.'
    },
    biweekly: {
        unit: 'periods',
        unitLabel: '14-day period',
        unitLabelPlural: '14-day periods',
        min: 1,
        max: 52,
        default: 6,
        presets: [2, 4, 6, 12, 26],
        interestRateHint: 'Interest % charged each 14-day period on gross loan amount',
        collectionHint: 'First collection is 14 days after credit. Each installment is 14 days apart.'
    },
    monthly: {
        unit: 'months',
        unitLabel: 'month',
        unitLabelPlural: 'months',
        min: 1,
        max: 120,
        default: 12,
        presets: [3, 6, 12, 24, 36, 60],
        interestRateHint: 'Interest % charged each month on gross loan amount',
        collectionHint: 'First collection is 1 calendar month after credit. Each installment is monthly.'
    }
};
function validateTermForFrequency(frequency, termCount) {
    const cfg = exports.TERM_CONFIG[frequency];
    const n = Math.floor(termCount);
    if (n < cfg.min || n > cfg.max) {
        throw new Error(`For ${frequency} loans, term must be between ${cfg.min} and ${cfg.max} ${cfg.unitLabelPlural}`);
    }
}
function formatTermSummary(frequency, termCount) {
    const cfg = exports.TERM_CONFIG[frequency];
    const label = termCount === 1 ? cfg.unitLabel : cfg.unitLabelPlural;
    return `${termCount} ${label} (${termCount} installments)`;
}
//# sourceMappingURL=loanTermConfig.js.map