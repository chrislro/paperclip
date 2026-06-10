#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const PROD_API_ORIGIN = "https://api.tocafichadr.com.br";
const PROD_REALTIME_ORIGIN = "wss://api.tocafichadr.com.br";
const DEV_ORIGIN_PATTERNS = [
  /localhost:5050/i,
  /127\.0\.0\.1:505[01]/i,
  /100\.97\.14\.32(?::\d+)?/i,
  /trycloudflare\.com/i,
  /gist\.githubusercontent\.com/i,
];

function usage() {
  console.error("Usage: node scripts/verify-package.js (--root <dir>|--prepare-prod <dist>|--dist <dist>)");
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function fail(message) {
  console.error("verify-package: " + message);
  process.exitCode = 1;
}

function existsFile(root, rel) {
  return fs.existsSync(path.join(root, rel)) && fs.statSync(path.join(root, rel)).isFile();
}

function collectManifestPaths(manifest) {
  const paths = [];

  if (manifest.background && manifest.background.service_worker) {
    paths.push(manifest.background.service_worker);
  }
  if (manifest.side_panel && manifest.side_panel.default_path) {
    paths.push(manifest.side_panel.default_path);
  }
  if (manifest.action && manifest.action.default_popup) {
    paths.push(manifest.action.default_popup);
  }
  if (manifest.devtools_page) {
    paths.push(manifest.devtools_page);
  }
  if (manifest.options_page) {
    paths.push(manifest.options_page);
  }
  if (manifest.options_ui && manifest.options_ui.page) {
    paths.push(manifest.options_ui.page);
  }

  for (const icon of Object.values(manifest.icons || {})) {
    paths.push(icon);
  }
  if (manifest.action && manifest.action.default_icon) {
    for (const icon of Object.values(manifest.action.default_icon)) {
      paths.push(icon);
    }
  }

  for (const script of manifest.content_scripts || []) {
    for (const js of script.js || []) paths.push(js);
    for (const css of script.css || []) paths.push(css);
  }
  for (const resource of manifest.web_accessible_resources || []) {
    for (const rel of resource.resources || []) {
      if (!rel.includes("*")) paths.push(rel);
    }
  }
  for (const page of manifest.sandbox?.pages || []) {
    paths.push(page);
  }

  return [...new Set(paths)].sort();
}

function verifyManifestFiles(root) {
  const manifestPath = path.join(root, "manifest.json");
  if (!existsFile(root, "manifest.json")) {
    fail("missing manifest.json in " + root);
    return;
  }
  const manifest = readJson(manifestPath);
  const missing = collectManifestPaths(manifest).filter((rel) => !existsFile(root, rel));
  if (missing.length) {
    fail("manifest references missing files:\n  " + missing.join("\n  "));
  }
}

function hasDevOrigin(value) {
  return DEV_ORIGIN_PATTERNS.some((pattern) => pattern.test(value));
}

function sanitizeManifest(root) {
  const manifestPath = path.join(root, "manifest.json");
  const manifest = readJson(manifestPath);

  manifest.host_permissions = (manifest.host_permissions || []).filter((origin) => !hasDevOrigin(origin));

  if (!Array.isArray(manifest.permissions)) manifest.permissions = [];
  if (fs.existsSync(path.join(root, "offscreen")) && !manifest.permissions.includes("offscreen")) {
    manifest.permissions.push("offscreen");
  }

  const csp = manifest.content_security_policy || {};
  if (typeof csp.extension_pages === "string") {
    csp.extension_pages = csp.extension_pages
      .replace(/https:\/\/\*\.trycloudflare\.com/g, "")
      .replace(/https:\/\/gist\.githubusercontent\.com/g, "")
      .replace(/http:\/\/127\.0\.0\.1:5050/g, "")
      .replace(/http:\/\/localhost:5050/g, "")
      .replace(/http:\/\/100\.97\.14\.32:5050/g, "")
      .replace(/\s+;/g, ";")
      .replace(/\s{2,}/g, " ")
      .replace(/;\s*/g, "; ")
      .trim();
    manifest.content_security_policy = csp;
  }

  writeJson(manifestPath, manifest);
}

function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function isTextPackageFile(file) {
  return /\.(js|json|html|css|txt|svg)$/i.test(file);
}

function sanitizeProductionText(root) {
  const exactReplacements = [
    [/https:\/\/gist\.githubusercontent\.com\/chrislro\/3abd7bec1b371681c4ab346bd642b8e6\/raw\/tocafichadr-api-url\.json/g, PROD_API_ORIGIN + "/config/api-url.json"],
    [/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g, PROD_API_ORIGIN],
    [/http:\/\/127\.0\.0\.1:5050/g, PROD_API_ORIGIN],
    [/http:\/\/localhost:5050/g, PROD_API_ORIGIN],
    [/http:\/\/100\.97\.14\.32:5050/g, PROD_API_ORIGIN],
    [/ws:\/\/127\.0\.0\.1:5051\/realtime/g, PROD_REALTIME_ORIGIN + "/realtime"],
    [/\|\[a-z0-9-\]\+\\\.trycloudflare\\\.com/g, ""],
    [/\|\[a-z0-9-\]\+\.trycloudflare\.com/g, ""],
  ];

  for (const file of walkFiles(root)) {
    if (!isTextPackageFile(file)) continue;
    let text = fs.readFileSync(file, "utf8");
    let next = text;
    for (const [pattern, replacement] of exactReplacements) {
      next = next.replace(pattern, replacement);
    }
    if (next !== text) fs.writeFileSync(file, next);
  }
}

function verifyNoDevOrigins(root) {
  const offenders = [];
  for (const file of walkFiles(root)) {
    if (!isTextPackageFile(file)) continue;
    const rel = path.relative(root, file);
    const text = fs.readFileSync(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      if (hasDevOrigin(line)) offenders.push(`${rel}:${index + 1}: ${line.trim().slice(0, 180)}`);
    });
  }
  if (offenders.length) {
    fail("production package contains dev-only origins:\n  " + offenders.join("\n  "));
  }
}

const [mode, arg] = process.argv.slice(2);
if (!mode || !arg) usage();

const root = path.resolve(arg);

if (mode === "--root") {
  verifyManifestFiles(root);
} else if (mode === "--prepare-prod") {
  sanitizeManifest(root);
  sanitizeProductionText(root);
} else if (mode === "--dist") {
  verifyManifestFiles(root);
  verifyNoDevOrigins(root);
} else {
  usage();
}

if (!process.exitCode) {
  console.log("verify-package: OK (" + mode.replace(/^--/, "") + " " + path.relative(process.cwd(), root) + ")");
}
