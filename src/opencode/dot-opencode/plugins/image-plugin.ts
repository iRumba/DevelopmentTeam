/**
 * image-plugin
 * Image indexing and injection for OpenCode
 *
 * Intercepts messages with images, indexes them via the image MCP server,
 * and injects image IDs into chat prompts so agents can reference them.
 *
 * Architecture:
 * - Listens for message.updated events to detect user-attached images
 * - Indexes images via image_add MCP tool, keyed by root session ID
 * - Injects image IDs into chat.message output for agent awareness
 * - Cleans up on session.idle via image_clear_session MCP tool
 *
 * Philosophy: Elegant Defense (Guard Clauses, Fail Fast, Intentional Naming)
 */

import type { Plugin } from "@opencode-ai/plugin"
import type { OpencodeClient } from "./kdco-primitives/types"

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

	// Fallback: { type: "image", url: string }
	if (partType === "image") {
		const url = part.url as string | undefined
		if (url) return url
	}

	// Fallback: direct mimeType check for raw data
	const mimeType = part.mimeType as string | undefined
	if (mimeType?.startsWith("image/")) {
		const imageUrl = part.image_url as { url?: string } | undefined
		if (imageUrl?.url) return imageUrl.url
		const url = part.url as string | undefined
		if (url) return url
	}

	return null
}

// ==========================================
// MCP TOOL CALLING
// ==========================================

/**
 * Typed wrapper around MCP tool calls. Eliminates the need for `as any` casts.
 */
async function callMCPTool<T = unknown>(
	client: OpencodeClient,
	name: string,
	args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }> }> {
	return (client as any).tools.call({ name, arguments: args }) as any
}

/**
 * Indexes an image via the image MCP server.
 * Logs a warning if the MCP server is unavailable (non-fatal).
 *
 * @param client - OpenCode client for tool calling
 * @param imageUrl - The image URL or data URI to index
 * @param rootSessionID - The root session ID for scoping
 * @param sessionID - The current session ID (agent session)
 * @returns The image ID if indexed, null otherwise
 */
async function indexImage(
	client: OpencodeClient,
	imageUrl: string,
	rootSessionID: string,
	sessionID: string,
): Promise<string | null> {
	try {
		const result = await callMCPTool(client, "image_add", {
			source: imageUrl,
			session_id: rootSessionID,
			description: "Image attached by user",
		})

		// Parse result: could be { image_id: string } or { content: [{ text: string }] }
		const resultData = result as Record<string, unknown>
		if (typeof resultData.image_id === "string") {
			return resultData.image_id
		}

		// MCP tools often return content array
		const content = resultData.content as Array<{ text?: string }> | undefined
		if (content?.[0]?.text) {
			return content[0].text.trim()
		}

		// If we got a result but can't parse it, log and continue
		client.app
			.log({
				body: {
					service: "image-plugin",
					level: "warn",
					message: `indexImage: unexpected result shape for image at ${imageUrl.slice(0, 50)}...`,
				},
			})
			.catch(() => {})

		return null
	} catch (error) {
		// Fail-safe: MCP server may not be running, log and continue
		client.app
			.log({
				body: {
					service: "image-plugin",
					level: "warn",
					message: `indexImage: failed to index image (MCP server may not be running): ${error instanceof Error ? error.message : String(error)}`,
				},
			})
			.catch(() => {})

		return null
	}
}

/**
 * Clears all indexed images for a session via the image MCP server.
 * Non-fatal: logs a warning if the MCP server is unavailable.
 *
 * @param client - OpenCode client for tool calling
 * @param rootSessionID - The root session ID to clear images for
 */
async function clearSessionImages(
	client: OpencodeClient,
	rootSessionID: string,
): Promise<void> {
	try {
		await callMCPTool(client, "image_clear_session", {
			session_id: rootSessionID,
		})
	} catch (error) {
		// Fail-safe: MCP server may not be running, log and continue
		client.app
			.log({
				body: {
					service: "image-plugin",
					level: "warn",
					message: `clearSessionImages: failed to clear images (MCP server may not be running): ${error instanceof Error ? error.message : String(error)}`,
				},
			})
			.catch(() => {})
	}
}

// ==========================================
// PLUGIN EXPORT
// ==========================================

const ImagePlugin: Plugin = async (ctx) => {
	const { client, directory } = ctx

	/**
	 * Handle message.updated events: detect images and index them.
	 * This is a tracking-only function — it does not modify the message.
	 */
	async function handleMessageUpdated(event: Record<string, unknown>): Promise<void> {
		const properties = event.properties as Record<string, unknown> | undefined

		// Guard: properties required (Law 1: Early Exit)
		if (!properties || typeof properties !== "object") return

		const info = properties.info as Record<string, unknown> | undefined
		const parts = properties.parts as Array<Record<string, unknown>> | undefined

		// Guard: info and parts required (Law 1: Early Exit)
		if (!info || !parts || !Array.isArray(parts)) return

		const sessionID = info.sessionID as string | undefined

		// Guard: sessionID required (Law 1: Early Exit)
		if (!sessionID) return

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
		const rootSessionID = await getRootSessionID(client, sessionID)

		// Index each image via MCP
		const newImageIds: string[] = []
		for (const imageUrl of imageUrls) {
			const imageID = await indexImage(client, imageUrl, rootSessionID, sessionID)
			if (imageID) {
				newImageIds.push(imageID)
			}
		}

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
		const rootSessionID = await getRootSessionID(client, sessionID)

		// Clear images from MCP server (non-fatal if unavailable)
		await clearSessionImages(client, rootSessionID)

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
			const rootID = rootSessionCache.get(input.sessionID) ?? (await getRootSessionID(client, input.sessionID))

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
