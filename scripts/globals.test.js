// run: node --test scripts/globals.test.js
// each page loads its scripts as plain <script> tags, which share one global scope, so two
// files declaring the same top-level const breaks the whole page. node's require() keeps
// each file separate and would never notice, so this loads them the browser's way
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

for (const page of ["popup/main.html", "compare/compare.html"]) {
  test(`every ${page} script loads into one shared scope without clashing`, () => {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    // the scripts in the page's order
    const files = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => path.join(root, path.dirname(page), m[1]));

    // just enough browser for the top-level code to run
    const el = () => ({ addEventListener() {}, children: [], appendChild() {}, setAttribute() {}, classList: { add() {}, remove() {} } });
    const event = { addListener() {} };
    const context = vm.createContext({
      console,
      setInterval: () => 0,
      chrome: { tabs: { onUpdated: event, onRemoved: event } },
      document: { getElementById: el, querySelector: el, querySelectorAll: () => [], addEventListener() {}, createElement: el, body: el() },
    });
    for (const file of files) {
      assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file }), path.basename(file));
    }
  });
}
