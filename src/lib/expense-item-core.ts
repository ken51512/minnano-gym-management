export function expenseItemLimit(categoryName: string): number | null {
  if (categoryName === "\u4eba\u4ef6\u8cbb") return 20;
  if (categoryName === "\u5e83\u544a\u8cbb" || categoryName === "\u305d\u306e\u4ed6") return 3;
  return null;
}

export function normalizeExpenseItemName(name: string): string {
  return name.trim();
}

export function expenseItemNameLength(name: string): number {
  return Array.from(name).length;
}

export type ExpenseItemNameVersion = { year: number; month: number; name: string };

export function isValidExpenseAmount(value: string): boolean {
  if (value.trim() === "" || !/^-?\d+$/.test(value)) return false;
  const amount = Number(value);
  return Number.isSafeInteger(amount) && amount >= -2147483648 && amount <= 2147483647;
}

export function canSaveExpenseAmount(input: { canEdit: boolean; busy: boolean; changed: boolean; value: string }): boolean {
  return input.canEdit && !input.busy && input.changed && isValidExpenseAmount(input.value);
}

export function resolveExpenseItemName(baseName: string, year: number, month: number, history: ExpenseItemNameVersion[]): string {
  const effective = history.filter((version) => Number.isInteger(version.year) && version.year >= 1 &&
    Number.isInteger(version.month) && version.month >= 1 && version.month <= 12 &&
    (version.year < year || (version.year === year && version.month <= month)) &&
    typeof version.name === "string" && normalizeExpenseItemName(version.name).length > 0)
    .sort((a, b) => a.year - b.year || a.month - b.month);
  return effective.length ? normalizeExpenseItemName(effective[effective.length - 1].name) : baseName;
}

export function canRegisterExpenseItem(categoryName: string, currentCount: number, name: string): boolean {
  const limit = expenseItemLimit(categoryName);
  const normalizedName = normalizeExpenseItemName(name);
  return limit !== null && Number.isInteger(currentCount) && currentCount >= 0 && currentCount < limit &&
    normalizedName.length > 0 && expenseItemNameLength(normalizedName) <= 200;
}
