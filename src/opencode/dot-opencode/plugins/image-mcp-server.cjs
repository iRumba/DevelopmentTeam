const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const os = require("node:os");
const { stdin, stdout } = require("node:process");
const { execSync } = require("node:child_process");

const WORKSPACE_ROOT = process.cwd();
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
const URL_TIMEOUT_MS = 10000;

// Storage: ~/.local/share/opencode/images/<projectId>/
const STORAGE_BASE = process.env.IMAGE_STORAGE_BASE ||
  path.join(os.homedir(), ".local", "share", "opencode", "images");

// Compute project ID from git root commit hash for cross-worktree consistency
// Uses root commit (same as kdco-primitives/get-project-id.ts) so that all
// worktrees of the same repo share the same project ID.
let PROJECT_ID = "default";
try {
  const result = execSync("git rev-list --max-parents=0 --all", {
    cwd: WORKSPACE_ROOT,
    encoding: "utf-8",
    timeout: 5000,
  });
  const roots = result.trim().split("\n").filter(Boolean).map(x => x.trim()).sort();
  if (roots.length > 0 && /^[a-f0-9]{40}$/i.test(roots[0])) {
    PROJECT_ID = roots[0];
  }
} catch (err) {
  process.stderr.write(`[image-mcp-server] Warning: could not determine git project ID, using default: ${err.message}\n`);
}

if (!/^[a-zA-Z0-9_-]+$/.test(PROJECT_ID)) {
  throw new Error(`Invalid project ID derived from git: "${PROJECT_ID}"`);
}

const DATA_URI_RE = /^data:(image\/[^;]+)(?:;base64)?,(.+)$/;

// Validate project ID format (prevent path injection)
function validateProjectId(id) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Invalid project_id: only alphanumeric, hyphens, underscores allowed");
  }
  return id;
}

// Validate session ID format (prevent path injection)
function validateSessionId(id) {
  if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("Invalid session_id: only alphanumeric, hyphens, underscores allowed");
  }
  return id;
}

// Prevent path traversal: ensure resolved path stays within baseDir
function safeResolve(baseDir, userPath) {
  const resolved = path.resolve(baseDir, userPath);
  if (!resolved.startsWith(baseDir)) {
    throw new Error("Access denied: path traversal detected");
  }
  return resolved;
}

// Get session directory, creating it if needed for write operations
function getSessionDir(projectId, sessionId, createIfMissing) {
  validateProjectId(projectId);
  validateSessionId(sessionId);
  const resolved = safeResolve(STORAGE_BASE, path.join(projectId, sessionId));

  if (createIfMissing) {
    fs.mkdirSync(resolved, { recursive: true });
  }

  return resolved;
}

