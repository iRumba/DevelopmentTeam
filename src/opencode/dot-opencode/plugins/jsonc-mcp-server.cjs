const fs = require("node:fs");
const path = require("node:path");
const { stdin, stdout } = require("node:process");

const WORKSPACE_ROOT = process.cwd();
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// jsonc-parser for JSONC operations
let jsoncParser;
try {
  jsoncParser = require("jsonc-parser");
} catch {
  console.error("jsonc-parser is not installed. JSONC tools will not work.");
  process.exit(1);
}

let buffer = "";

// ── Utility functions ──────────────────────────────────────────────────────

function parsePath(pathStr) {
  if (!pathStr || pathStr === "/") return [];
  return pathStr.split("/").filter(Boolean);
}

function safeResolve(filePath) {
  const resolved = path.resolve(WORKSPACE_ROOT, filePath);
  // Ensure the resolved path is within the workspace
  if (resolved.startsWith(WORKSPACE_ROOT)) {
    return resolved;
  }

  // Check additional allowed paths from environment variable
  const allowedRaw = process.env.JSONC_ALLOWED_PATHS || '';
  const allowedPaths = allowedRaw.split(';')
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => path.resolve(p));

  for (const allowedDir of allowedPaths) {
    if (resolved.startsWith(allowedDir)) {
      return resolved;
    }
  }

  throw new Error(`Access denied: path "${filePath}" is outside the workspace`);
}

function readFile(filePath) {
  const resolvedPath = safeResolve(filePath);
  const stats = fs.statSync(resolvedPath);
  if (stats.size > MAX_FILE_SIZE) {
    throw new Error(`File too large: ${stats.size} bytes (max ${MAX_FILE_SIZE})`);
  }
  return fs.readFileSync(resolvedPath, "utf-8");
}

function writeFile(filePath, content) {
  fs.writeFileSync(safeResolve(filePath), content, "utf-8");
  return { success: true };
}

function detectIndent(text) {
  const match = text.match(/^( {2,4}| {8}|\t)/m);
  if (match) {
    if (match[1] === "\t") return "\t";
    return match[1].length;
  }
  return 2;
}

/**
 * Navigate to a path in a parsed JSON object, optionally creating intermediate objects.
 */
function navigatePath(data, segments, createMissing = false) {
  let current = data;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      if (createMissing) {
        current = {};
      } else {
        throw new Error(
          `Cannot navigate: parent at /${segment} is not an object or array`,
        );
      }
    }
    if (Array.isArray(current)) {
      const idx = Number(segment);
      if (isNaN(idx)) {
        throw new Error(`Cannot navigate: /${segment} is not a valid array index`);
      }
      if (idx < 0 || idx >= current.length) {
        if (createMissing) {
          throw new Error(
            `Cannot create element at array index ${idx}: index out of bounds`,
          );
        }
        throw new Error(
          `Array index ${idx} out of bounds (length ${current.length})`,
        );
      }
      current = current[idx];
    } else if (typeof current === "object" && current !== null) {
      if (!(segment in current)) {
        if (createMissing) {
          current[segment] = {};
        } else {
          throw new Error(`Property "${segment}" not found in object`);
        }
      }
      current = current[segment];
    }
  }
  return current;
}

/**
 * Navigate to the parent of a path, returning { parent, key }.
 */
function navigateParent(data, segments) {
  if (segments.length === 0) {
    throw new Error("Cannot get parent of root");
  }
  const key = segments[segments.length - 1];
  const parent = navigatePath(data, segments.slice(0, -1));
  return { parent, key };
}

function getJsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function detectFormattingOptions(text) {
  const indent = detectIndent(text);
  if (indent === "\t") {
    return { insertSpaces: false, tabSize: 1 };
  }
  return { insertSpaces: true, tabSize: indent };
}

// ── Comment utilities for JSONC ────────────────────────────────────────────

