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
 * The MCP server (image-mcp-server.cjs) handles reading for agents (visual-reviewer).
 *
 * Philosophy: Elegant Defense (Guard Clauses, Fail Fast, Intentional Naming)
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as crypto from "node:crypto"
import * as os from "node:os"
import * as https from "node:https"
import * as http from "node:http"

import type { Plugin } from "@opencode-ai/plugin"
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
 * @param _sessionID - The current session ID (unused in filesystem version, kept for signature compat)
 * @param storageBase - The base storage directory for images
 * @returns The image ID if indexed, null otherwise
 */
async function indexImage(
	client: OpencodeClient,
	imageUrl: string,
	rootSessionID: string,
	_sessionID: string,
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

		// Write session mapping file (allows MCP to find image without session_id)
		// Always written, even for duplicate images, to ensure the mapping exists
		await fs.writeFile(
			path.join(sessionDir, imageId + ".session"),
			rootSessionID,
			"utf8",
		)

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
		const imageId = await indexImage(client as unknown as OpencodeClient, imageUrl, rootSessionID, sessionID, storageBase)

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
	 * Handle session.idle events: clean up indexed images and state.
	 */
	async function handleSessionIdle(event: Record<string, unknown>): Promise<void> {
		const properties = event.properties as Record<string, unknown> | undefined

		// Guard: properties required (Law 1: Early Exit)
		if (!properties || typeof properties !== "object") return

		const sessionID = properties.sessionID as string | undefined

		// Guard: sessionID required (Law 1: Early Exit)
		if (!sessionID) return

		// Resolve root session ID
		const rootSessionID = await getRootSessionID(client as unknown as OpencodeClient, sessionID)

		// M1: Only clear images if the idle session IS the root session.
		// Child sessions become idle independently while the parent is still active.
		if (sessionID !== rootSessionID) return

		// Clear images from filesystem (non-fatal if unavailable)
		await clearSessionImages(storageBase, rootSessionID)

		// Clean up in-memory maps
		imageMap.delete(rootSessionID)

		// Remove all cache entries that resolve to this root session
		for (const [cachedSessionID, cachedRootID] of rootSessionCache) {
			if (cachedRootID === rootSessionID) {
				rootSessionCache.delete(cachedSessionID)
			}
		}

		// Log cleanup
		client.app
			.log({
				body: {
					service: "image-plugin",
					level: "info",
					message: `Cleaned up images for session ${rootSessionID}`,
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
			input: { sessionID?: string },
			output: { parts?: Array<{ type: string; text?: string }> },
		): Promise<void> => {
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
						indexImage(client as unknown as OpencodeClient, url, rootID, input.sessionID, storageBase)
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

					const notification = `[System: User has attached ${indexedIds.length} image(s). Image ID(s): ${indexedIds.join(", ")}. To retrieve these images, use the \`image_get\` MCP tool with the image ID.]`

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

			const notification = `[System: User has attached ${imageIds.length} image(s). Image ID(s): ${imageIds.join(", ")}. To retrieve these images, use the \`image_get\` MCP tool with the image ID.]`

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
	}
}

export default ImagePlugin
