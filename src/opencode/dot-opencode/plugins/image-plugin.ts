/**
 * image-plugin
 * Image indexing and injection for OpenCode
 *
 * Intercepts messages with images, indexes them directly to the filesystem,
 * and injects image IDs into chat prompts so agents can reference them.
 *
 * Architecture:
 * - Listens for message.updated events to detect user-attached images
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

	// Check cache first
	const cached = rootSessionCache.get(sessionID)
	if (cached) return cached

	let currentID = sessionID
	let lastValidID = currentID

	for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
		try {
			const session = await client.session.get({
				path: { id: currentID },
			})

			if (!session.data?.parentID) {
				// Cache the result for this session and all ancestors
				rootSessionCache.set(sessionID, currentID)
				return currentID
			}

			lastValidID = currentID
			currentID = session.data.parentID
		} catch {
			// Fail-safe: if session fetch fails, return the deepest ID we found
			rootSessionCache.set(sessionID, lastValidID)
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
	// Standard: { type: "image_url", image_url: { url: string } }
	const partType = part.type
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
			// Already exists, return same ID
			return imageId
		} catch {
			// Doesn't exist, create
		}

		// Save image file
		await fs.writeFile(imagePath, buffer)

		// Save metadata
		await fs.writeFile(metaPath, JSON.stringify({
			source: imageUrl.slice(0, 100),
			mimeType,
			timestamp: new Date().toISOString(),
		}, null, 2))

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
	 * Handle message.updated events: detect images and index them.
	 * This is a tracking-only function — it does not modify the message.
	 */
	async function handleMessageUpdated(event: Record<string, unknown>): Promise<void> {
		const properties = event.properties as Record<string, unknown> | undefined

		// Guard: properties required (Law 1: Early Exit)
		if (!properties || typeof properties !== "object") return

		const info = properties.info as Record<string, unknown> | undefined

		// Try multiple locations for sessionID (resilient across event shapes)
		const sessionID = (info?.sessionID as string | undefined) ?? (properties.sessionID as string | undefined)

		// Try multiple locations for parts (resilient across event shapes)
		const parts = (properties.parts as Array<Record<string, unknown>> | undefined) ??
			((info?.parts as Array<Record<string, unknown>> | undefined) ?? undefined)

		// Guard: sessionID and parts required (Law 1: Early Exit)
		if (!sessionID || !parts || !Array.isArray(parts)) return

		// Find image URL parts
		const imageUrls: string[] = []
		for (const part of parts) {
			const imageUrl = extractImageUrl(part)
			if (imageUrl) {
				imageUrls.push(imageUrl)
			}
		}

		// Guard: no images found (Law 1: Early Exit)
		if (imageUrls.length === 0) return

		// Resolve root session ID for scoping
		const rootSessionID = await getRootSessionID(client as unknown as OpencodeClient, sessionID)

		// Index each image to filesystem (m1: parallelize to reduce race condition window)
		const results = await Promise.all(
			imageUrls.map((url) => indexImage(client as unknown as OpencodeClient, url, rootSessionID, sessionID, storageBase)),
		)
		const newImageIds = results.filter((id): id is string => id !== null)

		// Guard: no images successfully indexed (Law 1: Early Exit)
		if (newImageIds.length === 0) return

		// Store in the in-memory map (append to existing entries)
		const existingIds = imageMap.get(rootSessionID) ?? []
		imageMap.set(rootSessionID, [...existingIds, ...newImageIds])

		// Log the indexing result
		client.app
			.log({
				body: {
					service: "image-plugin",
					level: "info",
					message: `Indexed ${newImageIds.length} image(s) for session ${rootSessionID}: ${newImageIds.join(", ")}`,
				},
			})
			.catch(() => {})
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

			// Guard: event type required (Law 1: Early Exit)
			if (!eventType) return

			if (eventType === "message.updated") {
				await handleMessageUpdated(event)
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
			// Guard: sessionID required (Law 1: Early Exit)
			if (!input.sessionID) return

			// Resolve root session ID (use cache if available)
			const rootID = rootSessionCache.get(input.sessionID) ?? (await getRootSessionID(client as unknown as OpencodeClient, input.sessionID))

			const imageIds = imageMap.get(rootID)

			// Guard: no images tracked for this session (Law 1: Early Exit)
			if (!imageIds || imageIds.length === 0) return

			// Inject system notification with image IDs
			const notification = `[System: User has attached ${imageIds.length} image(s). Image ID(s): ${imageIds.join(", ")}. To analyze these images, delegate to visual-reviewer and pass the image ID(s). visual-reviewer can retrieve images via the \`image_get\` MCP tool.]`

			output.parts = output.parts ?? []
			output.parts.unshift({ type: "text", text: notification })
		},
	}
}

export default ImagePlugin
