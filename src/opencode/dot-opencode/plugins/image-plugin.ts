/**
 * image-plugin
 * Image indexing and injection for OpenCode
 *
 * Intercepts messages with images, indexes them directly to the filesystem,
 * and injects image IDs into chat prompts so agents can reference them.
 *
 * Architecture:
 * - Listens for message.part.updated events (primary) to detect user-attached images as FileParts
 * - Falls back to message.updated events for legacy event shapes  
 * - Indexes images by writing them to ~/.local/share/opencode/images/<projectId>/<rootSessionId>/
 * - Injects image IDs into chat.message output for agent awareness
 * - Cleans up on session.idle by removing the session's image directory
 *
 * Plugin-native tools handle reading for agents (visual-reviewer).
 *
 * Philosophy: Elegant Defense (Guard Clauses, Fail Fast, Intentional Naming)
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"
import * as os from "node:os"
import * as https from "node:https"
import * as http from "node:http"

import { type Plugin, tool } from "@opencode-ai/plugin"
import type { OpencodeClient } from "./kdco-primitives/types"
import { getProjectId } from "./kdco-primitives/get-project-id"

// ==========================================
// DEBUG LOGGING HELPER
// ==========================================

/** Debug logging helper - logs to opencode app log with image-plugin service */
async function debugLog(client: OpencodeClient, message: string, data?: unknown): Promise<void> {
	client.app.log({
		body: {
			service: "image-plugin",
			level: "info",
			message: data ? `${message} ${JSON.stringify(data)}` : message,
		},
	}).catch(() => {})
}

// ==========================================
// IN-MEMORY STATE
// ==========================================

/** Maps root session ID → image IDs attached in that session */
const imageMap = new Map<string, string[]>()

/** Cache: session ID → root session ID (avoids repeated parent traversal) */
const rootSessionCache = new Map<string, string>()

// ==========================================
// ROOT SESSION RESOLUTION
// ==========================================

const MAX_PARENT_DEPTH = 10

/**
 * Resolves the root session ID by walking up the parent chain.
 * Caches results to avoid redundant traversal.
 *
 * @param client - OpenCode client for session API calls
 * @param sessionID - The session ID to resolve
 * @returns The root session ID (session without a parent)
 * @throws If sessionID is empty or resolution fails
 */
async function getRootSessionID(
	client: OpencodeClient,
	sessionID: string,
): Promise<string> {
	// Guard: sessionID required (Law 1: Early Exit, Law 4: Fail Fast)
	if (!sessionID || typeof sessionID !== "string") {
		throw new Error(
			`getRootSessionID: sessionID is required, received ${typeof sessionID}`,
		)
	}

	// Debug: log parent chain traversal
	await debugLog(client, `getRootSessionID: starting traversal from ${sessionID}`)

	// Check cache first
	const cached = rootSessionCache.get(sessionID)
	if (cached) {
		await debugLog(client, `getRootSessionID: cache hit for ${sessionID} -> ${cached}`)
		return cached
	}

	let currentID = sessionID
	let lastValidID = currentID

	for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
		try {
			const session = await client.session.get({
				path: { id: currentID },
			})

			await debugLog(client, `getRootSessionID: depth=${depth}, id=${currentID}, hasParent=${!!session.data?.parentID}`)

			if (!session.data?.parentID) {
				// Cache the result for this session and all ancestors
				rootSessionCache.set(sessionID, currentID)
				await debugLog(client, `getRootSessionID: resolved root for ${sessionID} -> ${currentID}`)
				return currentID
			}

			lastValidID = currentID
			currentID = session.data.parentID
		} catch {
			// Fail-safe: if session fetch fails, return the deepest ID we found
			rootSessionCache.set(sessionID, lastValidID)
			await debugLog(client, `getRootSessionID: fetch failed, returning deepest ID ${lastValidID} for ${sessionID}`)
			return lastValidID
		}
	}

	// Guard: Maximum depth exceeded (Law 4: Fail Fast - but here we log and return best effort)
	rootSessionCache.set(sessionID, currentID)
	return currentID
}

// ==========================================
// IMAGE PART DETECTION
// ==========================================

/**
 * Checks if a part contains an image URL reference.
 * Handles multiple part shapes for resilience across SDK versions.
 *
 * @param part - A message part to inspect
 * @returns The image URL if found, null otherwise
 */
