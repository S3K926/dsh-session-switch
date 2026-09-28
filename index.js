/**
 * dsh-session-switch — Host 半边。
 *
 * 只管"会话"那一摊：接 `dsh-auto-handoff` 的 POST → 建新会话 → 用 `followup`
 * 把交接包作为新会话的第一条消息发进去 → 把 `newSessionId` 记进 pending.json
 * → 由**客户端**（本插件的是空壳，实际由 auto-handoff 的客户端做）读到待接后
 * 切界面并回报 ack。
 *
 * 三条不能动的边界：
 *  1. 本插件**只写自己的** `~/.dsh/session-switch/`（`DSH_SESSION_SWITCH_DIR` 可覆盖），
 *     绝不碰用户的记忆档案、也绝不碰 `~/.dsh` 下别人的目录。
 *  2. `GET /api/session/pending` 没有待接时**返回 200 + 空**，绝不 404 ——
 *     客户端每 10 秒轮询一次，404 会在 Console 里刷成一片红（原版踩过这个坑）。
 *  3. 写任何状态文件都"先写临时文件再 rename"；读状态容忍不存在/空/坏 JSON。
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { BUDGET_MAX_PER_WINDOW, BUDGET_MAX_RECORDS, BUDGET_WINDOW_MS, MAX_PENDING_AGE_MS, PENDING_FIELDS, SOURCE_COOLDOWN_MS, appendLog, budgetFile, buildPending, checkHandoffGate, errorCode, errorMessage, harnessHome, llmModule, loadCreateUserMessage, logPath, makeLogger, noteHandoff, parseAt, pendingDir, pendingFile, readBudget, readPending, writeBudget, writeFileAtomic, writePending } from './switch-store.js';

/**
 * 造新会话第一条消息要用的 `createUserMessage`。
 *
 * 为什么**不用静态 import**：静态 import 会让"包不在解析路径上"这件事在
 * 模块加载阶段就炸掉，于是 `node index.js --selftest` 连一行都跑不出来
 * （自检的整个意义就是"独立跑也能自证"）。改成首次真正要建消息时再解析，
 * 缺依赖就退化成一条明确错误交给路由返回，而不是整个插件起不来。
 *
 * 运行期这个包一定在：插件由 dsh 通过 profile 的 node_modules 加载，那里有
 * `@deepseek-ai/dsh-llm`（它也是本包的 peerDependency）。
 *
 * @returns {Promise<Function>} 真正用到的 `createUserMessage`。
 */

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------

/** 不校验 content-type：auto-handoff 用 fetch 发 JSON，但手工 curl 验证时常常忘带 header。 */
async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limitBytes) {
			req.resume();
			return { ok: false, reason: `body 超过 ${limitBytes} 字节` };
		}
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	if (text === '') return { ok: true, value: {} };
	try {
		const value = JSON.parse(text);
		if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'body 必须是 JSON 对象' };
		return { ok: true, value };
	} catch (error) {
		return { ok: false, reason: `JSON 解析失败：${errorMessage(error)}` };
	}
}

/** 从请求里取"新会话用什么模型"；调用方给的 provider/model 都为空时返回 undefined（用默认）。 */
function routeOf(body) {
	return {
		provider: typeof body.provider === 'string' ? body.provider : '',
		model: typeof body.model === 'string' ? body.model : '',
	};
}

/** 选择新会话的 provider/model：请求里带了就用请求的，否则用当前部署默认。 */
function modelRouteFor(ctx, route) {
	const current = ctx.agentDefaultModel.currentSelection();
	if (route.provider !== '' && route.model !== '') return { provider: route.provider, model: route.model };
	if (route.provider === '' && route.model === '') return { provider: current.provider, model: current.model };
	// 只给了一半：信明确的那一半，另一半用默认（而不是整条丢掉）。
	return {
		provider: route.provider === '' ? current.provider : route.provider,
		model: route.model === '' ? current.model : route.model,
	};
}

/** 选 agent 预设：请求里指定则用指定的，否则用默认预设。 */
async function resolveAgentPreset(ctx, requested) {
	if (typeof requested === 'string' && requested.trim() !== '') await ctx.agentPresets.resolve(requested);
	return await ctx.agentPresets.resolve();
}

// ---------------------------------------------------------------------------
// 建会话
// ---------------------------------------------------------------------------

/**
 * 建一个新会话并把交接包作为**第一条消息**发进去。
 *
 * `followup` 而不是 `inject`：`inject` 会插进"当前这一步"的上下文，而这是一段
 * 全新对话的开场白，必须是这个新会话的第一条用户消息。
 *
 * 顺序跟官方 `dsh-webhook` 的 `createWebhookSession` 一致，并且同样做了回滚：
 * attach 失败就 dispose 掉半成品会话，避免留下"界面里看不见但占着 id"的鬼会话。
 *
 * @returns {Promise<{ ok: true, sessionId: string, agent: object, title: string } | { ok: false, error: string }>}
 */