function getCommentBeforeNode(text, nodeOffset) {
  const before = text.slice(0, nodeOffset);
  // Remove trailing whitespace (keep newlines to detect blank lines)
  const normalized = before.replace(/[ \t]+$/gm, "");
  const lines = normalized.split("\n");
  // Work backwards from the last lines
  const comments = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//")) {
      comments.unshift(trimmed.slice(2).trim());
    } else if (trimmed.startsWith("/*")) {
      const endIdx = trimmed.indexOf("*/");
      if (endIdx !== -1) {
        const commentText = trimmed.slice(2, endIdx).trim();
        // Handle multi-line block comments: collect any continuation
        if (comments.length > 0 && !comments[0].includes("\n")) {
          comments.unshift(commentText);
        } else {
          comments.unshift(commentText);
        }
      }
      break;
    } else if (trimmed.length > 0) {
      // Non-empty, non-comment line — stop
      break;
    }
  }
  return comments.length > 0 ? comments.join("\n") : null;
}

function getNodeAtPath(text, segments) {
  const errors = [];
  const tree = jsoncParser.parseTree(text, errors);
  if (!tree) {
    throw new Error("Failed to parse JSONC file");
  }
  if (errors.length > 0) {
    // Check for real errors (not just trailing commas etc.)
    const seriousErrors = errors.filter(
      (e) =>
        e.error === jsoncParser.ParseErrorCode.InvalidSymbol ||
        e.error === jsoncParser.ParseErrorCode.InvalidNumberFormat ||
        e.error === jsoncParser.ParseErrorCode.EndOfFileExpected,
    );
    if (seriousErrors.length > 0) {
      throw new Error("JSONC parse error at offset " + seriousErrors[0].offset);
    }
  }
  const node = jsoncParser.findNodeAtLocation(tree, segments);
  return { tree, node };
}

// ── JSON operations (for strict .json files) ───────────────────────────────

function jsonGetType(filePath, pathStr) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const value = navigatePath(data, segments);
  return { type: getJsonType(value) };
}

function jsonGetValue(filePath, pathStr) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const value = navigatePath(data, segments);
  return { value: JSON.stringify(value) };
}

function jsonGetArraySize(filePath, pathStr) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const value = navigatePath(data, segments);
  if (!Array.isArray(value)) {
    throw new Error("Value at path is not an array");
  }
  return { size: value.length };
}

function jsonGetArrayElement(filePath, pathStr, index) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const arr = navigatePath(data, segments);
  if (!Array.isArray(arr)) {
    throw new Error("Value at path is not an array");
  }
  if (index < 0 || index >= arr.length) {
    throw new Error(`Index ${index} out of bounds (length ${arr.length})`);
  }
  return { value: JSON.stringify(arr[index]) };
}

function jsonGetObjectKeys(filePath, pathStr) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const obj = navigatePath(data, segments);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Value at path is not an object");
  }
  const properties = Object.keys(obj).map((key) => ({
    key,
    type: getJsonType(obj[key]),
  }));
  return { properties };
}

function jsonModify(filePath, pathStr, newValue) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const parent = navigatePath(data, segments.slice(0, -1));
  const key = segments[segments.length - 1];
  if (segments.length === 0) {
    // Setting root
    return writeFile(filePath, JSON.stringify(newValue, null, detectIndent(text)));
  }
  if (Array.isArray(parent)) {
    const idx = Number(key);
    if (isNaN(idx)) throw new Error("Invalid array index");
    parent[idx] = newValue;
  } else if (parent !== null && typeof parent === "object") {
    parent[key] = newValue;
  } else {
    throw new Error("Cannot set value on non-object/non-array parent");
  }
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

function jsonAddProperty(filePath, pathStr, key, value) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const obj = navigatePath(data, segments);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Value at path is not an object");
  }
  if (key in obj) {
    throw new Error(`Property "${key}" already exists`);
  }
  obj[key] = value;
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

function jsonArrayPush(filePath, pathStr, value) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const arr = navigatePath(data, segments);
  if (!Array.isArray(arr)) {
    throw new Error("Value at path is not an array");
  }
  arr.push(value);
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

function jsonArrayUnshift(filePath, pathStr, value) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const arr = navigatePath(data, segments);
  if (!Array.isArray(arr)) {
    throw new Error("Value at path is not an array");
  }
  arr.unshift(value);
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

function jsonArrayInsert(filePath, pathStr, index, value) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const arr = navigatePath(data, segments);
  if (!Array.isArray(arr)) {
    throw new Error("Value at path is not an array");
  }
  if (index < 0 || index > arr.length) {
    throw new Error(`Index ${index} out of bounds (length ${arr.length})`);
  }
  arr.splice(index, 0, value);
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