function extractImageUrl(part: Record<string, unknown>): string | null {
	const partType = part.type

	// FilePart: { type: "file", mime: "image/...", url: "..." }
	if (partType === "file") {
		const mime = part.mime as string | undefined
		if (typeof mime === "string" && mime.startsWith("image/")) {
			const url = part.url as string | undefined
			if (url) return url
		}
	}

	// Standard: { type: "image_url", image_url: { url: string } }
	if (partType === "image_url") {
		const imageUrl = part.image_url as { url?: string } | undefined
		if (imageUrl?.url) return imageUrl.url
	}

	// Fallback: { type: "image", url: string } or { type: "image", image_url: { url: string } }
	if (partType === "image") {
		const url = part.url as string | undefined
		if (url) return url
		const imageUrl = part.image_url as { url?: string } | undefined
		if (imageUrl?.url) return imageUrl.url
	}

	// Fallback: direct mimeType check for raw data (M2: runtime type guard)
	if (typeof part.mimeType === "string" && part.mimeType.startsWith("image/")) {
		const imageUrl = part.image_url as { url?: string } | undefined
		if (imageUrl?.url) return imageUrl.url
		const url = part.url as string | undefined
		if (url) return url
	}

	// Catch-all: any part with image_url.url (regardless of type)
	const imageUrl = part.image_url as { url?: string } | undefined
	if (imageUrl?.url) return imageUrl.url

	return null
}

// ==========================================
// FILESYSTEM STORAGE HELPERS
// ==========================================

/**
 * Compute the storage base directory for images.
 */
function getStorageBase(projectId: string): string {
	return path.join(os.homedir(), ".local", "share", "opencode", "images", projectId)
}

/**
 * Download an image from a URL with 10s timeout.
 */
function downloadUrl(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
	return new Promise((resolve, reject) => {
		const protocol = url.startsWith("https") ? https : http
		const req = protocol.get(url, { timeout: 10000 }, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				// Follow redirect
				return resolve(downloadUrl(res.headers.location))
			}
			if (!res.statusCode || res.statusCode >= 400) {
				return reject(new Error(`HTTP ${res.statusCode}: ${url}`))
			}
			const chunks: Buffer[] = []
			res.on("data", (chunk: Buffer) => chunks.push(chunk))
			res.on("end", () => {
				const buffer = Buffer.concat(chunks)
				const contentType = res.headers["content-type"] || "image/png"
				resolve({ buffer, mimeType: contentType })
			})
		})
		req.on("error", reject)
		req.on("timeout", () => { req.destroy(); reject(new Error(`Timeout: ${url}`)) })
	})
}

/**
 * Map MIME type to file extension.
 */
function getExtension(mimeType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/jpg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
		"image/svg+xml": "svg",
		"image/bmp": "bmp",
	}
	return map[mimeType] || "bin"
}

/**
 * Map file extension to MIME type (inverse of getExtension).
 */
const EXTENSION_MIME_MAP: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".bmp": "image/bmp",
}

// ==========================================
// EXTRACTED BASE HELPERS
// ==========================================

/**
 * Scans all session subdirectories for an image matching the given ID.
 * Reads metadata JSON for mime type and returns the raw buffer.
 *
 * @param id - Image ID (format: img_<hex_hash>)
 * @param projectId - Project ID for storage directory scoping
 * @returns { buffer, mimeType } or null if not found
 */
async function getImageDataUri(
	id: string,
	projectId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
	// Guard: id must start with "img_" (Law 1: Early Exit, Law 4: Fail Fast)
	if (!id || !id.startsWith("img_")) return null

	const baseDir = getStorageBase(projectId)

	// Scan all session directories
	let entries: string[]
	try {
		entries = await fs.readdir(baseDir)
	} catch {
		return null
	}

	for (const entry of entries) {
		const sessionDir = path.join(baseDir, entry)
		let dirEntries: string[]
		try {
			dirEntries = await fs.readdir(sessionDir)
		} catch {
			continue
		}

		// Look for image file matching the ID (skip .json and .session files)
		const imgFile = dirEntries.find(
			(f) => f.startsWith(id) && !f.endsWith(".json") && !f.endsWith(".session"),
		)
		if (!imgFile) continue

		// Read metadata for mime type
		const metaFile = dirEntries.find((f) => f === `${id}.json`)
		let mimeType = "image/png"
		if (metaFile) {
			try {
				const metaRaw = await fs.readFile(path.join(sessionDir, metaFile), "utf-8")
				const meta = JSON.parse(metaRaw)
				if (meta.mimeType) mimeType = meta.mimeType
			} catch {
				/* use default */
			}
		}

		// Read the image buffer
		const dataPath = path.join(sessionDir, imgFile)
		const buffer = await fs.readFile(dataPath)
		return { buffer, mimeType }
	}

	return null
}