async function createSessionForHandoff(ctx, { handoff, cwd, route, agentPreset, permissionPreset, sourceTitle }) {
	// 这几样是"能建会话"的前提。缺任何一个都直接说清楚缺谁：
	// 报 `Cannot read properties of undefined` 等于让人去猜（本机被裁过插件的组合里真的会缺）。
	for (const service of ['agents', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'sessionTitle', 'workspaceRegistry']) {
		if (ctx[service] === undefined) throw new Error(`本机没有 ${service} 服务，建不了会话（这个组合里可能没装对应的插件）`);
	}
	const preset = await resolveAgentPreset(ctx, agentPreset);
	const permission = typeof permissionPreset === 'string' && permissionPreset.trim() !== '' ? permissionPreset : ctx.permissionPresets.defaultPreset;
	ctx.permissionPresets.resolve(permission);

	const workspace = await ctx.workspaceRegistry.create(cwd, '会话切换');
	const sessionId = `session-${randomUUID()}`;
	const handle = await ctx.agents.create({
		sessionId,
		meta: { cwd: workspace.path, agentPreset: preset.id },
		agentOptions: { ...modelRouteFor(ctx, route) },
		setup: async (agentCtx) => {
			await ctx.agentPresets.mount(agentCtx, preset.id);
		},
	});

	try {
		await workspace.attachSession(sessionId);
		ctx.permissionPresets.set(handle.agent.session, permission);
		// 新会话沿用**原会话的名字**（使用者 2026-09-27 定的口径）；拿不到原名才回退「会话交接」。
		const usedTitle = renameSessionTitle(ctx, handle.agent.session, sourceTitle);
		// 必须用 `createUserMessage`：`UserMessage` 还带自动生成的 `id` 和标了来源的
		// `source`，手写 `{role,content}` 会造出一条缺字段的消息，落盘/投影时才炸
		//（官方 dsh-webhook 也是这么建的）。依赖缺失时这里抛出的错会被下面接住、
		// 回滚半成品会话，然后由路由返回明确错误 JSON。
		const createUserMessage = await loadCreateUserMessage();
		handle.agent.followup(createUserMessage({
			content: [{ type: 'text', text: handoff }],
			source: { kind: 'user' },
		}));
		return { ok: true, sessionId, agent: handle.agent, title: usedTitle };
	} catch (error) {
		try {
			await workspace.detachSession(sessionId);
		} catch (rollbackError) {
			// 回滚失败只记日志，不能盖住原始错误（那是真正要诊断的东西）。
			ctx.logger.warn(`session-switch: 回滚 detach 失败 ${errorMessage(rollbackError)}`);
		}
		try {
			await handle.dispose();
		} catch (rollbackError) {
			ctx.logger.warn(`session-switch: 回滚 dispose 失败 ${errorMessage(rollbackError)}`);
		}
		return { ok: false, error: errorMessage(error) };
	}
}

/**
 * 给新建的交接会话起名：**优先沿用原会话的标题**（使用者 2026-09-27 要求的"新会话名字与原会话一致"）。
 *
 * 三条一起守住：
 *   ① **拿不到原名就回退**「会话交接」（老调用方、对面没传名字时，行为跟以前一模一样）；
 *   ② `rename` 对"归一化之后为空"的标题会抛 `SessionTitleInvalidError`（全空白、或太长被裁空都会），
 *      所以必须 try/catch —— **绝不能让"起名"这一步把整个交接搞失败**（会话已经建好了，为此回滚更亏）；
 *   ③ 失败只写日志，不往上抛。
 *
 * @param {object} ctx 宿主上下文（`sessionTitle` 是本插件的硬依赖，已在 `inject` 里）
 * @param {object} session 刚建好的新会话
 * @param {string} preferredTitle 原会话的标题（可能为空/不合法）
 * @returns {string} 实际用上的标题；两种都没成就是空串
 */
function renameSessionTitle(ctx, session, preferredTitle) {
	const fallback = '会话交接';
	for (const candidate of [preferredTitle, fallback]) {
		if (typeof candidate !== 'string' || candidate.trim() === '') continue;
		try {
			ctx.sessionTitle.rename(session, candidate);
			return candidate.trim();
		} catch (error) {
			ctx.logger?.warn?.(`session-switch: 起名失败（${candidate.slice(0, 24)}）：${errorMessage(error)}`);
		}
	}
	return '';
}

// ---------------------------------------------------------------------------
// 路由处理（拆成小函数：一个函数一个端点，方便直接喂假 req/res 测）
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
	res.statusCode = status;
	res.setHeader('content-type', 'application/json; charset=utf-8');
	res.setHeader('cache-control', 'no-store');
	res.end(JSON.stringify(payload));
}

function sendMethodNotAllowed(res, allow) {
	res.statusCode = 405;
	res.setHeader('allow', allow);
	res.end();
}

/**
 * 把请求体解析成建会话要的参数。
 * @returns {{ ok: true, value: object } | { ok: false, status: number, error: string }}
 */
function parseSwitchRequest(body) {
	const handoff = typeof body.handoff === 'string' ? body.handoff : '';
	if (handoff.trim() === '') return { ok: false, status: 400, error: 'handoff 不能为空' };
	return {
		ok: true,
		value: {
			handoff,
			cwd: typeof body.cwd === 'string' && body.cwd.trim() !== '' ? body.cwd : process.cwd(),
			sourceSession: typeof body.sourceSession === 'string' ? body.sourceSession : '',
			// 原会话的名字：建新会话时沿用（使用者 2026-09-27 要求"新会话名字与原会话一致"）。
			sourceTitle: typeof body.sourceTitle === 'string' ? body.sourceTitle : '',
			route: routeOf(body),
			agentPreset: body.agentPreset,
			permissionPreset: body.permissionPreset,
			seq: body.seq,
		},
	};
}

