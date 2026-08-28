// Minimal stand-in assets with the same structure the real build produces
// (build-assets.mjs), so the worker's tests and the local smoke server run on
// any machine — no lavish-axi checkout needed. The real chrome is far richer;
// what matters here is the contract: the lavish-session JSON block, the
// __LAVISH_*__ sentinels, and the sdk.js const declarations the worker rewrites.

export const stubAssets = {
  version: 'stub',
  chromeTemplate: `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>__LAVISH_TITLE__</title>
<link rel="stylesheet" href="/chrome.css">
</head>
<body class="lavish">
<div class="bar">__LAVISH_FILE__</div>
<iframe id="artifact" sandbox="allow-scripts allow-forms" data-artifact-src="/artifact/__LAVISH_KEY__/index.html"></iframe>
<script id="lavish-session" type="application/json">{"key":"__LAVISH_KEY__","file":"__LAVISH_FILE__","initialEnded":false,"initialEndedBy":null,"initialChat":[],"initialLayoutWarnings":[],"initialArtifactRevision":0,"initialArtifactLoadToken":"","initialArtifactLoadSequence":0,"chromeLoadToken":"","layoutGateEnabled":false,"modeToggleHotkeyKey":"e","attachmentMaxBytes":0,"attachmentMaxCount":4,"attachmentAcceptedMime":["image/png"]}</script>
<script src="/chrome-client.js"></script>
</body>
</html>
`,
  chromeClientJs: '/* stub chrome client */\n',
  chromeCss: '/* stub chrome css */\n',
  sdkJs: `(() => {
const key="__LAVISH_KEY__";
const artifactRevision=0;
const artifactLoadToken="";
/* stub sdk */
void key; void artifactRevision; void artifactLoadToken;
})();
`,
  design: {
    'daisyui.css': '/* stub daisyui */\n',
    'daisyui-themes.css': '/* stub daisyui themes */\n',
    'tailwindcss-browser.js': '/* stub tailwind */\n',
  },
};
