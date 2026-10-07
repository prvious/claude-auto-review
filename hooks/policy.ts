export const RISKS = ['Low', 'Medium', 'High', 'Critical'] as const
export const AUTHORIZATIONS = ['High', 'Medium', 'Low', 'Unknown'] as const

export type Risk = (typeof RISKS)[number]
export type Authorization = (typeof AUTHORIZATIONS)[number]

export type EvidenceRequest = {
  operation: 'stat' | 'list' | 'read'
  path: string
}

export type NeedEvidence = {
  type: 'need_evidence'
  requests: EvidenceRequest[]
}

export type Assessment = {
  type: 'assessment'
  risk: Risk
  authorization: Authorization
  narrowlyScoped: boolean
  planCompatible: boolean
  explicitProhibition: boolean
  maliciousUntrustedInstruction: boolean
  decisionCriticalUncertainty: boolean
  reason: string
  evidenceIds: string[]
}

export type ReviewResponse = NeedEvidence | Assessment
export type PolicyDecision = { allow: boolean; reason: string }

export const PROTOCOL_ERROR_CODES = [
  'output-too-large',
  'not-json',
  'wrong-shape',
  'invalid-evidence-shape',
  'invalid-evidence-count',
  'invalid-evidence-request',
  'invalid-evidence-operation',
  'invalid-evidence-path',
  'invalid-assessment-shape',
  'invalid-enum',
  'invalid-boolean',
  'invalid-reason',
  'invalid-evidence-ids',
  'evidence-round-exhausted',
  'attempt-budget-exhausted',
] as const

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number]

export class ReviewProtocolError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'ReviewProtocolError'
    this.code = code
  }
}

const ASSESSMENT_KEYS = [
  'authorization',
  'decisionCriticalUncertainty',
  'evidenceIds',
  'explicitProhibition',
  'maliciousUntrustedInstruction',
  'narrowlyScoped',
  'planCompatible',
  'reason',
  'risk',
  'type',
] as const
const EVIDENCE_KEYS = ['requests', 'type'] as const
const REQUEST_KEYS = ['operation', 'path'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')

const isEnum = <T extends string>(value: unknown, values: readonly T[]): value is T =>
  typeof value === 'string' && values.includes(value as T)

export function parseReviewResponse(
  text: string,
  knownEvidenceIds: ReadonlySet<string>,
): ReviewResponse {
  if (typeof text !== 'string') {
    throw new ReviewProtocolError('wrong-shape', 'review output is not text')
  }
  if (text.length > 16_384) {
    throw new ReviewProtocolError('output-too-large', 'review output is too large')
  }
  const trimmed = text.trim()
  const candidate =
    trimmed.startsWith('```json\n') && trimmed.endsWith('\n```')
      ? trimmed.slice(8, -4).trim()
      : trimmed

  let value: unknown
  try {
    value = JSON.parse(candidate)
  } catch {
    throw new ReviewProtocolError('not-json', 'review output is not JSON')
  }
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new ReviewProtocolError('wrong-shape', 'review output is not an object variant')
  }

  if (value.type === 'need_evidence') {
    if (!hasExactKeys(value, EVIDENCE_KEYS) || !Array.isArray(value.requests)) {
      throw new ReviewProtocolError('invalid-evidence-shape', 'invalid evidence request shape')
    }
    if (value.requests.length < 1 || value.requests.length > 4) {
      throw new ReviewProtocolError(
        'invalid-evidence-count',
        'evidence request count is outside the limit',
      )
    }
    const seen = new Set<string>()
    const requests = value.requests.map(request => {
      if (!isRecord(request) || !hasExactKeys(request, REQUEST_KEYS)) {
        throw new ReviewProtocolError('invalid-evidence-request', 'invalid evidence request')
      }
      if (!isEnum(request.operation, ['stat', 'list', 'read'] as const)) {
        throw new ReviewProtocolError(
          'invalid-evidence-operation',
          'invalid evidence operation',
        )
      }
      if (
        typeof request.path !== 'string' ||
        request.path.length < 1 ||
        request.path.length > 4_096 ||
        seen.has(request.path)
      ) {
        throw new ReviewProtocolError(
          'invalid-evidence-path',
          'invalid or duplicate evidence path',
        )
      }
      seen.add(request.path)
      return { operation: request.operation, path: request.path }
    })
    return { type: 'need_evidence', requests }
  }

  if (value.type !== 'assessment' || !hasExactKeys(value, ASSESSMENT_KEYS)) {
    throw new ReviewProtocolError('invalid-assessment-shape', 'invalid assessment shape')
  }
  if (!isEnum(value.risk, RISKS) || !isEnum(value.authorization, AUTHORIZATIONS)) {
    throw new ReviewProtocolError('invalid-enum', 'invalid assessment enum')
  }
  for (const key of [
    'narrowlyScoped',
    'planCompatible',
    'explicitProhibition',
    'maliciousUntrustedInstruction',
    'decisionCriticalUncertainty',
  ] as const) {
    if (typeof value[key] !== 'boolean') {
      throw new ReviewProtocolError('invalid-boolean', 'invalid ' + key)
    }
  }
  if (
    typeof value.reason !== 'string' ||
    value.reason.trim().length < 1
  ) {
    throw new ReviewProtocolError('invalid-reason', 'invalid assessment reason')
  }
  if (
    !Array.isArray(value.evidenceIds) ||
    value.evidenceIds.length > 32 ||
    value.evidenceIds.some(id => typeof id !== 'string')
  ) {
    throw new ReviewProtocolError(
      'invalid-evidence-ids',
      'invalid assessment evidence ids',
    )
  }

  return {
    ...value,
    evidenceIds: [...new Set(value.evidenceIds.filter(id => knownEvidenceIds.has(id)))],
  } as Assessment
}

export function applyPolicy(
  assessment: Assessment,
  ownerIds: ReadonlySet<string>,
): PolicyDecision {
  if (
    assessment.explicitProhibition ||
    assessment.maliciousUntrustedInstruction ||
    assessment.decisionCriticalUncertainty ||
    assessment.risk === 'Critical'
  ) {
    return { allow: false, reason: assessment.reason }
  }
  if (assessment.risk === 'High') {
    const authorized =
      (assessment.authorization === 'High' || assessment.authorization === 'Medium') &&
      assessment.evidenceIds.some(id => ownerIds.has(id))
    if (!authorized) {
      return {
        allow: false,
        reason: 'This high-risk action needs clear owner authorization for its material effects. ' +
          assessment.reason,
      }
    }
    return assessment.narrowlyScoped
      ? { allow: true, reason: assessment.reason }
      : { allow: false, reason: 'This high-risk action exceeds the authorized scope. Narrow its material effects. ' + assessment.reason }
  }
  return { allow: true, reason: assessment.reason }
}