/** 建会话串行锁：见 handler 里的注释（检查→建会话→记账必须原子，否则闸会被并发穿透）。 */
let switchChain = Promise.resolve();

/**
 * 收下切换请求：建会话 → 发交接包 → 记 pending → 回 `{ok:true,pending:{newSessionId}}`。
 *
 * ⚠ 2026-09-27：整段包在 `switchChain` 串行锁里。原因：`checkHandoffGate` 只读、
 * `noteHandoff` 在 `await createSessionForHandoff` **之后**才写盘 —— 两个请求同时进来时，
 * 两边都能看到"还没到上限"，于是都建了会话。事故那天是短时间内涌进上百个请求，
 * 这种竞态会被放大到"闸形同虚设"。串行化之后最坏只是排队慢一点。
 */
function makeSwitchHandler(ctx, log) {
	const handleSwitch = async function handleSwitch(req, res) {
		if (req.method !== 'POST') {
			sendMethodNotAllowed(res, 'POST');
			return;
		}
		const body = await readJsonBody(req);
		if (!body.ok) {
			log(`收到切换请求但 body 不合法：${body.reason}`);
			sendJson(res, 400, { ok: false, error: body.reason });
			return;
		}
		const parsed = parseSwitchRequest(body.value);
		if (!parsed.ok) {
			log(`收到切换请求但参数不合法：${parsed.error}`);
			sendJson(res, parsed.status, { ok: false, error: parsed.error });
			return;
		}
		const input = parsed.value;

		// 🛑 刹车（2026-09-27 事故）：先过闸，拒了**绝不建会话**、也不消耗预算。
		const gate = checkHandoffGate(input, log);
		if (!gate.allow) {
			log(`切换被闸住（${gate.reason}）：${gate.error}｜sourceSession=${input.sourceSession || '(空)'}`);
			sendJson(res, gate.status, { ok: false, error: gate.error, reason: gate.reason });
			return;
		}

		log(`收到切换请求：sourceSession=${input.sourceSession || '(空)'} seq=${String(input.seq)} handoff=${input.handoff.length} 字 cwd=${input.cwd}`);

		let made;
		try {
			made = await createSessionForHandoff(ctx, input);
		} catch (error) {
			made = { ok: false, error: errorMessage(error) };
		}

		if (!made.ok) {
			// 建会话失败**不写 pending**：写了等于让客户端切到一个不存在的会话。
			// 调用方（auto-handoff）会自己降级成"把待接写进约定位置"，这是设计好的分工。
			log(`建会话失败（未写 pending，等调用方降级）：${made.error}`);
			sendJson(res, 500, { ok: false, error: `建会话失败：${made.error}` });
			return;		}
		log(`建会话成功：${made.sessionId}（标题＝${made.title || '（未起名）'}）`);

		const pending = buildPending({
			mode: 'auto',
			seq: input.seq,
			sourceSession: input.sourceSession,
			newSessionId: made.sessionId,
			handoff: input.handoff,
			note: '由 dsh-session-switch Host 半边建会话并写入',
		});
		try {
			writePending(pending, undefined, log);
		} catch (error) {
			log(`写 pending 失败（会话已建好，界面可能切不过去）：${errorMessage(error)}`);
		}
		// 🛑 记账放在"会话真的建好之后"：建失败不算一次交接（调用方会降级），不消耗预算。
		noteHandoff(input, undefined, log);
		sendJson(res, 200, { ok: true, pending: { newSessionId: made.sessionId } });
	};

	// 串行链：这一次请求跑完才轮到下一次 —— "检查→建会话→记账"因此成为原子段。
	return function serializedSwitch(req, res) {
		const next = switchChain.then(
			() => handleSwitch(req, res),
			() => handleSwitch(req, res),
		);
		// 链上永远不落拒绝，否则一次失败会把后面所有请求一起带崩。
		switchChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	};
}

/**
 * 给客户端轮询：**永远 200**。
 * 没有待接时返回空壳而不是 404 —— 客户端是每 10 秒一次的定时轮询，
 * 404 会让浏览器 Console 每隔 10 秒多一条红色报错，真正的错误反而被淹掉。
 */
function makePendingHandler(log) {
	return function handlePending(req, res) {
		if (req.method !== 'GET') {
			sendMethodNotAllowed(res, 'GET');
			return;
		}
		const { pending, stale } = readPending(undefined, log);
		sendJson(res, 200, {
			ok: true,
			pending,
			empty: pending === null,
			stale,
		});
	};
}

/**
 * 界面切完之后回报，按 `at` 去重。
 * 去重只靠 `at`（而不是"有没有 pending 文件"）：客户端可能重试，重试不该再切一次。
 */
