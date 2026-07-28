const globals = require("globals");

module.exports = [
  { ignores: ["dist/**", "node_modules/**", ".wrangler/**", ".playwright-cli/**"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.browser, ...globals.node, ...globals.worker, ProductVoice: "readonly", LineOrder: "readonly", LineNote: "readonly", CustomerName: "readonly", CustomerPasteParse: "readonly", XLSX: "readonly", liff: "readonly" }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "off"
    }
  }
];
