import { spawnSync } from 'node:child_process'
import path from 'node:path'

const SKIP_FLAG = '--skip-checks'
const args = new Set(process.argv.slice(2))

function run(command, commandArgs, options = {}) {
  const label = [command, ...commandArgs].join(' ')
  console.log(`\n> ${label}`)
  const spawn = spawnSpec(command, commandArgs)
  const result = spawnSync(spawn.command, spawn.args, {
    stdio: 'inherit',
    ...options
  })

  if (result.error) {
    console.error(`\npre-commit: failed to start "${label}": ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\npre-commit: "${label}" failed with exit code ${result.status}`)
    process.exit(result.status ?? 1)
  }
}

function capture(command, commandArgs, options = {}) {
  const spawn = spawnSpec(command, commandArgs)
  const result = spawnSync(spawn.command, spawn.args, {
    encoding: 'utf8',
    ...options
  })

  if (result.error) {
    console.error(`pre-commit: failed to run ${command}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim()
    if (stderr) console.error(stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout ?? ''
}

function normalizeGitPath(file) {
  return file.replaceAll('\\', '/')
}

function spawnSpec(command, commandArgs) {
  if (process.platform === 'win32' && ['npm', 'npx'].includes(command)) {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `${command}.cmd`, ...commandArgs]
    }
  }
  return { command, args: commandArgs }
}

function commandExists(command, probeArgs) {
  const spawn = spawnSpec(command, probeArgs)
  const result = spawnSync(spawn.command, spawn.args, { stdio: 'ignore' })
  return result.status === 0
}

function detectPythonCommand() {
  if (process.platform === 'win32' && commandExists('py', ['-3', '--version'])) {
    return ['py', ['-3']]
  }
  if (commandExists('python', ['--version'])) return ['python', []]
  if (commandExists('python3', ['--version'])) return ['python3', []]
  return null
}

function stagedContent(file) {
  const result = spawnSync('git', ['show', `:${file}`], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })

  if (result.status !== 0) return ''
  return result.stdout ?? ''
}

function headContent(file) {
  const result = spawnSync('git', ['show', `HEAD:${file}`], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  })
  return result.status === 0 ? result.stdout ?? '' : ''
}

function parseJson(content, file) {
  try {
    return JSON.parse(content)
  } catch (error) {
    console.error(`pre-commit: ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

function packageLockVersion(lock) {
  return lock?.packages?.['']?.version ?? lock?.version
}

function assertVersionBump(staged) {
  if (!staged.includes('package.json') || !staged.includes('package-lock.json')) {
    console.error('pre-commit: every commit must update the software version.')
    console.error('Stage both package.json and package-lock.json after running `npm version patch --no-git-tag-version` or another deliberate version bump.')
    process.exit(1)
  }

  const nextPackage = parseJson(stagedContent('package.json'), 'package.json')
  const previousPackageText = headContent('package.json')
  const previousPackage = previousPackageText ? parseJson(previousPackageText, 'HEAD:package.json') : undefined
  const nextLock = parseJson(stagedContent('package-lock.json'), 'package-lock.json')
  const previousVersion = previousPackage?.version
  const nextVersion = nextPackage?.version
  const lockVersion = packageLockVersion(nextLock)

  if (typeof nextVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nextVersion)) {
    console.error(`pre-commit: package.json version must be a semver-like string, got ${JSON.stringify(nextVersion)}.`)
    process.exit(1)
  }
  if (nextVersion === previousVersion) {
    console.error(`pre-commit: package.json version is still ${nextVersion}; bump it before committing.`)
    process.exit(1)
  }
  if (lockVersion !== nextVersion) {
    console.error(`pre-commit: package-lock.json version (${lockVersion}) does not match package.json (${nextVersion}).`)
    process.exit(1)
  }
}

const stagedFiles = capture('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean)
  .map(normalizeGitPath)

if (stagedFiles.length === 0) {
  console.log('pre-commit: no staged files, skipping checks.')
  process.exit(0)
}

const blockedPathPatterns = [
  /^build\//,
  /^dist\//,
  /^dist_clean\//,
  /^release\//,
  /^node_modules\//,
  /^userData\//,
  /^logs\//,
  /(^|\/)__pycache__\//,
  /\.tsbuildinfo$/,
  /\.(db|sqlite|sqlite3|db-wal|db-shm|log)$/i,
  /^\.env(\.|$)/,
  /(^|\/)config\.json$/i
]
const blockedFiles = stagedFiles.filter((file) => blockedPathPatterns.some((pattern) => pattern.test(file)))

if (blockedFiles.length > 0) {
  console.error('pre-commit: blocked generated, runtime, or secret-like files from being committed:')
  for (const file of blockedFiles) console.error(`  - ${file}`)
  console.error('Move these out of the commit, or force-commit only after a deliberate review.')
  process.exit(1)
}

const textFilesForSecretScan = stagedFiles.filter((file) =>
  /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|txt|yml|yaml|env|toml|ini)$/i.test(file)
)
const secretPatterns = [
  { name: 'OpenAI-like API key', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Google API key', pattern: /AIza[0-9A-Za-z_-]{25,}/ },
  { name: 'AWS access key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'Slack token', pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/ }
]
const secretHits = []

for (const file of textFilesForSecretScan) {
  if (file === 'package-lock.json') continue
  const content = stagedContent(file)
  for (const rule of secretPatterns) {
    if (rule.pattern.test(content)) {
      secretHits.push(`${file} (${rule.name})`)
    }
  }
}

if (secretHits.length > 0) {
  console.error('pre-commit: possible real secret detected in staged content:')
  for (const hit of secretHits) console.error(`  - ${hit}`)
  console.error('Use env:VAR_NAME references or local config instead of committing secrets.')
  process.exit(1)
}

assertVersionBump(stagedFiles)

if (args.has(SKIP_FLAG)) {
  console.log('pre-commit: cheap guards passed; command checks skipped by --skip-checks.')
  process.exit(0)
}

const tsRelated = stagedFiles.some((file) =>
  /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/i.test(file) ||
  ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs'].includes(file) ||
  file.startsWith('apps/') ||
  file.startsWith('packages/') ||
  file.startsWith('tests/') && file.endsWith('.test.ts')
)
const pythonRelated = stagedFiles.some((file) =>
  file.endsWith('.py') ||
  file.startsWith('core/') ||
  file.startsWith('storage/') ||
  file.startsWith('network/') ||
  file.startsWith('ui/') ||
  file.startsWith('config/') ||
  file.startsWith('llm/') ||
  file.startsWith('utils/') ||
  file.startsWith('tests/') && file.endsWith('.py')
)

if (tsRelated) {
  run('npx', ['tsc', '-b'])
  run('npm', ['test'])
} else {
  console.log('pre-commit: no TypeScript/Electron changes detected.')
}

if (pythonRelated) {
  const python = detectPythonCommand()
  if (!python) {
    console.error('pre-commit: Python changes detected, but no python/py command was found.')
    process.exit(1)
  }
  const [pythonCommand, baseArgs] = python
  run(pythonCommand, [...baseArgs, '-m', 'compileall', '-q', 'core', 'storage', 'network', 'tests'])
  run(pythonCommand, [...baseArgs, '-m', 'unittest', 'discover', '-s', 'tests'])
} else {
  console.log('pre-commit: no Python legacy-core changes detected.')
}

console.log('\npre-commit: all selected checks passed.')
