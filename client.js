/**
 * dsh-session-switch — Client 半边：**几乎还是空壳**。
 *
 * 这里没有 slot、没有 DOM、没有轮询、没有 `throw`，`inject` 是空数组。
 * 这不是没写完，是踩过坑之后定下来的分工：
 *
 *  1. **一开始它自己也开新会话** —— 结果和 `dsh-auto-handoff` 的客户端
 *     **两边各切一次**：界面被切走两次，用户看到的是"跳到一半又跳一下"，
 *     而且两个 pending 互相覆盖，ack 谁先谁后说不清。
 *  2. 后来定成：**界面动作由 auto-handoff 的客户端做**（它本来就有一份
 *     读待接 → 切过去 → ack 的循环），**本插件的客户端保持空壳**。
 *     职责更干净：本插件只管 Host 那一摊（建会话、发交接包、写 pending），
 *     切界面这件事谁做都行，但**只由一个人做**。
 *  3. 附带好处：客户端以前出过一次"抛错把设置页搞白"。空壳没有可抛的东西，
 *     这类事故从结构上就不可能再发生。
 *
 * 所以：**建会话 / 发消息 / 写 pending 全在 Host 半边完成**；客户端（哪个都行）
 * 只负责"读到 pending → 切过去 → ack"。
 *
 * ── 2026-09-27 的唯一例外：「换会话」指令 ────────────────────────────────
 * 使用者那天说：「换会话就塞到换会话的插件里」。于是这里多了一件事——
 * 往输入框 ➕ 的**指令菜单**（官方那个 ➕，打开的就是输入 `/` 时的命令菜单）注册一条
 * **「换会话」**：点一下 = 发一条**纯文本**「换会话」，与使用者在键盘上手打再回车完全一样。
 * 为什么非要走纯文本：Host 半边是靠**用户消息里的整行关键词**认触发词的
 * （默认 `liveKeyword: 换会话`），发成 `/换会话` 就认不出来了。
 *
 * 破例的边界（继续守着上面那三条）：
 *   · 仍然**不写 DOM、不注册 slot、不轮询、不切界面** —— 只是"替使用者打字"，切会话的仍只有一个人；
 *   · 依赖只在回调里等（`ctx.inject`），服务没到齐就静默不注册，apply 永不抛；
 *   · 拿不到输入框就什么都不发，只留一行 Console warning（不假装发了）。
 *
 * 加载格式与 `dsh-meme`、官方客户端插件一致：注册一个 id 等于包名的惰性工厂。
 * 注册 id 写错（不等 loader entry 名）会被 ModuleLoader 报
 * "loaded without registering <id>"，所以这里必须严格等于包名。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-switch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Console 前缀，好过滤。 */
    var LOG = '[换会话·快捷词] '

    /**
     * 按会话取输入动作：uiSession 把每个会话的标准 prop 物化成 binding，inputActions 就在里面。
     * ⚠ 本文件的 `inputActionsOf` / `sendQuickWord` 与 `dsh-memory-board/client.js` 里的
     *   `quickWordInputActions` / `sendQuickWord` 是**同一份实现的两份拷贝**（客户端 bundle 各自单文件预打包，
     *   没法跨包 import）。改一个必须改另一个 —— 2026-09-27 用脚本比对过两者语义一致（只有分号/var-const 的风格差）。
     */
    function inputActionsOf(uiSession, sessionId) {
      if (uiSession === undefined || uiSession === null) return undefined
      if (typeof uiSession.resolve !== 'function' || sessionId === undefined) return undefined
      var binding
      try {
        binding = uiSession.resolve(sessionId)
      } catch (error) {
        return undefined
      }
      return binding && binding.props ? binding.props.inputActions : undefined
    }

    /** 发一条词：写草稿 + 提交（提交走队列，正忙时会排队）。拿不到输入框就只留一行 warning。 */
    function sendQuickWord(uiSession, session, text) {
      var actions = inputActionsOf(uiSession, session && session.sessionId)
      if (actions === undefined || actions === null) {
        console.warn(LOG + '「' + text + '」没发出去：这个会话还没挂上输入框')
        return
      }
      try {
        actions.setDraft(text)
        actions.submit()
      } catch (error) {
        console.warn(LOG + '发送失败：' + (error && error.message ? error.message : error))
      }
    }

    /**
     * 注册「换会话」。整块包在 try 里：这一步失败也绝不能连累插件入口（历史上"抛错搞白页面"就是入口炸的）。
     * 用 ctx.inject 等两个服务，不在同步阶段直接读它们。
     */
    function apply(ctx) {
      try {
        ctx.inject(['commandUi', 'uiSession'], function (scope) {
          try {
            scope.effect(function () {
              return scope.commandUi.register({
                name: '换会话',
                available: function () {
                  return true
                },
                description: function () {
                  return '触发自动交接，切到新会话'
                },
                ui: {
                  kind: 'action',
                  run: function (session) {
                    sendQuickWord(scope.uiSession, session, '换会话')
                  },
                },
              })
            }, 'dsh-session-switch: /换会话')
            console.info(LOG + '已在指令菜单里注册「换会话」')
          } catch (error) {
            console.warn(LOG + '注册「换会话」失败：' + (error && error.message ? error.message : error))
          }
        })
      } catch (error) {
        console.warn(LOG + '注册「换会话」失败：' + (error && error.message ? error.message : error))
      }
    }

    /** 空数组：不在加载门控上依赖任何客户端服务；需要的两个服务在 apply 里用 inject 等。 */
    const inject = []

    exports.apply = apply
    exports.inject = inject
    // 仅给 node --test 用；宿主/页面不消费
    exports.__test = { inputActionsOf: inputActionsOf, sendQuickWord: sendQuickWord }
    return module.exports
  },
})
