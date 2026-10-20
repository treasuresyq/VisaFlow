#!/usr/bin/env bun
import { join, resolve } from 'node:path'
import { VisaFlowService } from './service.ts'
import { DEMO_FIXTURES } from './fixtures.ts'

const args = process.argv.slice(2)
const command = args[0] ?? 'replay'
const flag = args.indexOf('--data-dir')
const dataDir = resolve(flag >= 0 && args[flag + 1] ? args[flag + 1]! : join(process.cwd(), '.visaflow-cli'))
const service = new VisaFlowService({ dataDir, autoRunTasks: false })
try {
  if (command === 'replay') {
    service.seedDemoCases()
    for (const summary of service.listCases()) if (summary.latestTaskId) service.runReview(summary.latestTaskId)
    let passed = 0
    const results = DEMO_FIXTURES.map(fixture => {
      const detail = service.listCases().map(value => service.getCase(value.id)).find(value => value.traces.some(event => event.data.fixture === fixture.key))!
      const referencesValid = detail.checks.every(check => check.evidenceIds.length > 0 && check.evidenceIds.every(key => detail.evidence.some(evidence => evidence.id === key)))
      const ok = detail.status === fixture.expected && referencesValid
      if (ok) passed++
      return { fixture: fixture.key, label: fixture.label, expected: fixture.expected, actual: detail.status, checkCount: detail.checks.length, issueCount: detail.issueCount, evidenceReferencesValid: referencesValid, passed: ok }
    })
    console.log(JSON.stringify({ scope: 'fictional_demo_policy', dataDir, passed, total: results.length, results }, null, 2))
    if (passed !== results.length) process.exitCode = 1
  } else if (command === 'cases') console.log(JSON.stringify(service.listCases(), null, 2))
  else if (command === 'trace' && args[1]) console.log(service.exportTrace(args[1]))
  else { console.error('Usage: bun src/cli.ts replay|cases|trace CASE_ID [--data-dir PATH]'); process.exitCode = 2 }
} finally { service.close() }
