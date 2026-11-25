package dev.otectus.pal.mobile.protocol

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val PROTOCOL_VERSION = 1
const val PROTOCOL_MIN = 0
const val PROTOCOL_MAX = 0

@Serializable
enum class ActionAuthentication {
    @SerialName("biometric") BIOMETRIC,
    @SerialName("trusted-device") TRUSTED_DEVICE,
}

@Serializable
data class Hello(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "hello",
    val protocolMin: Int = PROTOCOL_MIN,
    val protocolMax: Int = PROTOCOL_MAX,
    val desktopId: String,
    val deviceId: String,
    val keyVersion: Int = 1,
    val clientNonce: String,
    val appVersion: String,
)

@Serializable
data class AuthChallenge(
    val v: Int,
    val type: String,
    val challengeId: String,
    val serverNonce: String,
    val epoch: String,
    val audience: String,
    val expiresAt: Long,
)

@Serializable
data class Auth(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "auth",
    val challengeId: String,
    val signature: String,
)

@Serializable data class ProtocolVersion(val major: Int, val minor: Int)
@Serializable data class Limits(val maxFrameBytes: Int = 1_048_576)
/** The desktop build: package version and source commit; null parts are unknown, never guessed. */
@Serializable data class BuildIdentity(val version: String = "unknown", val commit: String? = null, val dirty: Boolean? = null)

@Serializable
data class Welcome(
    val v: Int,
    val type: String,
    val authSessionId: String,
    val expiresAt: Long,
    val epoch: String,
    val desktopId: String,
    val scopeVersion: String,
    val protocol: ProtocolVersion,
    val operations: Set<String>,
    val limits: Limits = Limits(),
    val brokerBuild: String? = null,
    val build: BuildIdentity? = null,
    val sendAuthentication: String = "action-key",
    val actionAuthentication: ActionAuthentication = ActionAuthentication.BIOMETRIC,
    /** Behaviour beyond the operation list (protocol 1.1); an older desktop sends none. */
    val features: Set<String> = emptySet(),
)

@Serializable
data class Proof(val challengeId: String, val signature: String)

@Serializable
data class Request(
    val v: Int = PROTOCOL_VERSION,
    val type: String = "request",
    val id: String,
    val method: String,
    val params: JsonObject,
    val commandId: String? = null,
    val proof: Proof? = null,
)

@Serializable
data class ProtocolError(
    val code: String,
    val message: String,
    val retryable: Boolean = false,
    val details: JsonObject? = null,
)

@Serializable
data class Response(
    val v: Int,
    val type: String,
    val id: String,
    val result: JsonElement? = null,
    val error: ProtocolError? = null,
)

@Serializable
data class Event(
    val v: Int,
    val type: String,
    val cursor: String,
    val eventId: String,
    val name: String,
    val resourceRevision: String,
    val data: JsonObject,
)

