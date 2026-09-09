/** External Gateway 严格的传输数据和持久化记录结构定义。 */

import { z } from 'zod'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  GatewayArtifactRecord,
  GatewayUploadRecord,
  GatewayClientStateRecord,
  GatewayConversationRecord,
  GatewayDelivery,
  GatewayDeliveryRecord,
  GatewayEvent,
  GatewayEventPayload,
  GatewayInteractionRecord,
  GatewayUploadCompleteRequest,
  GatewayUploadInitRequest,
  GatewayPayload,
  GatewayProjectionCursorRecord,
  GatewaySessionOwnershipRecord,
} from './types.ts'

/** 单个不透明协议标识符的最大长度。 */
export const MAX_ID_LENGTH = 512
/** 单个消息块接受的最大文本长度。 */
export const MAX_TEXT_LENGTH = 1_000_000
/** 单次投递的最大消息块数量。 */
export const MAX_CONTENT_BLOCKS = 128
/** 单个问题回答的最大选项数量。 */
export const MAX_QUESTION_ANSWERS = 128
/** 单个可恢复上传分块接受的最大字节数。 */
export const GATEWAY_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
/** 网关接受的完整文件上传大小上限。 */
export const MAX_GATEWAY_UPLOAD_BYTES = 100 * 1024 * 1024
/** 网关接受的完整图片上传大小上限。 */
export const MAX_GATEWAY_IMAGE_BYTES = 20 * 1024 * 1024
/** 上传文件名保留的最大 UTF-8 字节数。 */
export const MAX_UPLOAD_FILENAME_BYTES = 255

/** 传输边界处去除首尾空白后的非空不透明字符串。 */
export const opaqueStringSchema = z.string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .refine(value => value.trim() === value && value.length > 0, 'value must be trimmed and non-empty')

/** 用于序号、时间戳和游标字段的非负安全整数。 */
export const safeIntegerSchema = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

/** 事件投影和运行时结果接受的无损 JSON 数据。 */
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]))

/** JSON 解析后恢复编译时类型品牌的 Session ID。 */
export const sessionIdSchema = opaqueStringSchema.transform(value => value as SessionId)

