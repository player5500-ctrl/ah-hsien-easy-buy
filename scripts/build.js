const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const out = path.join(root, "dist");
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const file of ["index.html", "styles.css", "app.js", "beginner-wizard.js", "pwa.js", "service-worker.js", "manifest.webmanifest", "product-voice.js", "line-order.js", "customer-name.js", "customer-paste-parse.js", "line-note.js", "liff-order.html", "liff-order.js", "liff-order.css"]) {
  fs.copyFileSync(path.join(root, file), path.join(out, file));
}
fs.cpSync(path.join(root, "icons"), path.join(out, "icons"), { recursive: true });
console.log("Production build created in dist/");