@Serializable
data class Session(
    val id: String,
    val provider: String,
    val title: String,
    val projectId: String? = null,
    val project: String? = null,
    val status: String,
    val model: String? = null,
    val effort: String? = null,
    val draft: String = "",
    val draftIncluded: Boolean = true,
    val draftRevision: String = "0",
    val configRevision: String = "0",
    val revision: String = "0",
    val mode: String? = null,
    val remoteRestricted: Boolean = true,
    val turnId: String? = null,
    val canSend: Boolean = false,
    val canQueue: Boolean = false,
    val queuedCount: Int = 0,
    /** Results of delegated sessions that wait for this conversation. */
    val pendingUpdates: Int = 0,
    val canConfigure: Boolean = false,
    val pinned: Boolean = false,
    val archived: Boolean = false,
    val unread: Boolean = false,
    val readAt: Long = 0,
    val folderName: String? = null,
    val draftAttachmentCount: Int? = null,
    /** The open conversation's desktop draft attachments (protocol feature drafts.desktopAttachments). */
    val draftAttachments: List<DraftAttachment> = emptyList(),
    val updated: Long = 0,
    val activity: String? = null,
    val parentId: String? = null,
    /** The stored choice for PAL's desktop tools (Ollama, and hosted APIs with feature sessions.toolsState). */
    val tools: Boolean = false,
    /** Whether the route allows tools: true, false, or null when the model decides (Ollama) or the desktop does not say. */
    val toolsAvailable: Boolean? = null,
    val toolsUnavailableReason: String? = null,
    /** A compatible conversation's reviewed destination (feature sessions.routeRevision), its images declaration and connection name. */
    val routeRevision: String? = null,
    val imagesAvailable: Boolean? = null,
    val connectionId: String? = null,
    val connectionName: String? = null,
    val providerOptions: JsonObject = JsonObject(emptyMap()),
    /** Files, Images and Analysis selected on the desktop; "acknowledge" when sending from this phone pauses them (feature workbench.takeover). */
    val workbenchFamilies: List<String> = emptyList(),
    val workbenchTakeover: String? = null,
    val workbenchNote: String? = null,
    val error: String? = null,
    val ollamaHost: String = "",
    val agents: List<Agent> = emptyList(),
    /** This conversation's own time zone (feature time.context.v1); null follows the sending device or the desktop's choice. */
    val timeZone: String? = null,
    val task: SessionTask? = null,
)

/** W10: an attachment of a conversation's desktop draft: its name, kind and content digest, never a path. */
@Serializable
data class DraftAttachment(
    val id: String,
    val name: String,
    val kind: String,
    val mime: String = "",
    val size: Long = 0,
    val sha256: String,
)

@Serializable
data class Agent(
    val id: String,
    val name: String,
    val task: String? = null,
    val status: String,
    val detail: String? = null,
    val parentId: String? = null,
    val updated: Long = 0,
)

@Serializable
data class TextParts(
    val count: Int,
    val partChars: Int,
    val encoding: String,
)

@Serializable
data class Message(
    val id: String,
    val sessionId: String,
    val turnId: String? = null,
    val role: String,
    val kind: String = "text",
    val text: String,
    val revision: String,
    val time: Long = 0,
    val sources: List<JsonObject> = emptyList(),
    val contentTruncated: Boolean = false,
    val contentBytes: Long? = null,
    val contentChars: Long? = null,
    val textParts: TextParts? = null,
    /** A pinned reply: the desktop's bookmark of this message (protocol feature messages.bookmarks). */
    val bookmarked: Boolean = false,
    /** Set only on pinned replies listed across conversations. */
    val sessionTitle: String? = null,
    /** A Workbench result reviewed on the desktop (role "workbench"): what it is, never its contents. */
    val desktopOnly: DesktopOnlyResult? = null,
    /** Transcripts this reply was about; a time it cites can open one. */
    val recordings: List<MessageRecording> = emptyList(),
)

/** The project task a conversation works on; owner phones only. */
@Serializable
data class SessionTask(val id: String, val text: String = "")

@Serializable
data class MessageRecording(val artifactId: String, val versionId: String, val name: String = "")

/** One reading of the desktop's clock (feature time.context.v1). Every field comes from one instant; `reason` says why a suggested zone was not used. */
@Serializable
data class TimeSnapshot(
    val schema: Int = 1,
    val sampledAtMs: Long,
    val utcIso: String = "",
    val localIso: String = "",
    val timeZone: String,
    val zoneSource: String = "",
    val localDate: String = "",
    val localTime: String = "",
    val weekday: String = "",
    val offsetSeconds: Int = 0,
    val clockSource: String = "",
    val clockStatus: String = "unknown",
    val clockRevision: Long = 0,
    val enabled: Boolean = true,
    val conversationTiming: Boolean = true,
    val reason: String? = null,
)
/** How long ago a recorded event was, or why that cannot be said. An unknown length is absent, never zero. */
@Serializable
data class ElapsedResult(
    val schema: Int = 1,
    val status: String,
    val anchorKind: String = "",
    val anchorId: String? = null,
    val anchor: String? = null,
    val fromMs: Long? = null,
    val toMs: Long? = null,
    val durationMs: Long? = null,
    val basis: String = "unknown",
    val includesInactivity: Boolean = true,
    val includesSuspend: Boolean? = null,
    val reason: String? = null,
)

