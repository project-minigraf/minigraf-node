# minigraf (Node.js)

Node.js binding for [Minigraf](https://github.com/project-minigraf/minigraf) — zero-config,
single-file, embedded bi-temporal graph database with Datalog queries.

## Installation

```bash
npm install minigraf
```

| Platform | Architecture | Support |
|----------|-------------|---------|
| Linux | x64 | ✅ |
| Linux | arm64 | ✅ |
| macOS | universal (x64 + arm64) | ✅ |
| Windows | x64 | ✅ |

Requires Node.js 18+.

## Quick start

```js
import { MiniGrafDb } from 'minigraf'

// In-memory database
const db = MiniGrafDb.inMemory()
db.execute('(transact [[:alice :name "Alice"] [:alice :age 30]])')

const result = JSON.parse(db.execute('(query [:find ?n :where [?e :name ?n]])'))
console.log(result.results[0][0])  // "Alice"

// File-backed (persisted to disk)
const db2 = new MiniGrafDb('path/to/mydb.graph')
db2.execute('(transact [[:bob :name "Bob"]])')
db2.checkpoint()
db2.close()
```

## Closing a file-backed database

Only one handle per `.graph` file may be open in a process at a time — two
would each cache their own page table and corrupt the file — so call `close()`
when you are done with one:

```js
const db = new MiniGrafDb('mydb.graph')
db.execute('(transact [[:bob :name "Bob"]])')
db.checkpoint()
db.close()

const again = new MiniGrafDb('mydb.graph') // fine: the first handle is gone
```

Letting the variable go out of scope is **not** enough. JavaScript has no
deterministic destructor: the object becomes unreachable, but the underlying
handle survives until V8 garbage-collects it, which may be arbitrarily later or
not at all before the process exits. Reopening before then throws
`Database is already open in this process`.

`close()` is idempotent; every other method throws once it has run. In-memory
databases hold no file lock, so closing them is optional.

## Building from source

Requires Rust stable toolchain and `@napi-rs/cli`.

```bash
npm install
npx napi build --platform --release
```

## Cascade release

This repo receives a `core-release` repository_dispatch from the minigraf monorepo
cascade whenever a new version of the `minigraf` core crate is published. The release
workflow pins the new version, commits, tags, builds native `.node` binaries for all
platforms, and publishes to npm.

## License

MIT OR Apache-2.0
