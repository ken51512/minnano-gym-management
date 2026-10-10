import { canUnlockClosing, type Role } from "./roles.ts";

export type AmountLines = readonly (number | null | undefined)[] | null | undefined;

export type MonthlyInputs = {
  revenueAmounts: AmountLines;
  expenseAmounts: AmountLines;
  /** Member count recorded at the end of the month before the input month. */
  memberCountAtPreviousMonthEnd: number;
};

export type MonthlyMetrics = {
  revenue: number | null;
  expenses: number | null;
  grossProfit: number | null;
  albaReward: number | null;
  earnesReward: number | null;
  grossProfitRate: number | null;
  earnesRate: number | null;
};

function sumEnteredLines(lines: AmountLines): number | null {
  if (lines == null || lines.some((amount) => amount == null)) return null;
  return (lines as readonly number[]).reduce((sum, amount) => sum + amount, 0);
}

/** ALBA reward: ¥100,000 through 60 members, then ¥5,000 per additional member. */
export class InvalidMemberCountError extends TypeError {
  constructor() {
    super("memberCountAtPreviousMonthEnd must be a nonnegative integer");
    this.name = "InvalidMemberCountError";
  }
}

function requireMemberCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidMemberCountError();
  }
  return value;
}

export function calculateAlbaReward(memberCountAtPreviousMonthEnd: number): number {
  const memberCount = requireMemberCount(memberCountAtPreviousMonthEnd);
  return 100_000 + Math.max(memberCount - 60, 0) * 5_000;
}

function calculateRate(numerator: number | null, revenue: number | null): number | null {
  if (numerator == null || revenue == null || revenue === 0) return null;
  return (numerator / revenue) * 100;
}

export function calculateMonthlyMetrics(inputs: MonthlyInputs): MonthlyMetrics {
  const memberCount = requireMemberCount(inputs.memberCountAtPreviousMonthEnd);
  const revenue = sumEnteredLines(inputs.revenueAmounts);
  const expenses = sumEnteredLines(inputs.expenseAmounts);
  const grossProfit = revenue == null || expenses == null ? null : revenue - expenses;
  const albaReward = calculateAlbaReward(memberCount);
  const earnesReward = grossProfit == null ? null : grossProfit - albaReward;

  return {
    revenue,
    expenses,
    grossProfit,
    albaReward,
    earnesReward,
    grossProfitRate: calculateRate(grossProfit, revenue),
    earnesRate: calculateRate(earnesReward, revenue),
  };
}

export function formatPercent(value: number | null | undefined): string {
  return value == null ? "—" : `${value}%`;
}

export type PriorComparisonState =
  | { status: "placeholder"; display: "—" }
  | { status: "blocked"; display: null };

/** Nonzero prior-period comparisons remain blocked until their definition is specified. */
export function priorComparisonState(
  previousValue: number | null | undefined,
): PriorComparisonState {
  return previousValue == null || previousValue === 0
    ? { status: "placeholder", display: "—" }
    : { status: "blocked", display: null };
}

/** Required input flags are supplied by the caller; an empty/absent checklist cannot close. */
export function canFinalizeMonth(
  requiredInputsEntered: readonly boolean[] | null | undefined,
): boolean {
  return requiredInputsEntered != null &&
    requiredInputsEntered.length > 0 &&
    requiredInputsEntered.every((entered) => entered === true);
}

export function canEditMonthlyRecord(isClosed: boolean): boolean {
  return !isClosed;
}

export function canUnlockMonthlyRecord(
  role: Role,
  reason: string | null | undefined,
): boolean {
  return canUnlockClosing(role) && Boolean(reason?.trim());
}