@Serializable data class DesktopOnlyResult(val kind: String = "result", val label: String = "A desktop result")

@Serializable data class ApprovalOption(val label: String, val description: String? = null)
@Serializable
data class ApprovalQuestion(
    val id: String,
    val question: String,
    val header: String? = null,
    val options: List<ApprovalOption> = emptyList(),
    val multiSelect: Boolean = false,
    val isSecret: Boolean = false,
    val allowOther: Boolean = true,
    val required: Boolean = true,
)
@Serializable
data class Approval(
    val id: String,
    val sessionId: String,
    val parentSessionIds: List<String> = emptyList(),
    val kind: String,
    val title: String,
    val detail: String? = null,
    val url: String? = null,
    val choices: List<String>,
    val questions: List<ApprovalQuestion> = emptyList(),
    val fields: JsonObject = JsonObject(emptyMap()),
    val time: Long = 0,
    val revision: String,
    val digest: String,
    val turnId: String? = null,
    val canAnswer: Boolean,
    /** The opaque reference of the session's agent that raised this request, when one did. */
    val agentId: String? = null,
)

@Serializable data class Project(val id: String, val name: String, val path: String? = null, val revision: String = "0")
@Serializable data class Provider(val id: String, val name: String, val available: Boolean = true, val models: List<String> = emptyList(), val efforts: List<String> = emptyList())
@Serializable data class ActivityItem(val id: String, val sessionId: String, val title: String, val detail: String? = null, val status: String, val revision: String)
@Serializable data class EffortOption(val id: String, val displayName: String, val description: String = "")
@Serializable data class ModelOption(
    val id: String,
    val displayName: String = id,
    val description: String = "",
    val efforts: List<EffortOption> = emptyList(),
    val defaultEffort: String = "",
    val isDefault: Boolean = false,
    val capabilities: List<String> = emptyList(),
    val cloud: Boolean = false,
    val contextLength: Int? = null,
    /** What its catalog states, in words: how much it holds, what it costs and what it reads. */
    val detail: String = "",
    val free: Boolean = false,
    /** The day its provider says it stops serving it. */
    val expires: String? = null,
)

/** A providers.models answer with listing:true (feature models.listing); problem says why a use's own list is missing (models.uses). */
@Serializable data class ModelListing(val items: List<ModelOption> = emptyList(), val unlisted: Boolean = false, val problem: String? = null)

/**
 * W11 sessions.behavior: the style a conversation's next turn uses. The desktop sends JSON null for
 * an absent profile or posture; both are nullable here, so no state can make the screen fail.
 */
@Serializable data class BehaviorLabel(val label: String = "", val pinned: Boolean = false)
@Serializable data class ConversationBehavior(
    val source: String? = null,
    val profile: BehaviorLabel? = null,
    val posture: BehaviorLabel? = null,
    val standingInstructions: Boolean = false,
    val warnings: List<String> = emptyList(),
)

@Serializable
data class SyncSnapshot(
    val cursor: String,
    val sessions: List<Session> = emptyList(),
    val approvals: List<Approval> = emptyList(),
    val projects: List<Project> = emptyList(),
    val providers: JsonObject = JsonObject(emptyMap()),
    val permissions: JsonObject = JsonObject(emptyMap()),
    val settings: JsonObject = JsonObject(emptyMap()),
    val messages: List<Message> = emptyList(),
    val sessionIds: List<String>? = null,
    val nextSessionOffset: Int? = null,
    val cacheEpoch: String? = null,
    val messagesBefore: String? = null,
)

sealed interface Frame {
    data class Challenge(val value: AuthChallenge) : Frame
    data class Accepted(val value: Welcome) : Frame
    data class Reply(val value: Response) : Frame
    data class Push(val value: Event) : Frame
}
