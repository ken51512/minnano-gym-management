export const TARGET_YEAR_STORAGE_KEY = "minnano.target-year";

export type TargetYearStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export function isValidTargetYear(value: string): boolean {
  return /^\d{4}$/.test(value) && Number(value) >= 1 && Number(value) <= 9999;
}

export function targetPeriod(year: string, month: string): string | null {
  if (!isValidTargetYear(year) || !/^(0[1-9]|1[0-2])$/.test(month)) return null;
  return year + "-" + month;
}

export function readRememberedTargetYear(storage: TargetYearStorage): string {
  try {
    const year = storage.getItem(TARGET_YEAR_STORAGE_KEY);
    return year && isValidTargetYear(year) ? year : "";
  } catch {
    return "";
  }
}

export function rememberTargetYear(storage: TargetYearStorage, year: string): void {
  if (!isValidTargetYear(year)) return;
  try {
    storage.setItem(TARGET_YEAR_STORAGE_KEY, year);
  } catch {
    // Storage may be disabled; the in-memory input still works.
  }
}

export function loadRememberedTargetYear(): string {
  try {
    return typeof window === "undefined" ? "" : readRememberedTargetYear(window.localStorage);
  } catch {
    return "";
  }
}

export function saveRememberedTargetYear(year: string): void {
  if (!isValidTargetYear(year)) return;
  try {
    if (typeof window !== "undefined") rememberTargetYear(window.localStorage, year);
  } catch {
    // Storage may be disabled; the in-memory input still works.
  }
}