// Detect MIME type from magic bytes or file extension
function guessMimeType(filePath, buffer) {
  // Try magic bytes first
  if (buffer && buffer.length >= 4) {
    // PNG: 89 50 4E 47
    if (
      buffer[0] === 0x89 && buffer[1] === 0x50 &&
      buffer[2] === 0x4E && buffer[3] === 0x47
    ) {
      return "image/png";
    }
    // GIF: 47 49 46 38
    if (
      buffer[0] === 0x47 && buffer[1] === 0x49 &&
      buffer[2] === 0x46 && buffer[3] === 0x38
    ) {
      return "image/gif";
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return "image/jpeg";
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (
      buffer[0] === 0x52 && buffer[1] === 0x49 &&
      buffer[2] === 0x46 && buffer[3] === 0x46
    ) {
      if (
        buffer.length >= 12 &&
        buffer[8] === 0x57 && buffer[9] === 0x45 &&
        buffer[10] === 0x42 && buffer[11] === 0x50
      ) {
        return "image/webp";
      }
    }
  }

  // Fall back to file extension
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

// Map MIME type to file extension
function getExtension(mimeType) {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    case "image/svg+xml": return "svg";
    default: return "bin";
  }
}

// Download a URL and return buffer + MIME type
function downloadUrl(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = url.startsWith("https://");
    const client = isHttps ? https : http;
    let redirectCount = 0;
    const maxRedirects = 1;

    function doRequest(currentUrl) {
      const req = client.get(currentUrl, { timeout: timeoutMs }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects for URL: ${url}`));
            return;
          }
          redirectCount++;
          const redirectUrl = new URL(res.headers.location, currentUrl).href;
          doRequest(redirectUrl);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Failed to download image: HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.length > MAX_FILE_SIZE) {
            reject(new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`));
            return;
          }

          const contentType = res.headers["content-type"] || "";
          let mimeType = contentType;
          if (!mimeType || mimeType === "application/octet-stream") {
            mimeType = guessMimeType(currentUrl, buffer);
          }

          resolve({ buffer, mimeType });
        });
        res.on("error", (err) => {
          reject(new Error(`Failed to download image from URL: ${url} (${err.message})`));
        });
      });

      req.on("error", (err) => {
        reject(new Error(`Failed to download image from URL: ${url} (${err.message})`));
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Failed to download image from URL: ${url} (timeout after ${timeoutMs / 1000}s)`));
      });
    }

    doRequest(url);
  });
}

// Detect source type from the source string
function detectSourceType(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    return "url";
  }
  if (source.startsWith("data:image/")) {
    return "base64";
  }
  if (source.startsWith("data:")) {
    throw new Error("Invalid data URI format");
  }
  return "file";
}

// Read _metadata.json from session directory, return empty array if missing
function readMetadata(sessionDir) {
  const metadataPath = path.join(sessionDir, "_metadata.json");
  if (!fs.existsSync(metadataPath)) {
    return [];
  }
  const raw = fs.readFileSync(metadataPath, "utf-8");
  return JSON.parse(raw);
}

// Write _metadata.json to session directory
function writeMetadata(sessionDir, entries) {
  const metadataPath = path.join(sessionDir, "_metadata.json");
  fs.writeFileSync(metadataPath, JSON.stringify(entries, null, 2), "utf-8");
}

// Generate image ID from content hash
function generateId(buffer) {
  const hash = crypto.createHash("sha256").update(buffer).digest("hex");
  return "img_" + hash.slice(0, 8);
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

async function handleImageAdd(args) {
  const source = args.source;
  const sessionDir = getSessionDir(PROJECT_ID, args.session_id, true);
  const description = args.description || null;
  const sourceType = detectSourceType(source);

  if (sourceType === "url") {
    // Guard: download URL with timeout (Law 1: Early Exit on failure)
    const { buffer, mimeType } = await downloadUrl(source, URL_TIMEOUT_MS);
    return await finishImageAdd(sessionDir, buffer, mimeType, sourceType, source, description);
  }

  if (sourceType === "base64") {
    // Parse data URI: data:image/png;base64,iVBOR...
    const match = source.match(DATA_URI_RE);
    if (!match) {
      throw new Error("Invalid data URI format");
    }
    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
    }
    return await finishImageAdd(sessionDir, buffer, mimeType, sourceType, "data:uri", description);
  }

  // Local file source
  const resolvedPath = safeResolve(WORKSPACE_ROOT, source);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`File not found: ${source}`);
  }
  const buffer = fs.readFileSync(resolvedPath);
  if (buffer.length > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
  }
  const mimeType = guessMimeType(resolvedPath, buffer);

  return await finishImageAdd(sessionDir, buffer, mimeType, sourceType, source, description);
}

function finishImageAdd(sessionDir, buffer, mimeType, sourceType, originalSource, description) {
  const imageId = generateId(buffer);
  const ext = getExtension(mimeType);
  const imagePath = path.join(sessionDir, imageId + "." + ext);

  // Guard: check for duplicate content (Law 1: Early Exit)
  if (fs.existsSync(imagePath)) {
    return { id: imageId };
  }

  // Write image file
  fs.writeFileSync(imagePath, buffer);

  // Update metadata
  const entries = readMetadata(sessionDir);
  entries.push({
    id: imageId,
    description: description,
    source_type: sourceType,
    mime_type: mimeType,
    original_source: originalSource,
    created_at: new Date().toISOString(),
  });
  writeMetadata(sessionDir, entries);

  return { id: imageId };
}

function handleImageList(args) {
  const sessionId = args?.session_id;

  const images = [];

  // Collect session directories
  let sessionDirs = [];
  if (sessionId) {
    sessionDirs = [validateSessionId(sessionId)];
  } else {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(STORAGE_BASE, PROJECT_ID), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") {
        return { images: [] };
      }
      throw e;
    }
    sessionDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  }

  for (const dir of sessionDirs) {
    const sessionDir = path.join(STORAGE_BASE, PROJECT_ID, dir);
    try {
      const files = fs.readdirSync(sessionDir);
      const jsonFiles = files.filter(f => f.endsWith(".json"));
      for (const jf of jsonFiles) {
        const metaRaw = fs.readFileSync(path.join(sessionDir, jf), "utf8");
        const meta = JSON.parse(metaRaw);
        images.push({
          id: jf.replace(".json", ""),
          description: meta.description || "",
          mime_type: meta.mimeType || "image/png",
          session_id: dir,
        });
      }
    } catch (e) {
      // skip inaccessible dirs
    }
  }

  return { images };
}

function handleImageGet(args) {
  const id = args.id;
  if (!id) throw new Error("Missing required parameter: \"id\"");

  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId.startsWith("img_")) throw new Error(`Invalid image ID: "${id}"`);

  const sessionId = args.session_id;

  // Determine which session directory to use
  let sessionDir;
  if (sessionId) {
    // Explicit session — use it directly
    sessionDir = path.join(STORAGE_BASE, PROJECT_ID, validateSessionId(sessionId));
    // Verify the session exists (will throw ENOENT if not)
    const stat = fs.statSync(sessionDir);
    if (!stat.isDirectory()) {
      throw new Error(`Session not found: ${sessionId}`);
    }
  } else {
    // No session_id — look for .session mapping file in all session dirs
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(STORAGE_BASE, PROJECT_ID), { withFileTypes: true });
    } catch (e) {
      if (e.code === "ENOENT") {
        throw new Error(`Image not found: ${safeId}`);
      }
      throw e;
    }
    let found = false;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionFilePath = path.join(STORAGE_BASE, PROJECT_ID, entry.name, safeId + ".session");
      if (fs.existsSync(sessionFilePath)) {
        // Read the mapped session ID from the file
        const mappedSessionId = fs.readFileSync(sessionFilePath, "utf8").trim();
        sessionDir = path.join(STORAGE_BASE, PROJECT_ID, mappedSessionId);
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`Image not found: ${safeId}`);
    }
  }

  // Load metadata and image data
  const metaPath = path.join(sessionDir, safeId + ".json");
  const dirFiles = fs.readdirSync(sessionDir);
  const imgFile = dirFiles.find(f => f.startsWith(safeId) && !f.endsWith(".json") && !f.endsWith(".session"));
  if (!imgFile) throw new Error(`No data file for image: ${safeId}`);

  const metaRaw = fs.readFileSync(metaPath, "utf8");
  const meta = JSON.parse(metaRaw);
  const dataPath = path.join(sessionDir, imgFile);
  const data = fs.readFileSync(dataPath);

  return {
    id: safeId,
    description: meta.description || "",
    mime_type: meta.mimeType || "image/png",
    data: data.toString("base64"),
  };
}

function handleImageGetUrl(args) {
  // Guard: validate required parameters (Law 1: Early Exit)
  if (!args.url) throw new Error("Missing required parameter: \"url\"");

  const source = args.url;

  // Support both URL and data URI sources
  const sourceType = detectSourceType(source);

  if (sourceType === "url") {
    // Download URL and return directly without storing
    return downloadUrl(source, URL_TIMEOUT_MS).then(({ buffer, mimeType }) => {
      return {
        mime_type: mimeType,
        data: buffer.toString("base64"),
      };
    });
  }

  if (sourceType === "base64") {
    const match = source.match(DATA_URI_RE);
    if (!match) {
      throw new Error("Invalid data URI format");
    }
    const mimeType = match[1];
    const base64Data = match[2];
    const buffer = Buffer.from(base64Data, "base64");

    if (buffer.length > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${buffer.length} bytes (max ${MAX_FILE_SIZE})`);
    }

    return {
      mime_type: mimeType,
      data: buffer.toString("base64"),
    };
  }

  throw new Error("image_get_url only supports http(s):// URLs or data: URIs");
}