async function handleAck(req, res, log, ctx) {
	if (req.method !== 'POST') {
		sendMethodNotAllowed(res, 'POST');
		return;
	}
	const body = await readJsonBody(req);
	if (!body.ok) {
		sendJson(res, 400, { ok: false, error: body.reason });
		return;
	}
	const at = typeof body.value.at === 'string' ? body.value.at : '';
	if (at.trim() === '') {
		sendJson(res, 400, { ok: false, error: 'ack 需要 at（就是 pending 里的那个 at）' });
		return;
	}
	const { pending, acked } = readPending(undefined, log);
	if (acked) {
		// 按 `at` 去重：这条已经处理过了（客户端重试、或另一个客户端先 ack 了），不再来一遍。
		log(`收到 ack ${at}：这条已经处理过，去重忽略`);
		sendJson(res, 200, { ok: true, acked: true, duplicate: true, note: '这条 at 已处理过' });
		return;
	}
	if (pending === null) {
		log(`收到 ack ${at}：当前没有待接`);
		sendJson(res, 200, { ok: true, acked: false, note: '没有待接，视为已处理' });
		return;
	}
	if (pending.at !== at) {
		log(`收到 ack ${at}：与当前待接 ${String(pending.at)} 不匹配，不动`);
		sendJson(res, 200, { ok: true, acked: false, note: 'at 不匹配，忽略' });
		return;
	}
	// 归档的是**源**会话（交接完就退场的那一段），不是新建出来的那段。
	// 有活着的客户端时界面多半已经自己归档过；这里失败（例如"源会话本来就没归任何工作区"）
	// 只记日志，不能反过来把 ack 变成错误 —— ack 的语义是"界面已经切过去了"。
	if (typeof pending.sourceSession === 'string' && pending.sourceSession !== '' && ctx.workspaceRegistry !== undefined) {
		try {
			await ctx.workspaceRegistry.archiveSession(pending.sourceSession, { stopActivity: true });
			log(`已归档源会话：${pending.sourceSession}`);
		} catch (error) {
			log(`归档源会话失败（不影响 ack）：${errorMessage(error)}`);
		}
	}
	try {
		// 留一个 handled 标记再落盘：pending 从此读出来是"空"（客户端不会重切），
		// 但 at 还在，重复 ack 能被识别成"这个我已经办过了"。
		writePending({ ...pending, handled: true, handledAt: new Date().toISOString(), note: 'acked' }, undefined, log);
	} catch (error) {
		log(`写 handled 标记失败：${errorMessage(error)}`);
	}
	log(`ack 完成：at=${at}`);
	sendJson(res, 200, { ok: true, acked: true });
}

function makeHealthHandler() {
	return function handleHealth(req, res) {
		if (req.method !== 'GET') {
			sendMethodNotAllowed(res, 'GET');
			return;
		}
		sendJson(res, 200, { ok: true, plugin: 'dsh-session-switch', half: 'host', stateDir: pendingDir() });
	};
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

export const name = 'dsh-session-switch';
/**
 * 声明**全部**要用的服务（2026-09-25 13:0x 真机事故后改的，别再"精简"它）：
 *
 * 血泪经过：第一版写成 `{ required, optional }` → 插件卡 pending（cordis 的 inject 是**数组**）；
 * 第二版"聪明"了一把，只留 `webServer`、把建会话要的六样留到运行时检查 —— 结果真机上
 * `POST /api/session/switch` 一路报 **`cannot get property "agents" without inject`**
 * （cordis 不允许访问没在 inject 里声明过的服务，运行时那层检查根本轮不到）。
 * → **交接卡在"建不了会话"，使用者看到的就是"新会话没开起来"。**
 *
 * 教训：**cordis 的注入声明是硬门禁，"运行时再检查"不成立**；要用就写进来。
 * （代价：本机若真缺其中某个服务，插件会 pending —— 但那时日志会明说缺谁，比"看着活着、
 * 一调用就炸"好得多。）
 */
export const inject = ['connection', 'agents', 'agentPresets', 'permissionPresets', 'agentDefaultModel', 'sessionTitle', 'workspaceRegistry'];

/**
 * 把 Node 风格的 `(req, res)` 处理器适配成 `ctx.connection.fetch.register` 要的 `fetch(request) → Response`。
 *
 * 为什么加这一层（2026-09-28 安全修复）：这四条路由原来挂 `ctx.webServer.register({ kind: 'exact' })`，
 * 而宿主的分派顺序是 **exact 优先于 `/api` 前缀** —— 于是它们绕过了宿主给 `/api` 路由加的
 * token ＋ Host/Origin 防线（实测：不带任何凭据 `GET /api/session/health` 就回 200，而 `/api/memory/*` 回 401）。
 * 改走 `connection.fetch` 之后，它们和别的 `/api` 路由一样要过 `requestRejection()` 那两道检查。
 * 处理器本身**一行没改**，这里只做 `Request ⇄ (req, res)` 的形状转换。
 */
function nodeHandlerToFetch(handler) {
	return async function fetchRoute(request) {
		const url = new URL(request.url);
		const text = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();
		const req = {
			method: request.method,
			url: url.pathname + url.search,
			headers: Object.fromEntries(request.headers),
			async *[Symbol.asyncIterator]() {
				if (text !== '') yield Buffer.from(text, 'utf8');
			},
			resume() {},
		};
		const chunks = [];
		let status = 200;
		const headers = {};
		const res = {
			get statusCode() {
				return status;
			},
			set statusCode(code) {
				status = code;
			},
			setHeader(key, value) {
				headers[String(key).toLowerCase()] = String(value);
			},
			writeHead(code, extra) {
				status = code;
				for (const [k, v] of Object.entries(extra ?? {})) res.setHeader(k, v);
			},
			write(chunk) {
				if (chunk !== undefined && chunk !== null) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
			},
			end(chunk) {
				if (chunk !== undefined && chunk !== null) res.write(chunk);
			},
			on() {},
			once() {},
			removeListener() {},
			emit() {},
		};
		await handler(req, res);
		return new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, { status, headers });
	};
}