function jsonArrayRemove(filePath, pathStr, index) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const arr = navigatePath(data, segments);
  if (!Array.isArray(arr)) {
    throw new Error("Value at path is not an array");
  }
  if (index < 0 || index >= arr.length) {
    throw new Error(`Index ${index} out of bounds (length ${arr.length})`);
  }
  arr.splice(index, 1);
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

function jsonRemoveProperty(filePath, pathStr, key) {
  const text = readFile(filePath);
  const data = JSON.parse(text);
  const segments = parsePath(pathStr);
  const obj = navigatePath(data, segments);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error("Value at path is not an object");
  }
  if (!(key in obj)) {
    throw new Error(`Property "${key}" not found`);
  }
  delete obj[key];
  return writeFile(filePath, JSON.stringify(data, null, detectIndent(text)));
}

// ── JSONC operations (for .jsonc files) ────────────────────────────────────

function jsoncGetType(filePath, pathStr) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");
  const jsonType = node.type === "property" ? "object" : node.type;
  return { type: jsonType };
}

function jsoncGetValue(filePath, pathStr) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");
  const value = jsoncParser.getNodeValue(node);
  return { value: JSON.stringify(value) };
}

function jsoncGetArraySize(filePath, pathStr) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");
  if (node.type !== "array") throw new Error("Value at path is not an array");
  return { size: node.children ? node.children.length : 0 };
}

function jsoncGetArrayElement(filePath, pathStr, index) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");
  if (node.type !== "array") throw new Error("Value at path is not an array");
  if (!node.children || index < 0 || index >= node.children.length) {
    throw new Error(`Index ${index} out of bounds`);
  }
  const value = jsoncParser.getNodeValue(node.children[index]);
  return { value: JSON.stringify(value) };
}

function jsoncGetObjectKeys(filePath, pathStr) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");
  if (node.type !== "object") throw new Error("Value at path is not an object");
  const properties = [];
  if (node.children) {
    for (const child of node.children) {
      if (child.type === "property") {
        const key = child.children ? child.children[0].value : "?";
        const valNode = child.children ? child.children[1] : null;
        const valType = valNode ? valNode.type : "unknown";
        properties.push({ key, type: valType });
      }
    }
  }
  return { properties };
}

function jsoncModify(filePath, pathStr, value, isArrayInsertion = false) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const formattingOptions = detectFormattingOptions(text);
  const edits = jsoncParser.modify(text, segments, value, {
    formattingOptions,
    isArrayInsertion,
  });
  const result = jsoncParser.applyEdits(text, edits);
  return writeFile(filePath, result);
}

function jsoncAddProperty(filePath, pathStr, key, value) {
  const segments = parsePath(pathStr);
  const propertyPath = [...segments, key];
  return jsoncModify(filePath, "/" + propertyPath.join("/"), value);
}

function jsoncArrayPush(filePath, pathStr, value) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node || node.type !== "array") {
    throw new Error("Value at path is not an array");
  }
  const index = node.children ? node.children.length : 0;
  const insertPath = [...segments, index];
  return jsoncModify(filePath, "/" + insertPath.join("/"), value, true);
}

function jsoncArrayUnshift(filePath, pathStr, value) {
  const segments = parsePath(pathStr);
  const insertPath = [...segments, 0];
  return jsoncModify(filePath, "/" + insertPath.join("/"), value, true);
}

function jsoncArrayInsert(filePath, pathStr, index, value) {
  const segments = parsePath(pathStr);
  const insertPath = [...segments, index];
  return jsoncModify(filePath, "/" + insertPath.join("/"), value, true);
}

function jsoncArrayRemove(filePath, pathStr, index) {
  const segments = parsePath(pathStr);
  const removePath = [...segments, index];
  return jsoncModify(filePath, "/" + removePath.join("/"), undefined);
}

function jsoncRemoveProperty(filePath, pathStr, key) {
  const segments = parsePath(pathStr);
  const propertyPath = [...segments, key];
  return jsoncModify(filePath, "/" + propertyPath.join("/"), undefined);
}

