---
name: json-manipulation
description: Safe JSON and JSONC file manipulation via MCP tools. Read, modify, and comment on JSON/JSONC files without formatting errors.
---

# JSON/JSONC Manipulation Skill

## Overview

This skill provides structured MCP tools for reading and editing JSON and JSONC (JSON with Comments) files. Instead of editing files as raw text (which often breaks formatting), use these tools to manipulate the JSON tree structure safely.

## Available Tools

### General Principles

1.  **Path format**: Use `/` as separator. `/` alone is the root. Example: `/agents/coder/permission`
2.  **JSON vs JSONC**:
    -   Use `json_*` tools for strict `.json` files
    -   Use `jsonc_*` tools for `.jsonc` files (preserves comments and formatting)
3.  **File paths** are relative to the workspace root

### Read Tools (JSON + JSONC)

| Tool | Description | Key Parameters |
|------|-------------|---------------|
| `json_get_type` / `jsonc_get_type` | Get node type (object, array, string, number, boolean, null) | filePath, path |
| `json_get_value` / `jsonc_get_value` | Get the value at path | filePath, path |
| `json_get_array_size` / `jsonc_get_array_size` | Get length of an array | filePath, path |
| `json_get_array_element` / `jsonc_get_array_element` | Get element at index | filePath, path, index |
| `json_get_object_keys` / `jsonc_get_object_keys` | List property names and their types | filePath, path |

### Write Tools (JSON + JSONC)

| Tool | Description | Key Parameters |
|------|-------------|---------------|
| `json_set_value` / `jsonc_set_value` | Set value at path (creates intermediate objects) | filePath, path, value |
| `json_add_property` / `jsonc_add_property` | Add property (errors if exists) | filePath, path, key, value |
| `json_array_push` / `jsonc_array_push` | Append to end of array | filePath, path, value |
| `json_array_unshift` / `jsonc_array_unshift` | Prepend to beginning of array | filePath, path, value |
| `json_array_insert` / `jsonc_array_insert` | Insert at index | filePath, path, index, value |
| `json_array_remove` / `jsonc_array_remove` | Remove at index | filePath, path, index |
| `json_remove_property` / `jsonc_remove_property` | Remove a property | filePath, path, key |

### Comment Tools (JSONC only)

| Tool | Description | Key Parameters |
|------|-------------|---------------|
| `jsonc_get_comment` | Get comment above a node | filePath, path |
| `jsonc_set_comment` | Set/replace comment above a node | filePath, path, comment |
| `jsonc_remove_comment` | Remove comment above a node | filePath, path |

## Best Practices

1.  **Prefer exploring structure over getting values**: Use `json_get_object_keys` to understand the structure, then drill down node by node. Avoid using `json_get_value` with `/` (root) or large nodes.
2.  **Know your file type**: Check if the file is `.json` or `.jsonc`. Use the appropriate tool prefix.
3.  **For JSONC files**: Always use `jsonc_*` tools to preserve comments and formatting.
4.  **Error handling**: If a tool fails, read the error message carefully — it tells you exactly what's wrong (path not found, wrong type, index out of bounds, etc.).
5.  **Path syntax**: Array indices are numeric path segments. For example, to access the first element of `agents` array: `/agents/0`

## Examples

### Exploring a JSONC file structure
```
jsonc_get_object_keys({ filePath: "opencode.jsonc", path: "/agent" })
→ { properties: [{ key: "researcher", type: "object" }, { key: "coder", type: "object" }, ...] }
```

### Reading a specific value
```
jsonc_get_value({ filePath: "opencode.jsonc", path: "/agent/researcher/permission" })
→ { value: "{...}" }
```

### Modifying a value
```
jsonc_set_value({ filePath: "opencode.jsonc", path: "/mcp/jsonc/enabled", value: true })
→ { success: true }
```

### Adding a comment
```
jsonc_set_comment({ filePath: "opencode.jsonc", path: "/mcp/jsonc", comment: " JSON/JSONC manipulation server" })
→ { success: true }
```

### Working with arrays
```
json_get_array_size({ filePath: "config.json", path: "/items" })
→ { size: 5 }
json_array_push({ filePath: "config.json", path: "/items", value: { "id": 6, "name": "new" } })
→ { success: true }
```

## Limitations

-   JSON tools (`json_*`) reformat the file with standard 2-space indentation
-   JSONC tools (`jsonc_*`) preserve original formatting
-   Files larger than 50 MB are rejected for safety
-   Only files within the workspace can be accessed
