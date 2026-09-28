// dsh-session-switch 客户端半 · 离线自测
//
// 跑法：node --test test/client-quick-word.test.mjs
//
// 守的是什么（这半块的历史教训：客户端炸一次＝整页打不开）：
//   ① 它仍然是"惰性工厂 + 预打包形式"，plugin id 严格等于包名；
//   ② 「换会话」注册成 action 指令，点下去发的是**纯文本词**（不是 `/换会话`，Host 靠整行关键词认词）；
//   ③ 服务没到齐、会话没挂上输入框、发送抛错 —— 三种情况都不许把页面带崩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT = new URL('../client.js', import.meta.url)

/** 把 client.js 当页面脚本加载一遍，拿回它的 exports。 */
async function loadClient() {
  const code = await readFile(CLIENT, 'utf8')
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(cfg) {
          captured = cfg
        },
      },
    },
    console,
  }
  vm.createContext(sandbox)
  vm.runInContext(code, sandbox, { filename: 'dsh-session-switch/client.js' })
  assert.ok(captured, 'client.js 必须调用 window.__ModuleLoader__.load(...)')
  assert.equal(captured.id, 'dsh-session-switch')
  return captured.factory(() => ({}))
}

function makeCtx({ inputActions, resolve, injectRuns = true } = {}) {
  const registered = []
  const scope = {
    commandUi: {
      register(contribution) {
        registered.push(contribution)
        return () => {}
      },
    },
    uiSession: {
      resolve(sessionId) {
        if (resolve !== undefined) return resolve(sessionId)
        return { props: { inputActions } }
      },
    },
    effect(fn) {
      return fn()
    },
  }
  const seenInjections = []
  const ctx = {
    inject(names, cb) {
      seenInjections.push(Array.from(names))
      if (injectRuns) cb(scope)
    },
  }
  return { ctx, registered, seenInjections }
}

test('元信息：惰性工厂形式，id 等于包名，模块级 inject 仍为空', async () => {
  const mod = await loadClient()
  assert.equal(typeof mod.apply, 'function')
  assert.deepEqual(Array.from(mod.inject), [])
})

test('注册：一条 action 指令「换会话」', async () => {
  const mod = await loadClient()
  const { ctx, registered, seenInjections } = makeCtx({ inputActions: { setDraft() {}, submit() {} } })
  mod.apply(ctx)

  assert.deepEqual(seenInjections, [['commandUi', 'uiSession']])
  assert.equal(registered.length, 1)
  const c = registered[0]
  assert.equal(c.name, '换会话')
  assert.equal(c.ui.kind, 'action')
  assert.equal(c.available({}), true)
  assert.ok(c.description().length > 0)
})

test('点一下：发的是词本身（纯文本，不是 /换会话）', async () => {
  const mod = await loadClient()
  const calls = []
  const { ctx, registered } = makeCtx({
    inputActions: {
      setDraft(text) {
        calls.push(['setDraft', text])
      },
      submit() {
        calls.push(['submit'])
      },
    },
  })
  mod.apply(ctx)
  registered[0].ui.run({ sessionId: 'session-19f7' })
  assert.deepEqual(calls, [
    ['setDraft', '换会话'],
    ['submit'],
  ])
})

test('服务没到齐（inject 不回调）：apply 不抛、不注册', async () => {
  const mod = await loadClient()
  const { ctx, registered } = makeCtx({ injectRuns: false })
  assert.doesNotThrow(() => mod.apply(ctx))
  assert.equal(registered.length, 0)
})

test('拿不到输入框 / 发送抛错：都不崩，只留 warning', async () => {
  const mod = await loadClient()
  const warned = []
  const realWarn = console.warn
  console.warn = (...args) => warned.push(args.join(' '))
  try {
    const missing = makeCtx({ resolve: () => undefined })
    mod.apply(missing.ctx)
    assert.doesNotThrow(() => missing.registered[0].ui.run({ sessionId: 's1' }))
    assert.doesNotThrow(() => missing.registered[0].ui.run({}))

    const broken = makeCtx({
      inputActions: {
        setDraft() {
          throw new Error('boom')
        },
        submit() {},
      },
    })
    mod.apply(broken.ctx)
    assert.doesNotThrow(() => broken.registered[0].ui.run({ sessionId: 's1' }))
    assert.ok(warned.some((w) => w.includes('boom')))
  } finally {
    console.warn = realWarn
  }
})
