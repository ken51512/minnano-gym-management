import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isValidTargetYear, readRememberedTargetYear, rememberTargetYear, targetPeriod, TARGET_YEAR_STORAGE_KEY, loadRememberedTargetYear, saveRememberedTargetYear } from "./target-year-core.ts";

test("target years accept future four-digit years without padding incomplete input", () => {
  assert.equal(isValidTargetYear("2028"), true);
  assert.equal(targetPeriod("2028", "03"), "2028-03");
  assert.equal(isValidTargetYear("26"), false);
  assert.equal(targetPeriod("26", "03"), null);
  assert.equal(targetPeriod("0000", "03"), null);
  assert.equal(targetPeriod("2028", ""), null);
  assert.equal(targetPeriod("2028", "13"), null);
});

test("only a valid four-digit year is remembered and restored", () => {
  let stored: string | null = "";
  const storage = {
    getItem(key: string) { assert.equal(key, TARGET_YEAR_STORAGE_KEY); return stored; },
    setItem(key: string, value: string) { assert.equal(key, TARGET_YEAR_STORAGE_KEY); stored = value; },
  };
  rememberTargetYear(storage, "2028");
  assert.equal(readRememberedTargetYear(storage), "2028");
  rememberTargetYear(storage, "26");
  rememberTargetYear(storage, "");
  rememberTargetYear(storage, "0000");
  assert.equal(readRememberedTargetYear(storage), "2028");
  stored = "26";
  assert.equal(readRememberedTargetYear(storage), "");
  stored = "0000";
  assert.equal(readRememberedTargetYear(storage), "");
});

test("browser persistence restores only valid years and stores no monthly selection", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) { return values.get(key) ?? null; },
    setItem(key: string, value: string) { values.set(key, value); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: storage } });
  try {
    saveRememberedTargetYear("2028");
    assert.equal(loadRememberedTargetYear(), "2028");
    saveRememberedTargetYear("26");
    assert.equal(loadRememberedTargetYear(), "2028");
    assert.deepEqual([...values.keys()], [TARGET_YEAR_STORAGE_KEY]);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});