export function apply(ctx) {
	const log = makeLogger(ctx, undefined);
	log(`apply 进入（stateDir=${pendingDir()}）`);

	ctx.connection.fetch.register({ path: '/api/session/switch', methods: ['POST'], requestBody: 'buffered', fetch: nodeHandlerToFetch(makeSwitchHandler(ctx, log)) });
	log('已注册 POST /api/session/switch');

	ctx.connection.fetch.register({ path: '/api/session/pending', methods: ['GET'], requestBody: 'buffered', fetch: nodeHandlerToFetch(makePendingHandler(log)) });
	log('已注册 GET /api/session/pending');

	ctx.connection.fetch.register({ path: '/api/session/ack', methods: ['POST'], requestBody: 'buffered', fetch: nodeHandlerToFetch((req, res) => handleAck(req, res, log, ctx)) });
	log('已注册 POST /api/session/ack');

	ctx.connection.fetch.register({ path: '/api/session/health', methods: ['GET'], requestBody: 'buffered', fetch: nodeHandlerToFetch(makeHealthHandler()) });
	log('已注册 GET /api/session/health');
}

// ---------------------------------------------------------------------------
// 自检（模块层）
//
// **必须在这里，不能放进 apply()**：原版第一版把自检写在 apply 里，独立跑
// `node index.js --selftest` 时 cordis 根本不会调 apply，脚本一声不吭地退出，
// 看起来"通过了"，实际什么都没测。
// ---------------------------------------------------------------------------

/** 构造一个假的 res，把状态码/JSON 收集下来给自检断言用。 */
function fakeResponse() {
	const res = {
		statusCode: 200,
		headers: {},
		body: '',
		setHeader(k, v) {
			this.headers[k] = v;
		},
		end(text) {
			this.body = text ?? '';
		},
		json() {
			return this.body === '' ? null : JSON.parse(this.body);
		},
	};
	return res;
}

/** 把一段字符串包成异步可迭代的请求体。 */
function fakeRequest({ method = 'GET', body }) {
	const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
	return {
		method,
		headers: { 'content-type': 'application/json' },
		async *[Symbol.asyncIterator]() {
			if (text !== '') yield Buffer.from(text, 'utf8');
		},
		resume() {},
	};
}

/** 自检用的假 ctx：够跑通路由，且**绝不**真的建会话。 */
function fakeContext({ failCreate }) {
	const warnings = [];
	const session = { id: 'session-fake' };
	return {
		warnings,
		logger: { info() {}, warn: (line) => warnings.push(line) },
		agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
		agentPresets: { resolve: async () => ({ id: 'default' }), mount: async () => ({}) },
		permissionPresets: { defaultPreset: 'workspace-write', resolve: () => ({}), set: () => {} },
		workspaceRegistry: {
			create: async (path) => {
				if (failCreate !== undefined) throw new Error(failCreate);
				return { path, attachSession: async () => {}, detachSession: async () => {} };
			},
			archiveSession: async () => {},
		},
		// 记下每次起名：⑮ 要验"新会话沿用原会话的名字"。
		sessionTitle: {
			renamed: [],
			rename(session, title) {
				this.renamed.push({ session, title });
			},
		},
		agents: {
			create: async () => ({ agent: { session, followup: () => {} }, dispose: async () => {} }),
		},
	};
}

