// run: node --test scripts/globals.test.js
// the popup loads its scripts as plain <script> tags, which share one global scope, so two
// files declaring the same top-level const breaks the whole page. node's require() keeps
// each file separate and would never notice, so this loads them the browser's way
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("every popup script loads into one shared scope without clashing", () => {
  const root = path.join(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "popup/main.html"), "utf8");
  // the scripts in main.html's order
  const files = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => path.join(root, "popup", m[1]));

  // just enough browser for the top-level code to run
  const el = () => ({ addEventListener() {}, children: [], appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } });
  const context = vm.createContext({
    console, chrome: {}, document: { getElementById: el, querySelector: el, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() },
  });
  for (const file of files) {
    assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file }), path.basename(file));
  }
});