function jsoncGetComment(filePath, pathStr) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");
  const comment = getCommentBeforeNode(text, node.offset);
  return { comment };
}

function jsoncSetComment(filePath, pathStr, comment) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");

  // Check if there's already a comment before the node
  const existingComment = getCommentBeforeNode(text, node.offset);

  const beforeNode = text.slice(0, node.offset);
  const afterNode = text.slice(node.offset);

  if (existingComment !== null) {
    // Find and replace the existing comment
    const beforeTrimmed = beforeNode.replace(/[ \t]+$/gm, "");
    const lines = beforeTrimmed.split("\n");

    // Work backwards to find where comment lines start
    let commentStartLine = lines.length - 1;
    while (commentStartLine >= 0) {
      const trimmed = lines[commentStartLine].trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("/*")) {
        commentStartLine--;
      } else if (trimmed.length === 0) {
        commentStartLine--;
      } else {
        break;
      }
    }
    commentStartLine++;

    const beforeComment = lines.slice(0, commentStartLine).join("\n");
    const newContent =
      beforeComment +
      (beforeComment.length > 0 && !beforeComment.endsWith("\n") ? "\n" : "") +
      "// " +
      comment +
      "\n" +
      afterNode;

    return writeFile(filePath, newContent);
  }

  // Insert new comment before the node
  const beforeTrimmed = beforeNode.replace(/[ \t]+$/gm, "");
  const newContent =
    beforeTrimmed +
    (beforeTrimmed.length > 0 && !beforeTrimmed.endsWith("\n") ? "\n" : "") +
    "// " +
    comment +
    "\n" +
    afterNode;

  return writeFile(filePath, newContent);
}

function jsoncRemoveComment(filePath, pathStr) {
  const text = readFile(filePath);
  const segments = parsePath(pathStr);
  const { node } = getNodeAtPath(text, segments);
  if (!node) throw new Error("Path not found in JSONC file");

  const existingComment = getCommentBeforeNode(text, node.offset);
  if (existingComment === null) {
    return { success: true };
  }

  const beforeNode = text.slice(0, node.offset);
  const afterNode = text.slice(node.offset);

  const beforeTrimmed = beforeNode.replace(/[ \t]+$/gm, "");
  const lines = beforeTrimmed.split("\n");

  // Work backwards to find where comment lines start
  let commentStartLine = lines.length - 1;
  while (commentStartLine >= 0) {
    const trimmed = lines[commentStartLine].trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*")) {
      commentStartLine--;
    } else if (trimmed.length === 0) {
      commentStartLine--;
    } else {
      break;
    }
  }
  commentStartLine++;

  const beforeComment = lines.slice(0, commentStartLine).join("\n");
  const newContent =
    beforeComment +
    (beforeComment.length > 0 && !beforeComment.endsWith("\n") ? "\n" : "") +
    afterNode;

  return writeFile(filePath, newContent);
}

// ── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "json_get_type",
    description: "Returns the JSON type of a value at path in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Path to the JSON file",
        },
        path: {
          type: "string",
          description: "JSON path, e.g. /agents/coder",
        },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "json_get_value",
    description: "Returns the JSON value at path in a .json file (serialized as JSON string)",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "json_get_array_size",
    description: "Returns the length of an array at path in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "json_get_array_element",
    description: "Returns an array element at index in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        index: { type: "number" },
      },
      required: ["filePath", "path", "index"],
    },
  },
  {
    name: "json_get_object_keys",
    description: "Lists property keys with their types in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "json_set_value",
    description: "Sets a value at path in a .json file. Creates intermediate objects if needed.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        value: { description: "The JSON value to set" },
      },
      required: ["filePath", "path", "value"],
    },
  },
  {
    name: "json_add_property",
    description: "Adds a property to an object in a .json file. Errors if property already exists.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        key: { type: "string" },
        value: { description: "The JSON value for the new property" },
      },
      required: ["filePath", "path", "key", "value"],
    },
  },
  {
    name: "json_array_push",
    description: "Appends an element to the end of an array in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        value: { description: "The JSON value to append" },
      },
      required: ["filePath", "path", "value"],
    },
  },
  {
    name: "json_array_unshift",
    description: "Prepends an element to the beginning of an array in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        value: { description: "The JSON value to prepend" },
      },
      required: ["filePath", "path", "value"],
    },
  },
  {
    name: "json_array_insert",
    description: "Inserts an element at a specific index in an array in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        index: { type: "number" },
        value: { description: "The JSON value to insert" },
      },
      required: ["filePath", "path", "index", "value"],
    },
  },
  {
    name: "json_array_remove",
    description: "Removes an element at a specific index from an array in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        index: { type: "number" },
      },
      required: ["filePath", "path", "index"],
    },
  },
  {
    name: "json_remove_property",
    description: "Removes a property from an object in a .json file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        key: { type: "string" },
      },
      required: ["filePath", "path", "key"],
    },
  },
  {
    name: "jsonc_get_type",
    description: "Returns the JSONC type of a value at path in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "jsonc_get_value",
    description: "Returns the JSONC value at path in a .jsonc file (serialized as JSON string)",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "jsonc_get_array_size",
    description: "Returns the length of an array at path in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "jsonc_get_array_element",
    description: "Returns an array element at index in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        index: { type: "number" },
      },
      required: ["filePath", "path", "index"],
    },
  },
  {
    name: "jsonc_get_object_keys",
    description: "Lists property keys with their types in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "jsonc_set_value",
    description: "Sets a value at path in a .jsonc file. Preserves comments and formatting.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        value: { description: "The JSON value to set" },
      },
      required: ["filePath", "path", "value"],
    },
  },
  {
    name: "jsonc_add_property",
    description: "Adds a property to an object in a .jsonc file. Errors if property already exists.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        key: { type: "string" },
        value: { description: "The JSON value for the new property" },
      },
      required: ["filePath", "path", "key", "value"],
    },
  },
  {
    name: "jsonc_array_push",
    description: "Appends an element to the end of an array in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        value: { description: "The JSON value to append" },
      },
      required: ["filePath", "path", "value"],
    },
  },
  {
    name: "jsonc_array_unshift",
    description: "Prepends an element to the beginning of an array in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        value: { description: "The JSON value to prepend" },
      },
      required: ["filePath", "path", "value"],
    },
  },
  {
    name: "jsonc_array_insert",
    description: "Inserts an element at a specific index in an array in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        index: { type: "number" },
        value: { description: "The JSON value to insert" },
      },
      required: ["filePath", "path", "index", "value"],
    },
  },
  {
    name: "jsonc_array_remove",
    description: "Removes an element at a specific index from an array in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        index: { type: "number" },
      },
      required: ["filePath", "path", "index"],
    },
  },
  {
    name: "jsonc_remove_property",
    description: "Removes a property from an object in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        key: { type: "string" },
      },
      required: ["filePath", "path", "key"],
    },
  },
  {
    name: "jsonc_get_comment",
    description: "Gets the comment above a node in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
    },
  },
  {
    name: "jsonc_set_comment",
    description: "Sets/replaces the comment above a node in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
        comment: { type: "string" },
      },
      required: ["filePath", "path", "comment"],
    },
  },
  {
    name: "jsonc_remove_comment",
    description: "Removes the comment above a node in a .jsonc file",
    inputSchema: {
      type: "object",
      properties: {
        filePath: { type: "string" },
        path: { type: "string" },
      },
      required: ["filePath", "path"],
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
    // JSON tools
    case "json_get_type": {
      validateArgs(args, ["filePath", "path"]);
      return jsonGetType(args.filePath, args.path);
    }
    case "json_get_value": {
      validateArgs(args, ["filePath", "path"]);
      return jsonGetValue(args.filePath, args.path);
    }
    case "json_get_array_size": {
      validateArgs(args, ["filePath", "path"]);
      return jsonGetArraySize(args.filePath, args.path);
    }
    case "json_get_array_element": {
      validateArgs(args, ["filePath", "path", "index"]);
      return jsonGetArrayElement(args.filePath, args.path, args.index);
    }
    case "json_get_object_keys": {
      validateArgs(args, ["filePath", "path"]);
      return jsonGetObjectKeys(args.filePath, args.path);
    }
    case "json_set_value": {
      validateArgs(args, ["filePath", "path", "value"]);
      return jsonModify(args.filePath, args.path, args.value);
    }
    case "json_add_property": {
      validateArgs(args, ["filePath", "path", "key", "value"]);
      return jsonAddProperty(args.filePath, args.path, args.key, args.value);
    }
    case "json_array_push": {
      validateArgs(args, ["filePath", "path", "value"]);
      return jsonArrayPush(args.filePath, args.path, args.value);
    }
    case "json_array_unshift": {
      validateArgs(args, ["filePath", "path", "value"]);
      return jsonArrayUnshift(args.filePath, args.path, args.value);
    }
    case "json_array_insert": {
      validateArgs(args, ["filePath", "path", "index", "value"]);
      return jsonArrayInsert(args.filePath, args.path, args.index, args.value);
    }
    case "json_array_remove": {
      validateArgs(args, ["filePath", "path", "index"]);
      return jsonArrayRemove(args.filePath, args.path, args.index);
    }
    case "json_remove_property": {
      validateArgs(args, ["filePath", "path", "key"]);
      return jsonRemoveProperty(args.filePath, args.path, args.key);
    }

    // JSONC tools
    case "jsonc_get_type": {
      validateArgs(args, ["filePath", "path"]);
      return jsoncGetType(args.filePath, args.path);
    }
    case "jsonc_get_value": {
      validateArgs(args, ["filePath", "path"]);
      return jsoncGetValue(args.filePath, args.path);
    }
    case "jsonc_get_array_size": {
      validateArgs(args, ["filePath", "path"]);
      return jsoncGetArraySize(args.filePath, args.path);
    }
    case "jsonc_get_array_element": {
      validateArgs(args, ["filePath", "path", "index"]);
      return jsoncGetArrayElement(args.filePath, args.path, args.index);
    }
    case "jsonc_get_object_keys": {
      validateArgs(args, ["filePath", "path"]);
      return jsoncGetObjectKeys(args.filePath, args.path);
    }
    case "jsonc_set_value": {
      validateArgs(args, ["filePath", "path", "value"]);
      return jsoncModify(args.filePath, args.path, args.value);
    }
    case "jsonc_add_property": {
      validateArgs(args, ["filePath", "path", "key", "value"]);
      return jsoncAddProperty(args.filePath, args.path, args.key, args.value);
    }
    case "jsonc_array_push": {
      validateArgs(args, ["filePath", "path", "value"]);
      return jsoncArrayPush(args.filePath, args.path, args.value);
    }
    case "jsonc_array_unshift": {
      validateArgs(args, ["filePath", "path", "value"]);
      return jsoncArrayUnshift(args.filePath, args.path, args.value);
    }
    case "jsonc_array_insert": {
      validateArgs(args, ["filePath", "path", "index", "value"]);
      return jsoncArrayInsert(args.filePath, args.path, args.index, args.value);
    }
    case "jsonc_array_remove": {
      validateArgs(args, ["filePath", "path", "index"]);
      return jsoncArrayRemove(args.filePath, args.path, args.index);
    }
    case "jsonc_remove_property": {
      validateArgs(args, ["filePath", "path", "key"]);
      return jsoncRemoveProperty(args.filePath, args.path, args.key);
    }
    case "jsonc_get_comment": {
      validateArgs(args, ["filePath", "path"]);
      return jsoncGetComment(args.filePath, args.path);
    }
    case "jsonc_set_comment": {
      validateArgs(args, ["filePath", "path", "comment"]);
      return jsoncSetComment(args.filePath, args.path, args.comment);
    }
    case "jsonc_remove_comment": {
      validateArgs(args, ["filePath", "path"]);
      return jsoncRemoveComment(args.filePath, args.path);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── JSON-RPC message handler ───────────────────────────────────────────────

function handleMessage(rawLine) {
  const trimmed = rawLine.trim();
  if (!trimmed) return;

  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    // Invalid JSON - ignore
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
            serverInfo: { name: "jsonc-mcp-server", version: "1.0.0" },
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

        const result = dispatchTool(toolName, arguments_);
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
        // No response needed
        break;
      }

      default: {
        // Unknown method
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

// ── stdin processing ───────────────────────────────────────────────────────

stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    handleMessage(line);
  }
});

stdin.on("end", () => process.exit(0));

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err.message);
});
