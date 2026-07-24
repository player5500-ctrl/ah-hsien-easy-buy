const globals = require("globals");

module.exports = [
  { ignores: ["dist/**", "node_modules/**"] },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.browser, ...globals.node, ...globals.worker, ProductVoice: "readonly", LineOrder: "readonly", LineNote: "readonly", XLSX: "readonly", liff: "readonly" }
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": "off"
    }
  }
];
