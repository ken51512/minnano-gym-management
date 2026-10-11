export type SimulationMonth = {
  year: number;
  month: number;
  memberCount: number | null;
  revenueAmounts: number[];
  expenseAmounts: number[];
};

export type SimulationResult = {
  memberCount: number;
  averageMemberUnitPrice: number;
  averageExpense: number;
  revenue: number;
  expense: number;
  grossProfit: number;
  grossMargin: number | null;
  albaReward: number;
  earnesReward: number;
  earnesRewardRate: number | null;
  memberDifference: number | null;
  currentDifference: number | null;
};

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export function averageMemberUnitPrice(months: readonly SimulationMonth[]): number | null {
  const values = months
    .filter((month) => month.memberCount !== null && month.memberCount > 0 && month.revenueAmounts.length > 0)
    .map((month) => sum(month.revenueAmounts) / (month.memberCount as number));
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

export function averageExpense(months: readonly SimulationMonth[]): number | null {
  const values = months.filter((month) => month.expenseAmounts.length > 0).map((month) => sum(month.expenseAmounts));
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

export function albaReward(memberCount: number): number {
  return memberCount <= 60 ? 100000 : 100000 + (memberCount - 60) * 5000;
}

export function calculateSimulation(memberCount: number, months: readonly SimulationMonth[], current: SimulationMonth | null = null): SimulationResult | null {
  const unitPrice = averageMemberUnitPrice(months);
  const expense = averageExpense(months);
  if (unitPrice === null || expense === null) return null;
  const revenue = memberCount * unitPrice;
  const grossProfit = revenue - expense;
  const alba = albaReward(memberCount);
  const earnes = grossProfit - alba;
  const currentGross = current && current.revenueAmounts.length > 0 && current.expenseAmounts.length > 0
    ? sum(current.revenueAmounts) - sum(current.expenseAmounts)
    : null;
  return {
    memberCount,
    averageMemberUnitPrice: unitPrice,
    averageExpense: expense,
    revenue,
    expense,
    grossProfit,
    grossMargin: revenue === 0 ? null : grossProfit / revenue,
    albaReward: alba,
    earnesReward: earnes,
    earnesRewardRate: grossProfit === 0 ? null : earnes / grossProfit,
    memberDifference: current?.memberCount === null || current?.memberCount === undefined ? null : memberCount - current.memberCount,
    currentDifference: currentGross === null ? null : grossProfit - currentGross,
  };
}
