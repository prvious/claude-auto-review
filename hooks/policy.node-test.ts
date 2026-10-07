import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTHORIZATIONS,
  RISKS,
  applyPolicy,
  parseReviewResponse,
  ReviewProtocolError,
  type Assessment,
} from './policy.ts'

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  type: 'assessment',
  risk: 'Low',
  authorization: 'Unknown',
  narrowlyScoped: true,
  planCompatible: true,
  explicitProhibition: false,
  maliciousUntrustedInstruction: false,
  decisionCriticalUncertainty: false,
  reason: 'bounded development action',
  evidenceIds: ['u1'],
  ...overrides,
})

test('applies the complete risk and authorization matrix', () => {
  for (const risk of RISKS) {
    for (const authorization of AUTHORIZATIONS) {
      const result = applyPolicy(assessment({ risk, authorization }), new Set(['u1']))
      const expected =
        risk === 'Low' ||
        risk === 'Medium' ||
        (risk === 'High' && (authorization === 'High' || authorization === 'Medium'))
      assert.equal(result.allow, expected, `${risk}/${authorization}`)
    }
  }
  assert.equal(applyPolicy(assessment({ risk: 'High', narrowlyScoped: false }), new Set(['u1'])).allow, false)
})

test('overrides the matrix for restrictions and uncertainty', () => {
  for (const override of [
    { explicitProhibition: true },
    { maliciousUntrustedInstruction: true },
    { decisionCriticalUncertainty: true },
  ]) {
    assert.equal(applyPolicy(assessment(override), new Set()).allow, false)
  }
  assert.equal(applyPolicy(assessment({ planCompatible: false }), new Set()).allow, true)
})

test('strictly parses assessments and evidence requests', () => {
  const known = new Set(['u1', 'f1'])
  const valid = JSON.stringify(assessment({ evidenceIds: ['u1'] }))
  assert.deepEqual(
    parseReviewResponse(valid, known),
    assessment({ evidenceIds: ['u1'] }),
  )
  assert.deepEqual(
    parseReviewResponse(`\`\`\`json\n${valid}\n\`\`\``, known),
    assessment({ evidenceIds: ['u1'] }),
  )
  assert.deepEqual(
    parseReviewResponse(
      JSON.stringify({
        type: 'need_evidence',
        requests: [{ operation: 'read', path: 'README.md' }],
      }),
      known,
    ),
    {
      type: 'need_evidence',
      requests: [{ operation: 'read', path: 'README.md' }],
    },
  )
})

test('rejects malformed, extra, oversized, and unknown evidence output', () => {
  const known = new Set(['u1'])
  const invalid = [
    `before ${JSON.stringify(assessment())}`,
    `\`\`\`\n${JSON.stringify(assessment())}\n\`\`\``,
    JSON.stringify({ ...assessment(), extra: true }),
    JSON.stringify(assessment({ risk: 'Severe' as Assessment['risk'] })),
    JSON.stringify({ type: 'need_evidence', requests: [] }),
    JSON.stringify({
      type: 'need_evidence',
      requests: [
        { operation: 'read', path: 'a' },
        { operation: 'read', path: 'a' },
      ],
    }),
  ]
  for (const value of invalid) {
    assert.throws(() => parseReviewResponse(value, known), value.slice(0, 60))
  }
})

test('exposes stable protocol error codes without relaxing validation', () => {
  assert.throws(
    () => parseReviewResponse('not json', new Set()),
    error => {
      assert.equal(error instanceof ReviewProtocolError, true)
      assert.equal((error as ReviewProtocolError).code, 'not-json')
      return true
    },
  )
  assert.throws(
    () =>
      parseReviewResponse(
        JSON.stringify(assessment({ risk: 'Severe' as Assessment['risk'] })),
        new Set(),
      ),
    error => {
      assert.equal((error as ReviewProtocolError).code, 'invalid-enum')
      return true
    },
  )
})


test('long explanations and diagnostic citations never invalidate a verdict', () => {
  const result = parseReviewResponse(JSON.stringify(assessment({
    reason: 'explanation '.repeat(100), evidenceIds: ['u1', 'missing', 'u1'],
  })), new Set(['u1']))
  assert.equal(result.type, 'assessment')
  if (result.type === 'assessment') assert.deepEqual(result.evidenceIds, ['u1'])
})

test('high risk requires a captured owner citation, not transcript approval', () => {
  assert.equal(applyPolicy(assessment({risk:'High',authorization:'High',evidenceIds:['t1']}), new Set(['u1'])).allow, false)
  assert.equal(applyPolicy(assessment({risk:'High',authorization:'High'}), new Set(['u1'])).allow, true)
})