/** 消息文本块。 */
export const gatewayTextContentSchema = z.object({
  type: z.literal('text'),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

/** 由宿主转入 Session 持久化附件存储的编码图片。 */
export const gatewayImageContentSchema = z.object({
  type: z.literal('image'),
  mediaType: z.union([
    z.literal('image/png'),
    z.literal('image/jpeg'),
    z.literal('image/webp'),
    z.literal('image/gif'),
  ]).optional(),
  data: z.string().min(1).optional(),
  uploadId: opaqueStringSchema.optional(),
  name: z.string().min(1).max(MAX_ID_LENGTH).optional(),
}).strict().refine(value => (value.data === undefined) !== (value.uploadId === undefined), {
  message: 'image content must provide exactly one of data or uploadId',
})

/** 供后续 Session 消息引用的已完成上传。 */
export const gatewayUploadContentSchema = z.object({
  type: z.literal('upload'),
  uploadId: opaqueStringSchema,
}).strict()

/** 消息协议接受的显式文件上传引用。 */
export const gatewayFileContentSchema = z.object({
  type: z.literal('file'),
  uploadId: opaqueStringSchema,
}).strict()

/** 消息携带的具名技能引用。 */
export const gatewaySkillContentSchema = z.object({
  type: z.literal('skill'),
  name: opaqueStringSchema,
}).strict()

/** 外部消息操作接受的内容块。 */
export const gatewayMessageContentSchema = z.discriminatedUnion('type', [
  gatewayTextContentSchema,
  gatewayImageContentSchema,
  gatewayUploadContentSchema,
  gatewayFileContentSchema,
  gatewaySkillContentSchema,
])

const modelSelectionSchema = z.object({
  provider: opaqueStringSchema,
  model: opaqueStringSchema,
  reasoningEffort: opaqueStringSchema.optional(),
}).strict()

const questionAnswerSchema = z.object({
  id: opaqueStringSchema,
  selected: z.array(opaqueStringSchema).max(MAX_QUESTION_ANSWERS),
  custom: z.string().max(MAX_TEXT_LENGTH).optional(),
}).strict()

const sessionCreatePayloadSchema = z.object({
  type: z.literal('session-create'),
  title: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
  model: modelSelectionSchema.optional(),
  permissionPreset: opaqueStringSchema.optional(),
}).strict()

const sessionSelectPayloadSchema = z.object({
  type: z.literal('session-select'),
  sessionId: sessionIdSchema,
}).strict()

const sessionRenamePayloadSchema = z.object({
  type: z.literal('session-rename'),
  sessionId: sessionIdSchema,
  title: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

const sessionForkPayloadSchema = z.object({
  type: z.literal('session-fork'),
  sessionId: sessionIdSchema,
  eventSeq: safeIntegerSchema.optional(),
}).strict()

const sessionCancelPayloadSchema = z.object({
  type: z.literal('session-cancel'),
  sessionId: sessionIdSchema.optional(),
}).strict()

const modelSelectPayloadSchema = z.object({
  type: z.literal('model-select'),
  sessionId: sessionIdSchema,
  selection: modelSelectionSchema,
}).strict()

const permissionSelectPayloadSchema = z.object({
  type: z.literal('permission-select'),
  sessionId: sessionIdSchema,
  preset: opaqueStringSchema,
}).strict()

const messagePayloadSchema = z.object({
  type: z.literal('message'),
  sessionId: sessionIdSchema.optional(),
  content: z.array(gatewayMessageContentSchema).min(1).max(MAX_CONTENT_BLOCKS),
  mode: z.union([z.literal('queue'), z.literal('steer')]).optional(),
}).strict()

const commandPayloadSchema = z.object({
  type: z.literal('command'),
  sessionId: sessionIdSchema.optional(),
  command: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

const questionAnswerPayloadSchema = z.object({
  type: z.literal('question-answer'),
  interactionId: opaqueStringSchema,
  answers: z.array(questionAnswerSchema).max(MAX_QUESTION_ANSWERS),
}).strict()

const approvalAnswerPayloadSchema = z.object({
  type: z.literal('approval-answer'),
  interactionId: opaqueStringSchema,
  outcome: z.union([z.literal('allowed-once'), z.literal('rejected')]),
}).strict()

const subagentFollowupPayloadSchema = z.object({
  type: z.literal('subagent-followup'),
  sessionId: sessionIdSchema,
  agentId: opaqueStringSchema,
  content: z.array(gatewayMessageContentSchema).min(1).max(MAX_CONTENT_BLOCKS),
}).strict()

const subagentInterruptPayloadSchema = z.object({
  type: z.literal('subagent-interrupt'),
  sessionId: sessionIdSchema,
  agentId: opaqueStringSchema,
}).strict()

const sessionExportPayloadSchema = z.object({
  type: z.literal('session-export'),
  sessionId: sessionIdSchema,
}).strict()

/** 所有变更操作的严格判别联合。 */
export const gatewayPayloadSchema: z.ZodType<GatewayPayload> = z.discriminatedUnion('type', [
  sessionCreatePayloadSchema,
  sessionSelectPayloadSchema,
  sessionRenamePayloadSchema,
  sessionForkPayloadSchema,
  sessionCancelPayloadSchema,
  modelSelectPayloadSchema,
  permissionSelectPayloadSchema,
  messagePayloadSchema,
  commandPayloadSchema,
  questionAnswerPayloadSchema,
  approvalAnswerPayloadSchema,
  subagentFollowupPayloadSchema,
  subagentInterruptPayloadSchema,
  sessionExportPayloadSchema,
]) as unknown as z.ZodType<GatewayPayload>

/** `POST /v1/deliveries` 的严格请求体。 */
export const gatewayDeliverySchema: z.ZodType<GatewayDelivery> = z.object({
  deliveryId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  payload: gatewayPayloadSchema,
}).strict() as unknown as z.ZodType<GatewayDelivery>

/** `POST /v1/events/ack` 的严格请求体。 */
export const gatewayAckSchema = z.object({
  upToSequence: safeIntegerSchema,
}).strict()

const uploadDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const uploadKindSchema = z.union([z.literal('image'), z.literal('file')])

/** `POST /v1/uploads` 的严格元数据请求体。 */
export const gatewayUploadInitSchema: z.ZodType<GatewayUploadInitRequest> = z.object({
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  uploadId: opaqueStringSchema.optional(),
  kind: uploadKindSchema,
  filename: z.string().min(1).max(MAX_TEXT_LENGTH),
  contentType: z.string().min(1).max(MAX_ID_LENGTH),
  size: safeIntegerSchema,
  sha256: uploadDigestSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayUploadInitRequest>

/** `POST /v1/uploads/:id/complete` 的严格可选校验和请求体。 */
export const gatewayUploadCompleteSchema: z.ZodType<GatewayUploadCompleteRequest> = z.object({
  sha256: uploadDigestSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayUploadCompleteRequest>

const questionOptionSchema = z.object({
  label: z.string().min(1).max(MAX_TEXT_LENGTH),
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
}).strict()

const questionIntentSchema = z.object({
  kind: z.literal('plan-review'),
  approve: z.string().min(1).max(MAX_TEXT_LENGTH),
}).strict()

const questionSchema = z.object({
  id: opaqueStringSchema,
  question: z.string().min(1).max(MAX_TEXT_LENGTH),
  detail: z.string().max(MAX_TEXT_LENGTH).optional(),
  header: z.string().max(MAX_ID_LENGTH).optional(),
  options: z.array(questionOptionSchema).max(MAX_QUESTION_ANSWERS).optional(),
  multiSelect: z.boolean().optional(),
  intent: questionIntentSchema.optional(),
}).strict()

const eventPayloadSchemas = [
  z.object({ type: z.literal('delivery-completed'), deliveryId: opaqueStringSchema, result: jsonValueSchema.optional() }).strict(),
  z.object({ type: z.literal('delivery-failed'), deliveryId: opaqueStringSchema, code: opaqueStringSchema, message: z.string().min(1).max(MAX_TEXT_LENGTH) }).strict(),
  z.object({ type: z.literal('session-created'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('session-selected'), sessionId: sessionIdSchema }).strict(),
  z.object({ type: z.literal('session-updated'), sessionId: sessionIdSchema, changes: jsonValueSchema }).strict(),
  z.object({ type: z.literal('session-event'), sessionId: sessionIdSchema, event: jsonValueSchema }).strict(),
  z.object({ type: z.literal('assistant-final'), sessionId: sessionIdSchema, text: z.string().max(MAX_TEXT_LENGTH) }).strict(),
  z.object({ type: z.literal('question'), sessionId: sessionIdSchema, interactionId: opaqueStringSchema, expiresAt: safeIntegerSchema, questions: z.array(questionSchema).min(1).max(MAX_QUESTION_ANSWERS) }).strict(),
  z.object({ type: z.literal('approval'), sessionId: sessionIdSchema, interactionId: opaqueStringSchema, expiresAt: safeIntegerSchema, toolName: opaqueStringSchema, reason: z.string().max(MAX_TEXT_LENGTH).optional() }).strict(),
  z.object({ type: z.literal('interaction-expired'), sessionId: sessionIdSchema, interactionId: opaqueStringSchema, kind: z.union([z.literal('question'), z.literal('approval')]) }).strict(),
  z.object({ type: z.literal('subagent-started'), sessionId: sessionIdSchema, agentId: opaqueStringSchema }).strict(),
  z.object({ type: z.literal('subagent-finished'), sessionId: sessionIdSchema, agentId: opaqueStringSchema, result: jsonValueSchema.optional() }).strict(),
  z.object({ type: z.literal('artifact-ready'), sessionId: sessionIdSchema, artifactId: opaqueStringSchema }).strict(),
  z.object({ type: z.literal('turn-failed'), sessionId: sessionIdSchema, message: z.string().min(1).max(MAX_TEXT_LENGTH) }).strict(),
] as const

/** 持久化 outbox 记录的严格事件载荷结构。 */
export const gatewayEventPayloadSchema: z.ZodType<GatewayEventPayload> = z.discriminatedUnion(
  'type', eventPayloadSchemas,
) as unknown as z.ZodType<GatewayEventPayload>

/** 严格的持久化 inbox 记录结构。 */
export const gatewayDeliveryRecordSchema: z.ZodType<GatewayDeliveryRecord> = z.object({
  deliveryId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  payload: gatewayPayloadSchema,
  clientId: opaqueStringSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.union([z.literal('pending'), z.literal('completed'), z.literal('failed')]),
  reservedSessionId: sessionIdSchema.optional(),
  attempts: safeIntegerSchema,
  createdAt: safeIntegerSchema,
  updatedAt: safeIntegerSchema,
  completedAt: safeIntegerSchema.optional(),
  errorCode: opaqueStringSchema.optional(),
  errorMessage: z.string().max(MAX_TEXT_LENGTH).optional(),
  result: jsonValueSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayDeliveryRecord>

/** 严格的持久化 outbox 事件结构。 */
export const gatewayEventSchema: z.ZodType<GatewayEvent> = z.object({
  clientId: opaqueStringSchema,
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  eventId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema.optional(),
  causedByDeliveryId: opaqueStringSchema.optional(),
  payload: gatewayEventPayloadSchema,
  createdAt: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayEvent>

/** 严格的客户端序号状态结构。 */
export const gatewayClientStateSchema: z.ZodType<GatewayClientStateRecord> = z.object({
  clientId: opaqueStringSchema,
  nextSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  acknowledgedSequence: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayClientStateRecord>

/** 严格的 Session 归属结构。 */
export const gatewaySessionOwnershipSchema: z.ZodType<GatewaySessionOwnershipRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema,
  cwd: z.string().min(1).max(MAX_TEXT_LENGTH),
  createdAt: safeIntegerSchema,
  status: z.union([z.literal('pending'), z.literal('ready')]),
  active: z.boolean(),
}).strict() as unknown as z.ZodType<GatewaySessionOwnershipRecord>

/** 严格的活动对话映射结构。 */
export const gatewayConversationSchema: z.ZodType<GatewayConversationRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema.optional(),
  updatedAt: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayConversationRecord>

/** 严格的交互归属结构。 */
export const gatewayInteractionSchema: z.ZodType<GatewayInteractionRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  sessionId: sessionIdSchema,
  interactionId: opaqueStringSchema,
  kind: z.union([z.literal('question'), z.literal('approval')]),
  expiresAt: safeIntegerSchema,
  status: z.union([z.literal('pending'), z.literal('answered'), z.literal('expired')]),
}).strict() as unknown as z.ZodType<GatewayInteractionRecord>

/** Session 日志到网关 outbox 投影的持久化游标。 */
export const gatewayProjectionCursorSchema: z.ZodType<GatewayProjectionCursorRecord> = z.object({
  sessionId: sessionIdSchema,
  sequence: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayProjectionCursorRecord>

/** 单个导出产物的持久化 peer 归属和文件元数据。 */
export const gatewayArtifactSchema: z.ZodType<GatewayArtifactRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  artifactId: opaqueStringSchema,
  sessionId: sessionIdSchema,
  path: z.string().min(1),
  filename: z.string().min(1).max(MAX_ID_LENGTH),
  contentType: z.string().min(1).max(MAX_ID_LENGTH),
  createdAt: safeIntegerSchema,
}).strict() as unknown as z.ZodType<GatewayArtifactRecord>

/** 严格的持久化可恢复上传元数据及分块状态。 */
export const gatewayUploadRecordSchema: z.ZodType<GatewayUploadRecord> = z.object({
  clientId: opaqueStringSchema,
  accountId: opaqueStringSchema,
  peerId: opaqueStringSchema,
  uploadId: opaqueStringSchema,
  kind: z.union([z.literal('image'), z.literal('file')]),
  filename: z.string().min(1).max(MAX_UPLOAD_FILENAME_BYTES),
  contentType: z.string().min(1).max(MAX_ID_LENGTH),
  size: safeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  chunkSize: z.literal(GATEWAY_UPLOAD_CHUNK_BYTES),
  totalParts: safeIntegerSchema,
  parts: z.array(z.object({
    partNumber: safeIntegerSchema,
    bytes: safeIntegerSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/u),
    path: z.string().min(1),
  }).strict()),
  path: z.string().min(1),
  status: z.union([z.literal('pending'), z.literal('completed')]),
  createdAt: safeIntegerSchema,
  updatedAt: safeIntegerSchema,
  completedAt: safeIntegerSchema.optional(),
}).strict() as unknown as z.ZodType<GatewayUploadRecord>

/** 导出给测试和适配器使用的持久化 inbox/outbox domain 结构。 */
export const gatewayRecordSchemas = {
  delivery: gatewayDeliveryRecordSchema,
  event: gatewayEventSchema,
  clientState: gatewayClientStateSchema,
  sessionOwnership: gatewaySessionOwnershipSchema,
  conversation: gatewayConversationSchema,
  interaction: gatewayInteractionSchema,
  projectionCursor: gatewayProjectionCursorSchema,
  artifact: gatewayArtifactSchema,
  upload: gatewayUploadRecordSchema,
} as const