/**
 * Fetches image data from a URL, data URI, or local file path.
 *
 * Supported sources:
 * - http(s):// URLs → downloads via downloadUrl()
 * - data:image/...;base64,... → parses inline data
 * - Local file paths → reads from filesystem, detects mime from extension
 *
 * @param url - Image source URL, data URI, or file path
 * @returns { buffer, mimeType } or null on failure
 */
async function fetchImageFromUrl(
	url: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
	try {
		if (url.startsWith("http://") || url.startsWith("https://")) {
			return await downloadUrl(url)
		}

		if (url.startsWith("data:")) {
			const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
			if (!match) return null
			return {
				buffer: Buffer.from(match[2], "base64"),
				mimeType: match[1],
			}
		}

		// Local file path: read and detect mime from extension
		const ext = path.extname(url).toLowerCase()
		const mimeType = EXTENSION_MIME_MAP[ext] || "image/png"
		const buffer = await fs.readFile(url)
		return { buffer, mimeType }
	} catch {
		return null
	}
}

/**
 * Converts a buffer and mime type to a data URI string.
 *
 * @param buffer - Image binary data
 * @param mimeType - MIME type (e.g. "image/png")
 * @returns data URI string like "data:image/png;base64,..."
 */
function toDataUri(buffer: Buffer, mimeType: string): string {
	return `data:${mimeType};base64,${buffer.toString("base64")}`
}

/**
 * Parse a duration string like "2d", "2d10h30m", "5d", "30m" into total milliseconds.
 * Returns -1 if the string is invalid.
 * Supported units: d (days), h (hours), m (minutes)
 * Examples:
 *   "2d" → 172800000
 *   "2d10h30m" → 207000000
 *   "30m" → 1800000
 *   "5d" → 432000000
 */
function parseDuration(duration: string): number {
	const regex = /^(\d+d)?(\d+h)?(\d+m)?$/
	const match = duration.match(regex)
	if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
		return -1
	}

	let total = 0
	if (match[1]) total += parseInt(match[1]) * 24 * 60 * 60 * 1000  // days
	if (match[2]) total += parseInt(match[2]) * 60 * 60 * 1000       // hours
	if (match[3]) total += parseInt(match[3]) * 60 * 1000            // minutes
	return total
}

// ==========================================
// IMAGE INDEXING (FILESYSTEM)
// ==========================================

/**
 * Indexes an image by writing it to the filesystem.
 * Uses SHA-256 content addressing for idempotent storage.
 * Logs a warning if indexing fails (non-fatal).
 *
 * The image is stored at:
 *   ~/.local/share/opencode/images/<projectId>/<rootSessionId>/
 *     img_<sha256_prefix>.<ext>
 *     img_<sha256_prefix>.json   (metadata)
 *
 * @param client - OpenCode client for logging
 * @param imageUrl - The image URL or data URI to index
 * @param rootSessionID - The root session ID for scoping
 * @param storageBase - The base storage directory for images
 * @returns The image ID if indexed, null otherwise
 */
async function indexImage(
	client: OpencodeClient,
	imageUrl: string,
	rootSessionID: string,
	storageBase: string,
): Promise<string | null> {
	try {
		let buffer: Buffer
		let mimeType: string

		if (imageUrl.startsWith("data:")) {
			// Data URI: extract base64 and mime type
			const match = imageUrl.match(/^data:(image\/[^;]+);base64,(.+)$/)
			if (!match) return null
			mimeType = match[1]
			buffer = Buffer.from(match[2], "base64")
			if (buffer.length === 0) return null
		} else if (imageUrl.startsWith("http://") || imageUrl.startsWith("https://")) {
			// Remote URL: download
			const result = await downloadUrl(imageUrl)
			buffer = result.buffer
			mimeType = result.mimeType
		} else {
			return null // Unsupported source type
		}

		// Compute SHA-256 hash for content-addressed ID
		const hash = crypto.createHash("sha256").update(buffer).digest("hex")
		const shortHash = hash.slice(0, 8)
		const ext = getExtension(mimeType)

		// Storage: ~/.local/share/opencode/images/<projectId>/<rootSessionId>/
		const sessionDir = path.join(storageBase, rootSessionID)
		await fs.mkdir(sessionDir, { recursive: true })

		const imageId = `img_${shortHash}`
		const imagePath = path.join(sessionDir, `${imageId}.${ext}`)
		const metaPath = path.join(sessionDir, `${imageId}.json`)

		// Check if already exists (idempotent)
		try {
			await fs.access(imagePath)
		} catch {
			// Doesn't exist, create
			// Save image file
			await fs.writeFile(imagePath, buffer)

			// Save metadata
			await fs.writeFile(metaPath, JSON.stringify({
				source: imageUrl.slice(0, 100),
				mimeType,
				timestamp: new Date().toISOString(),
			}, null, 2))
		}

		return imageId
	} catch (error) {
		client.app.log({
			body: {
				service: "image-plugin",
				level: "warn",
				message: `indexImage: failed to index image: ${error instanceof Error ? error.message : String(error)}`,
			},
		}).catch(() => {})
		return null
	}
}

