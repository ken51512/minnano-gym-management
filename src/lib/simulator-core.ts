export type SimulationMonth = {
  year: number;
  month: number;
  memberCount: number | null;
  revenueAmounts: number[];
  expenseAmounts: number[];
  expenseCategoryAmounts?: { categoryName: string; amount: number }[];
  newMembers?: number | null;
  cancellations?: number | null;
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
  operatingMargin: number | null;
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

export function rate(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
}

export function monthExpenseCategoryTotal(month: SimulationMonth, categoryName: string): number | null {
  if (!month.expenseCategoryAmounts || month.expenseCategoryAmounts.length === 0) return null;
  return month.expenseCategoryAmounts.filter((item) => item.categoryName === categoryName).reduce((total, item) => total + item.amount, 0);
}

export function monthlyMetrics(month: SimulationMonth) {
  const revenue = month.revenueAmounts.length > 0 ? sum(month.revenueAmounts) : null;
  const expense = month.expenseAmounts.length > 0 ? sum(month.expenseAmounts) : null;
  const operatingProfit = revenue !== null && expense !== null ? revenue - expense : null;
  const alba = month.memberCount === null || month.memberCount === undefined ? null : albaReward(month.memberCount);
  const earnes = operatingProfit === null || alba === null ? null : operatingProfit - alba;
  return {
    revenue,
    expense,
    operatingProfit,
    albaReward: alba,
    earnesReward: earnes,
    laborRate: rate(monthExpenseCategoryTotal(month, "人件費"), revenue),
    advertisingRate: rate(monthExpenseCategoryTotal(month, "広告費"), revenue),
    operatingMargin: rate(operatingProfit, revenue),
    cancellationRate: rate(month.cancellations ?? null, month.memberCount ?? null),
  };
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
    operatingMargin: revenue === 0 ? null : grossProfit / revenue,
  };
}
