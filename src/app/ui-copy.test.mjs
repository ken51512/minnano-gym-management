import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const targetYearCore = readFileSync(new URL("../lib/target-year-core.ts", import.meta.url), "utf8");

const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const layout = readFileSync(new URL("./layout.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const monthlyService = readFileSync(new URL("../lib/monthly-service-core.ts", import.meta.url), "utf8");
const monthlyQuery = readFileSync(new URL("../lib/monthly-query-core.ts", import.meta.url), "utf8");

test("preview declares all eight screens and their Japanese navigation labels", () => {
  for (const id of ["login", "dashboard", "entry", "expenses", "review", "comparison", "history", "management"]) {
    assert.ok(page.includes(`"${id}"`), `missing screen ${id}`);
  }
  for (const label of ["\u30db\u30fc\u30e0", "\u6708\u6b21\u5165\u529b", "\u7d4c\u8cbb\u660e\u7d30", "\u6708\u6b21\u78ba\u8a8d", "\u6bd4\u8f03\u30fb\u5e74\u9593", "\u5909\u66f4\u5c65\u6b74"]) {
    assert.ok(page.includes(label), `missing label ${label}`);
  }
});

test("preview keeps a blank shared target month and distinguishes unavailable data", () => {
  assert.match(page, /useState\(""\)/);
  assert.match(page, /month=\{targetMonth\}/);
  assert.match(page, /function UnavailableValue/);
  assert.ok(page.includes("\u30c7\u30fc\u30bf\u672a\u63a5\u7d9a"));
});

test("management gate uses only a role returned by the verified Auth and allowlist session", () => {
  assert.match(page, /const \[role, setRole\] = useState<Role>\(null\)/);
  assert.match(page, /function ManagementFrame/);
  assert.match(page, /role !== "ALBA_ADMIN"/);
  assert.match(page, /disabled=\{role !== "ALBA_ADMIN"\}/);
  assert.match(page, /fetchVerifiedSession\(\)/);
  assert.match(page, /setRole\(session\.role\)/);
});

test("Japanese document metadata and UI files contain no replacement characters", () => {
  assert.match(layout, /lang="ja"/);
  for (const [name, value] of [["page.tsx", page], ["layout.tsx", layout], ["globals.css", styles]]) {
    assert.equal([...value].filter((character) => character.codePointAt(0) === 0xfffd).length, 0, name);
  }
});

test("every declared screen is wired to a distinct view inside the shared landmarks", () => {
  for (const id of ["login", "dashboard", "entry", "expenses", "review", "comparison", "history", "management"]) {
    assert.ok(page.includes(`case "${id}"`), `screen is not wired: ${id}`);
  }
  assert.match(page, /<main\b/);
  assert.match(page, /<nav[^>]+aria-label=/);
  assert.match(page, /function ScreenTitle/);
  assert.match(page, /<h1(?:\s|>)/);
  assert.match(page, /<h2(?:\s|>)/);
});

test("preview controls have labels, helper relationships, semantic controls, and visible focus styles", () => {
  assert.match(page, /<label htmlFor=\{id\}>\{label\}<\/label>/);
  assert.match(page, /aria-describedby=\{`\$\{id\}-help`\}/);
  assert.match(page, /className="month-picker"/);
  assert.match(page, /aria-label=.*5bfe.*5e74/);
  assert.match(page, /<textarea id="unlock-reason"[^>]+disabled aria-describedby="unlock-explanation"/);
  assert.match(page, /<button\b/);
  assert.match(page, /<a className="brand-lockup"/);
  assert.match(styles, /button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible/);
});

test("membership input policy accepts zero and rejects negative or noninteger supplied values", () => {
  assert.match(monthlyService, /Number\.isInteger\(value\) \|\| value < 0/);
  assert.match(page, /id="member-count" label=/);
  assert.match(page, /disabled=\{!allowed\}/);
  assert.match(page, /function ConnectedMonthlyEntry/);
});

test("dashboard uses the live session and selected-month snapshot instead of disconnected placeholder copy", () => {
  assert.match(page, /function Dashboard\(\{ month, navigate, snapshot, authState \}/);
  assert.match(page, /case "dashboard": return <Dashboard[^;]+snapshot=\{entryProps\.snapshot\} authState=\{authState\}/);
  assert.match(page, /const dataStatus = !targetMonth/);
  assert.match(page, /const roleLabel = role === "ALBA_ADMIN"/);
  assert.match(page, /const sessionStatus = authState === "ready"/);
  assert.match(page, /const saveStatusLabel = saveState === "saving"/);
  const statusBanner = page.match(/<div className="preview-banner"[^>]*>[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(statusBanner);
  assert.match(statusBanner, /sessionStatus/);
  assert.match(page, /saveState === "outcome_unknown"/);
  assert.match(page, /response\.status >= 500/);
  assert.match(page, /snapshot\.closed/);
});

test("login form uses email and password without exposing signup or credential storage", () => {
  assert.match(page, /autoComplete="username"/);
  assert.match(page, /autoComplete="current-password"/);
  assert.match(page, /signInWithBrowserPassword\(email, password\)/);
  assert.doesNotMatch(page, /localStorage/);
  assert.match(page, /PENDING_MONTHLY_REQUEST_KEY/);
  assert.match(page, /同じ操作を安全に再試行/);
  assert.doesNotMatch(page, /signUp\s*\(/);
});

test("one restored Supabase session gates every screen and exposes login or logout appropriately", () => {
  assert.match(page, /if \(authState === "signed_out" \|\| authState === "reauth_required"\) setScreen\("login"\)/);
  assert.match(page, /if \(authState !== "ready" && next !== "login"\)/);
  assert.match(page, /authState !== "ready" && <ScreenButton link=\{\{ id: "login", label: "ログイン" \}\}/);
  assert.match(page, /authState === "ready" && <button type="button" className="screen-link" onClick=\{\(\) => void logout\(\)\}/);
  assert.match(page, /if \(authState !== "ready"\) moreLinks\.push\(\{ id: "login", label: "ログイン" \}\)/);
  assert.match(page, /authState === "ready" && <button type="button" className="screen-link" onClick=\{onLogout\}/);
  assert.match(page, /authState === "ready"\s*\? <ScreenContent/);
  assert.match(page, /authState === "checking" \? <SessionCheckingFrame \/> : <LoginFrame/);
});

test("monthly review presents five persisted requirements and role-gated finalize/unlock actions", () => {
  assert.match(page, /function ConnectedMonthlyReview/);
  assert.match(page, /closingReadiness\(snapshot\)/);
  assert.match(page, /role !== "ALBA_ADMIN"/);
  assert.match(page, /!readiness\.complete/);
  assert.match(page, /!unlockReason\.trim\(\)/);
  assert.match(page, /response\.status >= 500/);
  assert.match(page, /await loadSnapshot\(targetMonth, false\)/);
});

test("monthly UI exposes create-month entry only for ALBA_ADMIN", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  assert.match(page, /snapshot && !snapshot\.exists && role === "ALBA_ADMIN"/);
  assert.match(page, /この月を作成/);
  assert.match(page, /expenseProps=\{expenseProps\}/);
  assert.match(page, /この月を作成/);
  assert.match(page, /onClick=\{\(\) => void createMonth\(\)\}/);
  assert.match(page, /expenseProps=\{expenseProps\}/);
  assert.match(page, /\u3053\u306e\u6708\u3092\u4f5c\u6210/);
  assert.match(page, /action: "create_month"/);
});

test("monthly entry distinguishes loading, missing, open, and closed periods and uses renderable Japanese copy", () => {
  const entry = page.slice(page.indexOf("function ConnectedMonthlyEntry("), page.indexOf("function ExistingEntryEditor("));
  const expenses = page.slice(page.indexOf("function ConnectedExpenseDetails("), page.indexOf("function RegisteredExpenseItemEditor("));
  assert.match(entry, /const periodNotice = !month/);
  assert.match(entry, /: !snapshot/);
  assert.match(entry, /: !snapshot\.exists/);
  assert.match(entry, /snapshot && !snapshot\.exists && role === "ALBA_ADMIN"/);
  assert.match(entry, /snapshot\.closed/);
  assert.match(expenses, /snapshot\?\.exists && snapshot\.closed/);
  assert.match(expenses, /snapshot\.exists && !snapshot\.closed/);
  assert.match(expenses, /role === "ALBA_ADMIN" && snapshot\.exists && !snapshot\.closed/);
  assert.match(page, /function isApiSnapshot/);
  assert.match(page, /typeof snapshot\.closed !== "boolean"/);
  assert.doesNotMatch(page, /title="\\u7d4c/);
  assert.match(page, /title=\{"\\u7d4c/);
  assert.match(page, /if \(refreshed\?\.exists\)/);
  assert.match(page, /setSnapshot\(null\);\s*setSaveState\("saved"\);\s*const refreshed/);
});

test("monthly entry lets ALBA add and review revenue beside expenses on the same selected month", () => {
  const entry = page.slice(page.indexOf("function ConnectedMonthlyEntry("), page.indexOf("function ExistingEntryEditor("));
  assert.match(entry, /snapshot\?\.exists && !snapshot\.closed && role === "ALBA_ADMIN"/);
  assert.match(entry, /snapshot\.revenueEntries\.map/);
  assert.match(entry, /saveChange\(\{ type: "revenueEntry", operation: "create"/);
  assert.match(entry, /submitOtherRevenue/);
  assert.match(entry, /<ConnectedExpenseDetails \{\.\.\.expenseProps\} month=\{month\} role=\{role\} compact/);
  assert.match(page, /case "entry": return <ConnectedMonthlyEntry/);
});

test("target year is directly editable, keeps valid years across months and screens, and never pads partial input", () => {
  assert.match(targetYearCore, /TARGET_YEAR_STORAGE_KEY = "minnano.target-year"/);
  assert.match(targetYearCore, /isValidTargetYear\(year\)/);
  const picker = page.slice(page.indexOf("function TargetMonth("), page.indexOf("function PeriodState("));
  assert.match(picker, /pattern="\[0-9\]\{4\}" maxLength=\{4\}/);
  assert.match(picker, /targetPeriod\(nextYear, nextMonth\) \?\? ""/);
  assert.match(picker, /isValidTargetYear\(next\)\) saveRememberedTargetYear\(next\)/);
  assert.match(picker, /setMonth\(event\.target\.value\); update\(year, event\.target\.value\)/);
  assert.match(picker, /loadRememberedTargetYear\(\)/);
  assert.match(picker, /initialized\.current/);
  assert.doesNotMatch(picker, /datalist|<select className="month-year-input"/);
  assert.match(page, /screen !== "login" && <TargetMonth value=\{targetMonth\}/);
  assert.match(page, /if \(authState === "ready" && targetMonth\)/);
  assert.doesNotMatch(page, /localStorage.*password|password.*localStorage/i);
});
test("saved expense amounts render per item, reload after save, and draft values reset on month change", () => {
  const editor = page.slice(page.indexOf("function ExpenseAmountRow("), page.indexOf("function ConnectedExpenseDetails("));
  const mutation = page.slice(page.indexOf("const runExpenseItemMutation"), page.indexOf("const registerExpenseItem"));
  assert.match(editor, /value=\{value\}/);
  assert.match(editor, /setValue\(savedValue\), \[rowKey, month, savedValue\]/);
  assert.match(editor, /changed \? "\\u672a\\u4fdd\\u5b58"/);
  assert.match(editor, /amount === null \? "保存" : "修正"/);
  assert.match(editor, /className="expense-row-delete"/);
  assert.match(editor, /項目削除/);
  assert.match(editor, /過去月の実績は残ります/);
  assert.match(editor, /const canSave = canSaveExpenseAmount/);
  assert.match(editor, /disabled=\{!canSave\}/);
  assert.doesNotMatch(editor, /className="expense-row-save"[^>]*>\\u[0-9a-f]{4}/i);
  assert.match(page, /useEffect\(\(\) => setAmount\(""\), \[month\]\)/);
  assert.match(mutation, /loadSnapshot\(targetMonth,false\)/);
    assert.match(page, /snapshot\.expenseItems\.map\(\(item\) => <NamedExpenseAmountRow/);
    assert.match(page, /名前変更/);
    assert.match(page, /renameItem=\{\(nextName\) => renameItem\(item\.id, nextName\)\}/);
  assert.match(monthlyQuery, /entries\.map\(objectValue\)\.find\(\(row\) => row\?\.expenseItemId === item\.id\)/);
  assert.match(monthlyQuery, /amount: entry && Number\.isInteger\(entry\.amount\) \? entry\.amount as number : null/);
  assert.match(editor, /aria-label=\{`\$\{label\}の金額/);
  assert.doesNotMatch(editor, /保存済み/);
});

test("expense entry is a compact item, amount, and save list that preserves each existing row", () => {
  assert.match(page, /const description = limit === null \? category\?\.name/);
  assert.match(page, /className="expense-list-header"/);
  assert.match(page, /className="expense-list-row"/);
  assert.match(page, /rename_expense_item/);
  assert.match(page, /対象月以降/);
  assert.match(page, /itemAmount/);
  assert.match(page, /register_expense_item_with_amount/);
  assert.match(styles, /\.expense-add-row\.has-name \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) 78px 32px 48px/);
  assert.match(styles, /@media \(max-width: 480px\)/);
    assert.match(page, /snapshot\.expenseItems\.map\(\(item\) => <NamedExpenseAmountRow/);
  assert.match(page, /snapshot\.expenseEntries\.filter\(\(entry\) => !entry\.expenseItemId\)\.map\(\(entry\) => <ExpenseAmountRow/);
  assert.match(page, /className=\{`expense-add-row\$\{limit !== null \? " has-name" : " has-fixed"\}`\}/);
  assert.match(styles, /\.expense-list-header, \.expense-list-row \{ display: grid;/);
  assert.match(styles, /@media \(max-width: 480px\)/);
  assert.match(page, /expenseItemLimit\(category\.name\)/);
});
