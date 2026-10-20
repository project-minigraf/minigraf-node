// Stamps a release version into package.json, every platform package and the
// optionalDependencies that point at them. The loader refuses a platform
// package whose version differs from its own (#7), so all three must agree.
// Usage: node scripts/stamp-version.js <version>

const fs = require('node:fs')
const path = require('node:path')

const version = process.argv[2]
if (!version) throw new Error('usage: node scripts/stamp-version.js <version>')

const root = path.join(__dirname, '..')
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const write = (p, pkg) => fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n')

const rootPath = path.join(root, 'package.json')
const pkg = read(rootPath)
pkg.version = version

const platformDir = path.join(root, 'packages', '@minigraf')
const platformNames = []
for (const dir of fs.readdirSync(platformDir)) {
  const p = path.join(platformDir, dir, 'package.json')
  const platformPkg = read(p)
  platformPkg.version = version
  write(p, platformPkg)
  platformNames.push(platformPkg.name)
}

const deps = Object.keys(pkg.optionalDependencies).sort()
if (JSON.stringify(deps) !== JSON.stringify(platformNames.sort())) {
  throw new Error(`optionalDependencies (${deps}) do not match packages/@minigraf (${platformNames})`)
}
for (const dep of deps) pkg.optionalDependencies[dep] = version
write(rootPath, pkg)