function handleImageClearSession(args) {
  // Guard: validate required parameters (Law 1: Early Exit)
  if (!args.session_id) throw new Error("Missing required parameter: \"session_id\"");

  let sessionDir;
  try {
    sessionDir = getSessionDir(PROJECT_ID, args.session_id, false);
  } catch {
    // Invalid or malformed session ID - idempotent
    return { success: true };
  }

  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }

  return { success: true };
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "image_add",
    description:
      "Add an image from a URL, local file path, or base64 data URI. Stores the image and returns its ID.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          maxLength: 5000,
          description:
            "Image source: http(s):// URL, local file path, or data:image/... base64 URI",
        },
        session_id: {
          type: "string",
          description: "Session scope identifier (alphanumeric, hyphens, underscores)",
        },
        description: {
          type: "string",
          maxLength: 2000,
          description: "Optional description of the image",
        },
      },
      required: ["source", "session_id"],
    },
  },
  {
    name: "image_list",
    description: "List all images. session_id is optional — lists all images across all sessions if omitted.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Optional session scope. If omitted, lists all sessions." },
      },
      required: [],
    },
  },
  {
    name: "image_get",
    description: "Get an image by ID. If session_id is not provided, automatically finds the image across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Image ID (e.g. img_abc12345)" },
        session_id: { type: "string", description: "Optional session scope. If omitted, finds image automatically via session mapping." },
      },
      required: ["id"],
    },
  },
  {
    name: "image_get_url",
    description:
      "Download an image from a URL and return base64 data without storing it. Bypasses indexing.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Image URL (http(s)://) or data: URI to fetch",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "image_clear_session",
    description: "Remove all stored images for a session. Idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session scope identifier (alphanumeric, hyphens, underscores)",
        },
      },
      required: ["session_id"],
    },
  },
];

