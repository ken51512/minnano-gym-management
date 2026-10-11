import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const css = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

test("390px expense registration form fits the mobile panel without horizontal overflow", () => {
  assert.match(css, /\.app-shell \{ display: block; min-height: 100vh; padding: 0 16px/);
  assert.match(css, /\.panel \{[^}]*padding: 20px/);
  assert.match(css, /\.expense-add-row\.has-name \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\) 78px 32px 48px; gap: 4px; \}/);
  const panelContent = 390 - 16 * 2 - 20 * 2;
  const fixedColumns = 78 + 32 + 48;
  const gaps = 4 * 4;
  const flexibleColumnWidth = (panelContent - fixedColumns - gaps) / 2;
  assert.equal(panelContent, 318);
  assert.equal(flexibleColumnWidth, 72);
  assert.equal(flexibleColumnWidth * 2 + fixedColumns + gaps, panelContent);
  assert.match(page, /itemAmount === "" \? null : Number\(itemAmount\)/);
});

test("the amount save button renders its Japanese label as a JavaScript string expression", () => {
  assert.match(page, /amount === null \? "保存" : "修正"/);
  assert.match(page, /className="expense-row-delete"/);
  assert.doesNotMatch(page, /className="expense-row-save"[^>]*>\\u[0-9a-f]{4}/i);
  const markup = renderToStaticMarkup(createElement("button", null, "\u4fdd\u5b58"));
  assert.equal(markup, "<button>保存</button>");
  assert.equal(markup.includes("\\u4fdd"), false);
});