// ⚠ 2026-09-28：（另一台设备）把原先被注释成「[自检口]」的打印**全部恢复**了。
//   原因：注释掉之后 `node index.js --selftest` 只返回退出码（没设 DSH_SESSION_SWITCH_DIR 时
//   静默 return 1），看起来像"自检坏了"，实际是"自检没跑"。跑法：
//     DSH_SESSION_SWITCH_DIR=/tmp/ss-selftest node index.js --selftest
//   （它拒绝在真实 ~/.dsh 里跑，所以必须给临时目录。）
async function runSelfTest() {
	const override = process.env.DSH_SESSION_SWITCH_DIR;
	if (typeof override !== 'string' || override.trim() === '') {
		console.error('✗ 自检必须显式指定 DSH_SESSION_SWITCH_DIR（指向临时目录）；本插件绝不往真实的 ~/.dsh 里写测试数据。');
		return 1;
	}
	const dir = resolve(override.trim());
	// 双保险：就算环境变量指到了真家里，也在写任何东西之前掉头。
	// 真家 = $DSH_HOME（便携/多实例下就是那台机器的 harness home），没设时才是 ~/.dsh。
	const liveHome = harnessHome();
	if (resolve(liveHome) === dir || dir.startsWith(`${resolve(liveHome)}\\`) || dir.startsWith(`${resolve(liveHome)}/`)) {
		console.error(`✗ 拒绝在真实 DSH 家目录里自检：${dir}`);
		return 1;
	}
	try {
		realpathSync.native(dir);
	} catch {
		// 目录还不存在：正常，第一次写的时候会 mkdir。
	}

	const results = [];
	const check = (label, pass, detail = '') => {
		results.push({ label, pass, detail });
		console.log(`${pass ? '✓' : '✗'} ${label}${detail === '' ? '' : `  → ${detail}`}`);
	};
	const log = (line) => {
		appendLog(`session-switch: ${line}`, dir);
	};
	const file = pendingFile(dir);
	const logFile = logPath(dir);

	console.log(`自检目录：${dir}\n`);

	// ① pending.json 不存在时读待接 = 空，而不是报错
	const missing = readPending(dir, log);
	check('① pending.json 不存在时读出来是"空"（不报错）', missing.pending === null && missing.stale === false, `pending=${JSON.stringify(missing.pending)}`);

	// ② 写一条待接后能读出来
	const written = writePending(
		buildPending({ at: new Date().toISOString(), mode: 'auto', seq: 48, sourceSession: 'session-src', newSessionId: 'session-dst', handoff: '交接包内容', note: 'selftest' }),
		dir,
		log,
	);
	const readBack = readPending(dir, log).pending;
	check(
		'② 写一条待接后能读出来（字段齐、handoffChars 算得对）',
		readBack !== null && readBack.newSessionId === 'session-dst' && readBack.seq === 48 && readBack.handoffChars === written.handoffChars,
		`newSessionId=${String(readBack?.newSessionId)} seq=${String(readBack?.seq)} handoffChars=${String(readBack?.handoffChars)}`,
	);

	// ③ ack 后不再重复返回（pending 读出来是空，且第二次 ack 被按 at 去重）
	const ctx = fakeContext({});
	const ackRes = fakeResponse();
	await handleAck(fakeRequest({ method: 'POST', body: { at: written.at } }), ackRes, log, ctx);
	const afterAck = readPending(dir, log);
	check('③ ack 后不再重复返回（待接读出来是空）', ackRes.statusCode === 200 && ackRes.json()?.acked === true && afterAck.pending === null, `HTTP ${ackRes.statusCode} pending=${JSON.stringify(afterAck.pending)}`);
	const ackAgain = fakeResponse();
	await handleAck(fakeRequest({ method: 'POST', body: { at: written.at } }), ackAgain, log, ctx);
	const ackAgainBody = ackAgain.json();
	check('③b 重复 ack 按 at 去重（acked=true, duplicate=true）', ackAgain.statusCode === 200 && ackAgainBody?.duplicate === true, `HTTP ${ackAgain.statusCode} ${JSON.stringify(ackAgainBody)}`);
	const pendingAfterAck = fakeResponse();
	makePendingHandler(log)(fakeRequest({ method: 'GET' }), pendingAfterAck);
	check('③c ack 之后 GET /pending 返回空', pendingAfterAck.json()?.empty === true, JSON.stringify(pendingAfterAck.json()));

	// ④ 坏 JSON 不崩
	writeFileSync(file, '{ 这不是 JSON', 'utf8');
	const broken = readPending(dir, log);
	const logText1 = readFileSync(logFile, 'utf8');
	check('④ 坏 JSON 不崩、当空处理、并记了一行日志', broken.pending === null && logText1.includes('JSON 解析失败'), `pending=${JSON.stringify(broken.pending)}`);

	// ⑤ 超过 2 小时的旧待接被跳过并记日志
	const oldAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
	writePending(buildPending({ at: oldAt, mode: 'auto', sourceSession: 'session-old', handoff: '过期交接包' }), dir, log);
	const stale = readPending(dir, log);
	const logText2 = readFileSync(logFile, 'utf8');
	check('⑤ 超过 2 小时的旧待接被跳过并记日志', stale.pending === null && stale.stale === true && logText2.includes('超过 2 小时'), `stale=${String(stale.stale)} pending=${JSON.stringify(stale.pending)}`);

	// ⑥ 路由：pending 没有待接时必须是 200 + 空，**不是 404**（客户端每 10 秒轮询，404 会刷爆 Console）
	const pendingRes = fakeResponse();
	makePendingHandler(log)(fakeRequest({ method: 'GET' }), pendingRes);
	const pendingBody = pendingRes.json();
	check('⑥ GET /api/session/pending 无待接时 200 + 空（不是 404）', pendingRes.statusCode === 200 && pendingBody?.empty === true && pendingBody?.pending === null, `HTTP ${pendingRes.statusCode}`);

	// ⑦ 降级路径：拿假 ctx 直接调 handler，看"叫不动时返回什么"
	const failCtx = fakeContext({ failCreate: '本机没有活的会话工厂' });
	const failRes = fakeResponse();
	await makeSwitchHandler(failCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-x', seq: 1, handoff: '交接包', cwd: 'D:\\dsh' } }), failRes);
	const failBody = failRes.json();
	check(
		'⑦ 建会话失败时返回明确错误 JSON（不是挂住、不是 200）',
		failRes.statusCode === 500 && failBody?.ok === false && typeof failBody?.error === 'string',
		`HTTP ${failRes.statusCode} error=${String(failBody?.error)}`,
	);
	const stillEmpty = readPending(dir, log).pending;
	check('⑦b 建会话失败时**不写** pending（避免切到不存在的会话）', stillEmpty === null, `pending=${JSON.stringify(stillEmpty)}`);

	// ⑧ 降级路径：没有 agents 等服务时，要**点名说缺谁**，而不是抛个 undefined 让人去猜
	const nakedCtx = { logger: { info() {}, warn() {} } };
	const nakedRes = fakeResponse();
	await makeSwitchHandler(nakedCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-y', handoff: '交接包' } }), nakedRes);
	const nakedBody = nakedRes.json();
	check(
		'⑧ 缺少建会话服务时点名说缺谁（不是 Cannot read properties）',
		nakedRes.statusCode === 500 && nakedBody?.ok === false && String(nakedBody.error).includes('agents'),
		`HTTP ${nakedRes.statusCode} error=${String(nakedBody?.error)}`,
	);

	// ⑨ 交接包真的发不进去时（这条路径 = 建消息的依赖不在解析路径上），
	// 必须回滚半成品会话并返回明确错误，而不是留下一个空的鬼会话。
	let disposed = 0;
	const noLlmCtx = fakeContext({});
	noLlmCtx.agents.create = async () => ({
		agent: { session: { id: 'session-fake' }, followup: () => { throw new Error('不该走到这里'); } },
		dispose: async () => {
			disposed += 1;
		},
	});
	const noLlmRes = fakeResponse();
	await makeSwitchHandler(noLlmCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-z', handoff: '交接包' } }), noLlmRes);
	const noLlmBody = noLlmRes.json();
	check(
		'⑨ 交接包发不进去时回滚并返回明确错误（本进程解析不到 @deepseek-ai/dsh-llm）',
		noLlmRes.statusCode === 500 && noLlmBody?.ok === false && disposed === 1,
		`HTTP ${noLlmRes.statusCode} disposed=${disposed} error=${String(noLlmBody?.error).slice(0, 60)}`,
	);

	// ⑪～⑬ 刹车三道闸（2026-09-27 交接连锁事故后加的）。**从零开始**，不受前面用例影响：
	// 先清预算记录，再逐条验"同源冷却 / 全局预算 / 记账与容错"。
	rmSync(budgetFile(dir), { force: true });

	// ⑪ 同源冷却：同一个 sourceSession 在冷却期内第二次请求必须被 429 拒掉，且**不建会话**
	const gateCtx1 = fakeContext({});
	let gateCreated1 = 0;
	gateCtx1.agents.create = async () => {
		gateCreated1 += 1;
		return { agent: { session: { id: 'session-fake' }, followup: () => {} }, dispose: async () => {} };
	};
	const c1Res = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-a2', handoff: '交接包第一次' } }), c1Res);
	const res1 = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-a2', handoff: '交接包第二次' } }), res1);
	const body1 = res1.json();
	check(
		'⑪ 同源冷却：同一会话 30 分钟内第二次交接被 429 拒（且没再建会话）',
		c1Res.statusCode === 200 && res1.statusCode === 429 && body1?.reason === 'source-cooldown' && gateCreated1 === 1,
		`第一次 HTTP ${c1Res.statusCode}｜第二次 HTTP ${res1.statusCode} reason=${String(body1?.reason)}｜共建会话=${gateCreated1}`,
	);

	// ⑫ 全局预算：一小时 3 次，第 4 次（换新来源会话）必须被 429 拒
	rmSync(budgetFile(dir), { force: true });
	const gateCtx2 = fakeContext({});
	let gateCreated2 = 0;
	gateCtx2.agents.create = async () => {
		gateCreated2 += 1;
		return { agent: { session: { id: 'session-fake' }, followup: () => {} }, dispose: async () => {} };
	};
	const budgetCodes = [];
	for (const tag of ['b1', 'b2', 'b3', 'b4']) {
		const r = fakeResponse();
		await makeSwitchHandler(gateCtx2, log)(fakeRequest({ method: 'POST', body: { sourceSession: `session-${tag}`, handoff: `交接包-${tag}` } }), r);
		budgetCodes.push(r.statusCode);
	}
	check(
		'⑫ 全局预算：一小时内建到上限后第 4 次被 429 拒（换新会话也挡）',
		budgetCodes.slice(0, 3).every((c) => c === 200) && budgetCodes[3] === 429 && gateCreated2 === BUDGET_MAX_PER_WINDOW,
		`四次状态码=${budgetCodes.join(',')} 预设上限=${BUDGET_MAX_PER_WINDOW} 实际建会话=${gateCreated2}`,
	);

	// ⑬ 记账：预算文件是合法 JSON、条数对得上；且**坏文件/陈旧记录不会把插件搞死**
	let budgetOk = false;
	let budgetDetail = '';
	try {
		const saved = readBudget(dir);
		budgetOk = saved.records.length === BUDGET_MAX_PER_WINDOW;
		budgetDetail = `记录数=${saved.records.length}`;
	} catch (error) {
		budgetDetail = `读预算抛了：${errorMessage(error)}`;
	}
	check('⑬ 记账：成功的交接都记进了 handoff-budget.json（条数=上限）', budgetOk, budgetDetail);

	// ⑬b 坏 JSON + 全是过期记录 → 当成"没有记录"，照常放行（绝不能让刹车反过来卡死正常交接）
	writeFileSync(budgetFile(dir), '{ 这不是 JSON', 'utf8');
	const brokenRes = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-c1', handoff: '坏文件之后' } }), brokenRes);
	writeFileSync(budgetFile(dir), JSON.stringify({ records: [{ at: Date.now() - 10 * 24 * 60 * 60 * 1000, sourceSession: 'session-old', seq: 1, handoffChars: 1 }] }), 'utf8');
	const staleRes = fakeResponse();
	await makeSwitchHandler(gateCtx1, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-c2', handoff: '陈旧记录之后' } }), staleRes);
	check(
		'⑬b 坏 JSON / 陈旧记录都当"没有记录"：照常放行（刹车不会反过来卡死）',
		brokenRes.statusCode === 200 && staleRes.statusCode === 200,
		`坏 JSON 后 HTTP ${brokenRes.statusCode}｜陈旧后 HTTP ${staleRes.statusCode}`,
	);
	rmSync(budgetFile(dir), { force: true });

	// ⑭ 并发雪崩（事故的复现形状）：8 个请求**同时**打进来（每个来源会话都不同，
	// 所以同源冷却挡不住它们），只许建到全局上限为止 —— 这一条就是"不再雪崩"的验收。
	rmSync(budgetFile(dir), { force: true });
	const gateCtx3 = fakeContext({});
	let concurrentCreated = 0;
	gateCtx3.agents.create = async () => {
		concurrentCreated += 1;
		// 故意 yield 一次：有竞态时这里就是两个请求都能读到"没到上限"的窗口。
		await new Promise((r) => setTimeout(r, 5));
		return { agent: { session: { id: 'session-fake' }, followup: () => {} }, dispose: async () => {} };
	};
	const concurrentRes = Array.from({ length: 8 }, () => fakeResponse());
	await Promise.all(concurrentRes.map((res, i) => makeSwitchHandler(gateCtx3, log)(fakeRequest({ method: 'POST', body: { sourceSession: `session-burst-${i}`, handoff: `雪崩测试-${i}` } }), res)));
	const codes = concurrentRes.map((r) => r.statusCode);
	const okCount = codes.filter((c) => c === 200).length;
	check(
		'⑭ 并发雪崩：8 个不同来源同时请求，只建到上限（其余 429），不会像 14:4x 那样刷满',
		okCount === BUDGET_MAX_PER_WINDOW && concurrentCreated === BUDGET_MAX_PER_WINDOW && codes.filter((c) => c === 429).length === 8 - BUDGET_MAX_PER_WINDOW,
		`状态码=${codes.join(',')}｜建会话=${concurrentCreated}（上限 ${BUDGET_MAX_PER_WINDOW}）`,
	);

	// ⑩ 方法不对给 405（而不是把 GET 当 POST 处理）
	const methodRes = fakeResponse();
	await makeSwitchHandler(ctx, log)(fakeRequest({ method: 'GET' }), methodRes);
	check('⑩ 方法不对给 405', methodRes.statusCode === 405 && methodRes.headers.allow === 'POST', `HTTP ${methodRes.statusCode} allow=${String(methodRes.headers.allow)}`);

	// ⑮ 起名（使用者 2026-09-27 的要求）：新会话沿用**原会话的名字**；没带名字才回退「会话交接」。
	// 先清预算记录（⑪～⑭ 已经用掉几个名额），两次请求来自不同来源会话、不受同源冷却影响。
	rmSync(budgetFile(dir), { force: true });
	const titleCtx = fakeContext({});
	const titleRes1 = fakeResponse();
	await makeSwitchHandler(titleCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-t1', handoff: '交接包', sourceTitle: '夜间排查' } }), titleRes1);
	const titleRes2 = fakeResponse();
	await makeSwitchHandler(titleCtx, log)(fakeRequest({ method: 'POST', body: { sourceSession: 'session-t2', handoff: '交接包' } }), titleRes2);
	const renamedTitles = titleCtx.sessionTitle.renamed.map((r) => r.title);
	check(
		'⑮ 新会话沿用原会话的名字（没带名字才回退「会话交接」）',
		titleRes1.statusCode === 200 && titleRes2.statusCode === 200 && renamedTitles[0] === '夜间排查' && renamedTitles[1] === '会话交接',
		`第一次=${String(renamedTitles[0])}｜第二次=${String(renamedTitles[1])}｜HTTP ${titleRes1.statusCode},${titleRes2.statusCode}`,
	);
	rmSync(budgetFile(dir), { force: true });

	const failed = results.filter((r) => !r.pass);
	console.log(`\n${failed.length === 0 ? '全部通过' : `失败 ${failed.length} 项`}：${results.length - failed.length}/${results.length}`);
	console.log(`状态目录：${dir}`);
	return failed.length === 0 ? 0 : 1;
}

if (process.argv.includes('--selftest')) {
	// 只有"被直接 node 执行"才跑自检；被 import 时（真实加载）什么都不做。
	const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
	if (invokedDirectly) process.exitCode = await runSelfTest();
}