// ── Tool dispatch ──────────────────────────────────────────────────────────

function validateArgs(args, required) {
  for (const key of required) {
    if (args[key] === undefined || args[key] === null) {
      throw new Error(`Missing required parameter: "${key}"`);
    }
  }
}

function dispatchTool(name, args) {
  switch (name) {
    case "image_add": {
      validateArgs(args, ["source", "session_id"]);
      return handleImageAdd(args);
    }
    case "image_list": {
      return handleImageList(args);
    }
    case "image_get": {
      return handleImageGet(args);
    }
    case "image_get_url": {
      validateArgs(args, ["url"]);
      return handleImageGetUrl(args);
    }
    case "image_clear_session": {
      validateArgs(args, ["session_id"]);
      return handleImageClearSession(args);
    }
    default: {
      throw new Error(`Unknown tool: ${name}`);
    }
  }
}

// ── JSON-RPC message handler (async-capable) ──────────────────────────────

async function handleMessage(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    process.stderr.write("[image-mcp-server] Invalid JSON received, ignoring\n");
    return;
  }

  const id = request.id ?? null;
  const method = request.method;

  try {
    switch (method) {
      case "initialize": {
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "image-mcp-server", version: "1.0.0" },
          },
        };
        stdout.write(JSON.stringify(response) + "\n");
        break;
      }

      case "tools/list": {
        const response = {
          jsonrpc: "2.0",
          id,
          result: { tools: TOOLS },
        };
        stdout.write(JSON.stringify(response) + "\n");
        break;
      }

      case "tools/call": {
        const params = request.params || {};
        const toolName = params.name;
        const arguments_ = params.arguments || {};

        if (!toolName) {
          throw new Error("Missing tool name");
        }

        const result = await dispatchTool(toolName, arguments_);
        const response = {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        };
        stdout.write(JSON.stringify(response) + "\n");
        break;
      }

      case "notifications/initialized": {
        // No response needed for notifications
        break;
      }

      default: {
        // JSON-RPC 2.0 §2.4.2: Notifications must not receive a response
        if (id === null || id === undefined) break;

        const response = {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        };
        stdout.write(JSON.stringify(response) + "\n");
        break;
      }
    }
  } catch (err) {
    const errorResponse = {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32603,
        message: err.message,
      },
    };
    stdout.write(JSON.stringify(errorResponse) + "\n");
  }
}

// ── stdin processing with async-safe queue ──────────────────────────────────

const messageQueue = [];
let processingMessage = false;

function enqueueMessage(rawLine) {
  messageQueue.push(rawLine);
  processNextMessage();
}

async function processNextMessage() {
  if (processingMessage || messageQueue.length === 0) return;

  processingMessage = true;
  const line = messageQueue.shift();

  try {
    await handleMessage(line);
  } catch (err) {
    process.stderr.write(`[image-mcp-server] Error: ${err.message}\n`);
  }

  processingMessage = false;
  processNextMessage();
}

let buffer = "";

stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    enqueueMessage(line);
  }
});

stdin.on("end", () => process.exit(0));

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[image-mcp-server] Unhandled rejection: ${err.stack || err.message}\n`);
});

// Log startup info to stderr (not stdout) to avoid corrupting JSON-RPC output
process.stderr.write(
  `[image-mcp-server] Started. Project ID: ${PROJECT_ID}, Storage: ${STORAGE_BASE}\n`
);
