/** Sum every entered expense amount, regardless of category or item name. */
export function sumEnteredExpenseAmounts(values: readonly (number | null | undefined)[]): number | null {
  const entered = values.filter((value): value is number => Number.isInteger(value));
  return entered.length === 0 ? null : entered.reduce((total, value) => total + value, 0);
}
