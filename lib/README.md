# lib

Third-party code, kept as local files because Manifest V3 doesn't allow scripts from a CDN.

## echarts.min.js

- Apache ECharts 6.1.0 (`dist/echarts.min.js` from the npm package)
- Source: https://registry.npmjs.org/echarts/-/echarts-6.1.0.tgz
- Integrity checked against npm:
  `sha512-q0yaFPggC9FUdsWH4blavRWFmxdrIodbkoKNAjJudAI6CA9gNPxHtV2RcZNEepZVlk4yvBYkOkbk6HIVpIyHZA==`
- License: Apache-2.0, see `echarts-LICENSE.txt` and `echarts-NOTICE.txt`
- Loaded only when the Race view is first opened.
- Contains one `new Function` call, in the GeoJSON map parser's fallback for browsers
  without `JSON.parse`. Chrome always has `JSON.parse` and the extension draws no maps,
  so it never runs (and Manifest V3 would block it if it did).
