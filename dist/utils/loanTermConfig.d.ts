import type { RepaymentFrequency } from './loanCalculator';
export interface TermConfig {
    unit: 'days' | 'weeks' | 'periods' | 'months';
    unitLabel: string;
    unitLabelPlural: string;
    min: number;
    max: number;
    default: number;
    presets: number[];
    interestRateHint: string;
    collectionHint: string;
}
export declare const TERM_CONFIG: Record<RepaymentFrequency, TermConfig>;
export declare function validateTermForFrequency(frequency: RepaymentFrequency, termCount: number): void;
export declare function formatTermSummary(frequency: RepaymentFrequency, termCount: number): string;
//# sourceMappingURL=loanTermConfig.d.ts.map