/**
 * Clears all indexed images for a session by removing the session directory.
 * Non-fatal: logs a warning if the directory cannot be removed.
 *
 * @param storageBase - The base storage directory for images
 * @param rootSessionID - The root session ID to clear images for
 */
async function clearSessionImages(storageBase: string, rootSessionID: string): Promise<void> {
	const sessionDir = path.join(storageBase, rootSessionID)
	try {
		await fs.rm(sessionDir, { recursive: true, force: true })
	} catch {
		// Directory may not exist
	}
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

const ImagePlugin: Plugin = async (ctx) => {
	const { client, directory } = ctx

	// Compute project ID and storage base
	const projectId = await getProjectId(directory)
	const storageBase = getStorageBase(projectId)

	/**
	 * Handle message.updated events: monitor session activity.
	 * This is a tracking-only function — image detection is done in handleMessagePartUpdated.
	 * Kept as a fallback in case other event shapes carry parts in the future.
	 */
	async function handleMessageUpdated(event: Record<string, unknown>): Promise<void> {
		const properties = event.properties as Record<string, unknown> | undefined

		// Guard: properties required (Law 1: Early Exit)
		if (!properties || typeof properties !== "object") {
			await debugLog(client as unknown as OpencodeClient, `handleMessageUpdated: early exit - no properties`)
			return
		}

		const info = properties.info as Record<string, unknown> | undefined

		// Extract sessionID from info (EventMessageUpdated shape: properties.info.sessionID)
		const sessionID = info?.sessionID as string | undefined

		// Guard: sessionID required (Law 1: Early Exit)
		if (!sessionID) {
			await debugLog(client as unknown as OpencodeClient, `handleMessageUpdated: early exit - no sessionID`)
			return
		}

		// Monitor: log that a message was updated for this session
		await debugLog(client as unknown as OpencodeClient, `handleMessageUpdated: session ${sessionID}`)
	}

	/**
	 * Handle message.part.updated events: detect images in new parts and index them.
	 * This is the primary image detection path — the SDK fires this when image parts are created.
	 */
	async function handleMessagePartUpdated(properties: Record<string, unknown>): Promise<void> {
		// Extract part from properties
		const part = properties?.part as Record<string, unknown> | undefined

		// Guard: part required (Law 1: Early Exit)
		if (!part || typeof part !== "object") {
			await debugLog(client as unknown as OpencodeClient, `handleMessagePartUpdated: early exit - no part`)
			return
		}

		// Extract session ID from part (FilePart carries sessionID directly)
		const sessionID = part.sessionID as string | undefined

		// Guard: sessionID required (Law 1: Early Exit)
		if (!sessionID) {
			await debugLog(client as unknown as OpencodeClient, `handleMessagePartUpdated: early exit - no sessionID`)
			return
		}

		// Extract image URL from the part (handles FilePart, image_url, etc.)
		const imageUrl = extractImageUrl(part as Record<string, unknown>)

		// Guard: no image URL found (Law 1: Early Exit)
		if (!imageUrl) return

		// Resolve root session ID for scoping
		const rootSessionID = await getRootSessionID(client as unknown as OpencodeClient, sessionID)

		// Index the image to filesystem
		const imageId = await indexImage(client as unknown as OpencodeClient, imageUrl, rootSessionID, storageBase)

		// Guard: indexing failed (Law 1: Early Exit)
		if (!imageId) return

		// Store in the in-memory map (append to existing entries, deduplicate)
		const existingIds = imageMap.get(rootSessionID) ?? []
		if (!existingIds.includes(imageId)) {
			imageMap.set(rootSessionID, [...existingIds, imageId])
		}

		await debugLog(client as unknown as OpencodeClient, `handleMessagePartUpdated: indexed image ${imageId} for session ${rootSessionID}`)
	}

	/**
	 * Handle session.idle events: clean up in-memory state.
	 * Images on disk are NOT deleted — they're content-addressed and
	 * may be referenced by other sessions. The in-memory map is cleaned
	 * up to free memory, but files persist until explicitly cleaned up
	 * via the cleanup_images tool.
	 */
	async function handleSessionIdle(event: Record<string, unknown>): Promise<void> {
		const properties = event.properties as Record<string, unknown> | undefined

		// Guard: properties required (Law 1: Early Exit)
		if (!properties || typeof properties !== "object") return

		const sessionID = properties.sessionID as string | undefined

		// Guard: sessionID required (Law 1: Early Exit)
		if (!sessionID) return

		const rootSessionID = await getRootSessionID(client as unknown as OpencodeClient, sessionID)

		// M1: Only clean up if the idle session IS the root session.
		if (sessionID !== rootSessionID) return

		// M2: Do NOT delete images from disk — they're content-addressed and
		// may be needed by other sessions. The in-memory map is cleaned up
		// to free memory, but files persist until explicitly cleaned up.

		// Clean up in-memory state only
		imageMap.delete(rootSessionID)

		for (const [cachedSessionID, cachedRootID] of rootSessionCache) {
			if (cachedRootID === rootSessionID) {
				rootSessionCache.delete(cachedSessionID)
			}
		}

		client.app
			.log({
				body: {
					service: "image-plugin",
					level: "info",
					message: `Cleaned up in-memory state for session ${rootSessionID}, images preserved on disk`,
				},
			})
			.catch(() => {})
	}

	return {
		event: async ({ event }: { event: Record<string, unknown> }): Promise<void> => {
			const eventType = event.type as string | undefined
			const eventSessionID = (event.properties as Record<string, unknown> | undefined)?.sessionID as string | undefined

			// Log every event
			await debugLog(client as unknown as OpencodeClient, `Event received: type=${eventType}, sessionID=${eventSessionID}`)
			await debugLog(client as unknown as OpencodeClient, `Event keys: ${Object.keys(event).join(", ")}`, {
				hasProperties: !!event.properties,
				propertiesKeys: event.properties ? Object.keys(event.properties as object) : [],
			})

			// Guard: event type required (Law 1: Early Exit)
			if (!eventType) return

			if (eventType === "message.updated") {
				await handleMessageUpdated(event)
			} else if (eventType === "message.part.updated") {
				await handleMessagePartUpdated(event.properties as Record<string, unknown>)
			} else if (eventType === "session.idle") {
				await handleSessionIdle(event)
			} else if (eventType === "session.status") {
				const properties = event.properties as Record<string, unknown> | undefined
				const status = properties?.status as Record<string, unknown> | undefined
				if (status?.type === "idle") {
					// Normalize to session.idle shape for reuse
					await handleSessionIdle({
						...event,
						type: "session.idle",
						properties: {
							sessionID: (event.properties as Record<string, unknown>)?.sessionID,
						},
					})
				}
			}
		},

		"chat.message": async (
			input: { sessionID?: string; agent?: string },
			output: { parts?: Array<{ type: string; text?: string; id?: string; sessionID?: string; messageID?: string; mime?: string; url?: string }> },
		): Promise<void> => {
			// ──────────────────────────────────────────────────────
			// MARKER DETECTION: runs BEFORE the sessionID guard
			// so orchestrator-written [img id=xxx] markers are resolved
			// even if sessionID is unavailable.
			// Only resolve for visual-reviewer (vision-capable agent).
			// Other agents (build, coder) are text-only — markers stay
			// as plain text for them to pass through to visual-reviewer.
			// ──────────────────────────────────────────────────────
			if (input.agent === "visual-reviewer" && output.parts && output.parts.length > 0) {
				const imgIdRegex = /\[img id=(img_[a-f0-9]+)\]/g
				const imgUrlRegex = /\[img url=([^\]]+)\]/g

				// Scan parts in reverse to preserve insertion order
				for (let i = output.parts.length - 1; i >= 0; i--) {
					const part = output.parts[i]
					if (part.type !== "text" || !part.text) continue

					let text = part.text
					let hasChanges = false

					// Process [img id=xxx] markers
					const idMatches = [...text.matchAll(imgIdRegex)]
					for (const match of idMatches) {
						const [fullMatch, imageId] = match

						try {
							const pid = await getProjectId(directory)
							const imageData = await getImageDataUri(imageId, pid)

							if (!imageData) continue // Leave marker as-is if unresolvable

							const dataUri = toDataUri(imageData.buffer, imageData.mimeType)

							// Replace marker text with empty string
							text = text.replace(fullMatch, "")
							hasChanges = true

							// Insert FilePart right before the original text part
							const filePart = {
								type: "file",
								mime: imageData.mimeType,
								url: dataUri,
								id: `prt_img_${Date.now()}`,
								sessionID: part.sessionID || input.sessionID || "",
								messageID: part.messageID || "",
							}
							output.parts.splice(i, 0, filePart)
						} catch {
							continue // Leave marker as-is on error
						}
					}

					// Reset regex lastIndex after previous scan
					imgUrlRegex.lastIndex = 0

					// Process [img url=...] markers
					const urlMatches = [...text.matchAll(imgUrlRegex)]
					for (const match of urlMatches) {
						const [fullMatch, imageUrl] = match

						try {
							const imageData = await fetchImageFromUrl(imageUrl)

							if (!imageData) continue // Leave marker as-is if unresolvable

							const dataUri = toDataUri(imageData.buffer, imageData.mimeType)

							// Replace marker text with empty string
							text = text.replace(fullMatch, "")
							hasChanges = true

							// Insert FilePart right before the original text part
							const filePart = {
								type: "file",
								mime: imageData.mimeType,
								url: dataUri,
								id: `prt_img_${Date.now()}`,
								sessionID: part.sessionID || input.sessionID || "",
								messageID: part.messageID || "",
							}
							output.parts.splice(i, 0, filePart)
						} catch {
							continue // Leave marker as-is on error
						}
					}

					if (hasChanges) {
						part.text = text
					}
				}
			}

			// Guard: sessionID and output parts required (Law 1: Early Exit)
			if (!input.sessionID || !output.parts || output.parts.length === 0) return

			// ──────────────────────────────────────────────────────
			// PRIMARY PATH: Scan output.parts directly for image data.
			// This avoids the race condition where message.part.updated
			// fires after chat.message, leaving imageMap empty.
			// ──────────────────────────────────────────────────────

			// Collect image parts and their indices for later removal
			const imagePartIndices: number[] = []
			const imageUrls: string[] = []
			let firstImagePart: Record<string, unknown> | null = null

			for (let i = 0; i < output.parts.length; i++) {
				const part = output.parts[i] as Record<string, unknown>

				// Skip FileParts already injected by marker detection (Law 1: Early Exit)
				if ((part.id as string)?.startsWith("prt_img_")) continue

				const imageUrl = extractImageUrl(part)
				if (imageUrl) {
					imagePartIndices.push(i)
					imageUrls.push(imageUrl)
					if (!firstImagePart) firstImagePart = part
				}
			}

			if (imageUrls.length > 0) {
				// Resolve root session ID for scoping
				let rootID = rootSessionCache.get(input.sessionID)
				if (!rootID) {
					try {
						rootID = await getRootSessionID(client as unknown as OpencodeClient, input.sessionID)
					} catch (err) {
						debugLog(client as unknown as OpencodeClient, `chat.message: failed to resolve root session: ${err}`)
						return
					}
				}

				// Index each image and collect unique IDs
				const indexedIds: string[] = []

				const results = await Promise.all(
					imageUrls.map((url) =>
						indexImage(client as unknown as OpencodeClient, url, rootID, storageBase)
					)
				)
				for (const imageId of results) {
					if (imageId && !indexedIds.includes(imageId)) {
						indexedIds.push(imageId)
					}
				}

				if (imageUrls.length > 0 && indexedIds.length === 0) {
					await debugLog(client as unknown as OpencodeClient,
						`chat.message: found ${imageUrls.length} image(s) in parts but none indexed successfully`)
				}

				if (indexedIds.length > 0) {
					// Store in imageMap for cleanup tracking
					const existingIds = imageMap.get(rootID) ?? []
					for (const id of indexedIds) {
						if (!existingIds.includes(id)) {
							existingIds.push(id)
						}
					}
					imageMap.set(rootID, existingIds)

					// Remove raw image parts from output (reverse order preserves indices)
					for (const idx of [...imagePartIndices].reverse()) {
						output.parts.splice(idx, 1)
					}

					// Generate proper TextPart with required fields (id, sessionID, messageID)
					// Using first image part as reference for sessionID and messageID
					const refPart = firstImagePart ?? {}
					const partId = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
					const partSessionID = (refPart.sessionID as string) || input.sessionID || ""
					const partMessageID = (refPart.messageID as string) || ""

					const imageMarkers = indexedIds.map((id) => `[img id=${id}]`).join(" ")
					const notification = `[System: User has attached ${indexedIds.length} image(s). Image ID(s): ${indexedIds.join(", ")}. Markers: ${imageMarkers}]`

					const injectedPart: { type: string; text?: string } = {
						type: "text",
						text: notification,
						id: partId,
						sessionID: partSessionID,
						messageID: partMessageID,
					}
					output.parts.unshift(injectedPart)

					return
				}

				// If all images failed to index, fall through to the imageMap fallback below
			}

			// ──────────────────────────────────────────────────────
			// FALLBACK PATH: Check imageMap for images indexed
			// asynchronously via the message.part.updated handler.
			// ──────────────────────────────────────────────────────

			let rootID = rootSessionCache.get(input.sessionID)
			if (!rootID) {
				try {
					rootID = await getRootSessionID(client as unknown as OpencodeClient, input.sessionID)
				} catch (err) {
					debugLog(client as unknown as OpencodeClient, `chat.message: failed to resolve root session: ${err}`)
					return
				}
			}
			const imageIds = imageMap.get(rootID)
			debugLog(client as unknown as OpencodeClient, `chat.message hook`, {
				sessionID: input.sessionID,
				rootID,
				hasCachedRoot: rootSessionCache.has(input.sessionID),
				imageMapSize: imageMap.size,
				imageIds: imageIds || "(empty)",
				willInject: !!(imageIds && imageIds.length > 0),
			})

			// Guard: no images tracked for this session (Law 1: Early Exit)
			if (!imageIds || imageIds.length === 0) return

			// Generate proper TextPart with required fields (id, sessionID, messageID)
			// Get messageID and sessionID from the first existing part as reference
			const refPartFallback = output.parts.length > 0 ? (output.parts[0] as Record<string, unknown>) : {}
			const partIdFallback = `prt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
			const partSessionIDFallback = (refPartFallback.sessionID as string) || input.sessionID || ""
			const partMessageIDFallback = (refPartFallback.messageID as string) || ""

			const imageMarkers = imageIds.map((id) => `[img id=${id}]`).join(" ")
			const notification = `[System: User has attached ${imageIds.length} image(s). Image ID(s): ${imageIds.join(", ")}. Markers: ${imageMarkers}]`

			output.parts = output.parts ?? []
			const injectedPartFallback: { type: string; text?: string } = {
				type: "text",
				text: notification,
				id: partIdFallback,
				sessionID: partSessionIDFallback,
				messageID: partMessageIDFallback,
			}
			output.parts.unshift(injectedPartFallback)
		},

		tool: {
			image_get: tool({
				description: "Get an image by ID. Scans all sessions to find the image automatically. Returns a data URI string like `data:image/png;base64,...`.",
				args: {
					id: tool.schema.string().describe("Image ID (e.g. img_abc12345)"),
				},
				async execute(args, toolCtx) {
					const { id } = args

					// Guard: id required and must start with "img_" (Law 1: Early Exit, Law 4: Fail Fast)
					if (!id) return "❌ image_get: id is required"
					if (!id.startsWith("img_")) return `❌ image_get: invalid image ID: "${id}"`

					try {
						const pid = await getProjectId(toolCtx.directory)
						const result = await getImageDataUri(id, pid)

						// Guard: image not found (Law 1: Early Exit)
						if (!result) return `❌ Image not found: ${id}`

						const dataUri = toDataUri(result.buffer, result.mimeType)
						const size = result.buffer.length

						return {
							output: `Image retrieved: ${id} (${result.mimeType}, ${size} bytes)`,
							attachments: [{ type: "file", mime: result.mimeType, url: dataUri }],
						}
					} catch (err) {
						return `❌ image_get failed: ${err instanceof Error ? err.message : String(err)}`
					}
				},
			}),

			image_list: tool({
				description: "List all available image IDs with metadata across all sessions.",
				args: {},
				async execute(_args, toolCtx) {
					try {
						const pid = await getProjectId(toolCtx.directory)
						const baseDir = getStorageBase(pid)

						const images: Array<{ id: string; mimeType: string; sessionID: string }> = []

						let entries: string[]
						try {
							entries = await fs.readdir(baseDir)
						} catch {
							return JSON.stringify({ images })
						}

						for (const entry of entries) {
							const sessionDir = path.join(baseDir, entry)
							let dirEntries: string[]
							try {
								dirEntries = await fs.readdir(sessionDir)
							} catch {
								continue
							}

							for (const file of dirEntries) {
								if (file.endsWith(".json") && !file.startsWith("_")) {
									const imageId = file.replace(".json", "")
									// Verify image data file exists (avoid stale metadata)
									const dataFileExists = dirEntries.some(
										(f) =>
											f.startsWith(imageId) &&
											!f.endsWith(".json") &&
											!f.endsWith(".session"),
									)
									if (!dataFileExists) continue

									let mimeType = "image/png"
									try {
										const metaRaw = await fs.readFile(path.join(sessionDir, file), "utf-8")
										const meta = JSON.parse(metaRaw)
										if (meta.mimeType) mimeType = meta.mimeType
									} catch {
										/* use default */
									}

									images.push({
										id: imageId,
										mimeType,
										sessionID: entry,
									})
								}
							}
						}

						return JSON.stringify({ images })
					} catch (err) {
						return `❌ image_list failed: ${err instanceof Error ? err.message : String(err)}`
					}
				},
			}),

			image_get_url: tool({
				description:
					"Download an image from a URL and return base64 data without storing it. Supports http(s):// URLs and data: URIs.",
				args: {
					url: tool.schema.string().describe("Image URL (http(s)://) or data: URI"),
				},
				async execute(args, _toolCtx) {
					const { url } = args
					if (!url) return "❌ image_get_url: url is required"

					try {
						let buffer: Buffer
						let mimeType: string

						if (url.startsWith("data:")) {
							const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/)
							if (!match) return "❌ Invalid data URI format"
							mimeType = match[1]
							buffer = Buffer.from(match[2], "base64")
						} else if (url.startsWith("http://") || url.startsWith("https://")) {
							const result = await downloadUrl(url)
							buffer = result.buffer
							mimeType = result.mimeType
						} else {
							return "❌ image_get_url: unsupported URL type (use http(s):// or data: URI)"
						}

						return JSON.stringify({ mimeType, data: buffer.toString("base64") })
					} catch (err) {
						return `❌ image_get_url failed: ${err instanceof Error ? err.message : String(err)}`
					}
				},
			}),

			image_clear_session: tool({
				description:
					"Remove all stored images for the current session. Idempotent — safe to call even if no images exist.",
				args: {},
				async execute(_args, toolCtx) {
					// Uses the plugin context's current session for scoping
					try {
						if (!toolCtx?.sessionID) return "❌ image_clear_session: no active session"

						const pid = await getProjectId(toolCtx.directory)
						const baseDir = getStorageBase(pid)

						// Resolve root session for directory cleanup
						const rootSessionID = await getRootSessionID(
							client as unknown as OpencodeClient,
							toolCtx.sessionID,
						)

						const sessionDir = path.join(baseDir, rootSessionID)
						try {
							await fs.rm(sessionDir, { recursive: true, force: true })
						} catch {
							// Directory may not exist — idempotent
						}

						// Clean up in-memory maps
						imageMap.delete(rootSessionID)
						for (const [cachedID, cachedRoot] of rootSessionCache) {
							if (cachedRoot === rootSessionID) {
								rootSessionCache.delete(cachedID)
							}
						}

						return `✅ Cleared images for session: ${rootSessionID}`
					} catch (err) {
						return `❌ image_clear_session failed: ${err instanceof Error ? err.message : String(err)}`
					}
				},
			}),

			cleanup_images: tool({
				description: "Clean up stored images. Without arguments, removes ALL images. With maxAge (e.g., '2d', '2d10h30m', '30m'), removes only images from sessions older than the specified duration.",
				args: {
					maxAge: tool.schema.string().optional().describe("Optional: max age of images to keep. Format: '2d', '2d10h30m', '30m'. Examples: '2d' = older than 2 days, '2d10h30m' = older than 2 days 10 hours 30 minutes, '30m' = older than 30 minutes."),
				},
				async execute(args, toolCtx) {
					try {
						const pid = await getProjectId(toolCtx.directory)
						const baseDir = getStorageBase(pid)

						let entries: string[]
						try {
							entries = await fs.readdir(baseDir)
						} catch {
							return "No images directory found."
						}

						let maxAgeMs: number | null = null
						if (args.maxAge) {
							maxAgeMs = parseDuration(args.maxAge)
							if (maxAgeMs === -1) {
								return `❌ Invalid duration format: "${args.maxAge}". Expected format like "2d", "2d10h30m", or "30m".`
							}
						}

						const now = Date.now()
						let removedCount = 0
						let skippedCount = 0

						for (const entry of entries) {
							const sessionDir = path.join(baseDir, entry)

							try {
								if (maxAgeMs !== null) {
									// Check directory modification time
									const stat = await fs.stat(sessionDir)
									const age = now - stat.mtimeMs
									if (age < maxAgeMs) {
										skippedCount++
										continue  // Too young, keep it
									}
								}

								// Remove the entire session directory
								await fs.rm(sessionDir, { recursive: true, force: true })
								removedCount++
							} catch {
								// Skip entries we can't process
								continue
							}
						}

						// Also clear in-memory maps since images are gone
						imageMap.clear()
						rootSessionCache.clear()

						if (maxAgeMs !== null) {
							return `Cleaned up ${removedCount} session(s) with images older than "${args.maxAge}". ${skippedCount} session(s) kept. In-memory state cleared.`
						} else {
							return `Cleaned up ${removedCount} session(s). All images removed. In-memory state cleared.`
						}
					} catch (err) {
						return `❌ cleanup_images failed: ${err instanceof Error ? err.message : String(err)}`
					}
				},
			}),
		},
	}
}

export default ImagePlugin
