// #776 P16. Runs inside the foreign runtime, including bind/result conversion.
export async function cases(db, prefix, test) {
  const n = 1000
  const rows = raw => JSON.parse(raw).results
  const summary = answer => [answer.length, answer.reduce((s, r) => s + r[0], 0)]
  await db.execute('(transact [' + Array.from({ length: n }, (_, i) => `[:e${i} :n ${i}]`).join(' ') + '])')
  await db.execute('(transact [[:tags :tags #{1 "x"}]])')
  db.registerPredicate('bench-even?', v => v.value % 2n === 0n)
  db.registerAggregate('bench-total', {
    init: () => 0n,
    step: (acc, v) => acc + v.value,
    finish: acc => acc
  })
  const point = db.prepare('(query [:find ?n :where [?e :n $n] [?e :n ?n]])')
  const scan = db.prepare('(query [:find ?n :where [?e :n ?n] [(>= ?n $min)]])')
  const sets = db.prepare('(query [:find ?s :where [:tags :tags $s] [:tags :tags ?s]])')
  const predicate = db.prepare('(query [:find ?n :where [?e :n ?n] [(bench-even? ?n)]])')
  const aggregate = db.prepare('(query [:find (bench-total ?n) :where [?e :n ?n]])')
  function drain(size) {
    const answer = []
    const cursor = scan.query({ min: 0 })
    try {
      let raw
      while ((raw = cursor.nextBatch(size)) != null) answer.push(...JSON.parse(raw))
    } finally { cursor.close() }
    return summary(answer)
  }
  const shortlist = [
    ['prepared_execute/1k', () => rows(point.execute({ n: 500 })), [[500]]],
    ['cursor_batch_1/1k', () => drain(1), [1000, 499500]],
    ['cursor_batch_256/1k', () => drain(256), [1000, 499500]],
    ['set_roundtrip/2', () => rows(sets.execute({ s: new Set([1, 'x']) })), [[['x', 1]]]],
    ['predicate/1k', () => summary(rows(predicate.execute())), [500, 249500]],
    ['aggregate/1k', () => rows(aggregate.execute()), [[499500]]]
  ]
  const metrics = {}
  const executed = []
  for (const [suffix, operation, expected] of shortlist) {
    const id = `binding/${prefix}/${suffix}`
    const samples = []
    if (!test) for (let i = 0; i < 3; i++) {
      if (JSON.stringify(operation()) !== JSON.stringify(expected)) throw new Error(`incorrect warmup: ${id}`)
    }
    for (let i = 0; i < (test ? 1 : 10); i++) {
      let actual
      if (test) actual = operation()
      else {
        const start = performance.now()
        for (let j = 0; j < 20; j++) actual = operation()
        samples.push((performance.now() - start) * 1e6 / 20)
      }
      if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`incorrect result: ${id}`)
    }
    executed.push(id)
    if (!test) {
      samples.sort((a, b) => a - b)
      metrics[id] = { latency: { value: (samples[4] + samples[5]) / 2 } }
    }
  }
  return { metrics, executed }
}
