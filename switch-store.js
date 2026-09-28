// switch-store.js —— 从 index.js 拆出（2026-09-27 收工自检判 index.js 超 800 行，按职责拆块）。
// 纯搬移：函数体一行没改，只补了 import / export。

import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export let llmModule;
export async function loadCreateUserMessage() {
	if (llmModule === undefined) {
		// 拆成两段拼接：避免打包器把这里当成静态依赖去解析。
		const specifier = '@deepseek-ai/dsh' + '-llm';
		llmModule = await import(specifier);
	}
	if (typeof llmModule.createUserMessage !== 'function') {
		throw new Error('@deepseek-ai/dsh-llm 里没有 createUserMessage，本机版本可能已改接口');
	}
	return llmModule.createUserMessage;
}

/** 待接文件的字段顺序，写盘时按这个顺序排，便于人肉 diff。 */
export const PENDING_FIELDS = ['at', 'mode', 'seq', 'sourceSession', 'newSessionId', 'handoff', 'handoffChars', 'note'];
/** 超过这个岁数的待接不追（只记日志）：界面早就换了，追回去反而把用户从当前会话踢走。 */
export const MAX_PENDING_AGE_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 状态目录与文件
// ---------------------------------------------------------------------------

/** 状态目录：环境变量优先，默认 `~/.dsh/session-switch`。 */
export function pendingDir() {
	const override = process.env.DSH_SESSION_SWITCH_DIR;
	if (typeof override === 'string' && override.trim() !== '') return override.trim();
	return join(homedir(), '.dsh', 'session-switch');
}

/** 待接文件路径；`dir` 只是为了 selftest 能显式指定，正常运行不必传。 */
export function pendingFile(dir) {
	return join(dir === undefined || dir === null ? pendingDir() : dir, 'pending.json');
}

/** 文件日志路径。原版特意加的：跨插件调用到底通没通，只看 Console 看不出来。 */
export function logPath(dir) {
	return join(dir === undefined || dir === null ? pendingDir() : dir, 'session-switch.log');
}

/**
 * 追加一行文件日志。
 * @returns {boolean} 是否落盘；日志失败**绝不抛**（日志只是诊断，不能反过来搞坏路由）。
 */
export function appendLog(line, dir) {
	try {
		mkdirSync(dir === undefined || dir === null ? pendingDir() : dir, { recursive: true });
		appendFileSync(logPath(dir), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
		return true;
	} catch {
		return false;
	}
}

/** 造一个绑定了状态目录与 logger 的记日志函数，路由/会话代码都通过它写日志。 */
export function makeLogger(ctx, dir) {
	return (line) => {
		const line2 = `session-switch: ${line}`;
		appendLog(line2, dir);
		try {
			ctx.logger.info(line2);
		} catch {
			/* logger 不该抛；真抛了也不值得把请求搞挂 */
		}
	};
}

/** 写临时文件再 rename：半截文件永远不会以 pending.json 的名字被别人读到。 */
export function writeFileAtomic(file, text) {
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, text, 'utf8');
	try {
		renameSync(tmp, file);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* 清理失败就留给系统临时目录 */
		}
		throw error;
	}
}

/** 按固定字段顺序构造 pending 对象；`handoffChars` 由 handoff 长度算出来，不信任调用方。 */
export function buildPending({ at, mode, seq, sourceSession, newSessionId, handoff, note }) {
	const text = typeof handoff === 'string' ? handoff : '';
	const out = {
		at: at ?? new Date().toISOString(),
		mode: mode ?? 'manual',
		seq: Number.isSafeInteger(seq) ? seq : null,
		sourceSession: sourceSession ?? null,
		newSessionId: newSessionId ?? null,
		handoff: text,
		handoffChars: text.length,
		note: note ?? '',
	};
	return Object.fromEntries(PENDING_FIELDS.map((key) => [key, out[key]]));
}

// ---------------------------------------------------------------------------
// 刹车（2026-09-27 交接连锁事故后加的，别再删）
//
// 事故经过：14:40-14:54 之间本插件被同一批会话反复请求，建了 上百个会话、
// 烧掉大量输入 token。旧版本没有任何全局上限，每次请求都老老实实建一个会话 ——
// **"判定方一个会话交一次"挡不住"很多个会话同时判到"。**
//
// 所以这里加三道闸，全部**先算、拒了绝不产生副作用**：
//   ① 全局预算：每 `windowMs` 最多建 `maxPerWindow` 个（默认 1 小时 3 个）；
//   ② 同源冷却：同一个 sourceSession 默认 30 分钟内只许交接一次；
//   ③ 盘上留痕：每次成功的交接写一行 `handoff-budget.json`（清 record.json 时可一起看）。
// 记录文件**只写本插件自己的状态目录**（`DSH_SESSION_SWITCH_DIR` 可覆盖），
// 与用户的记忆档案无关。
// ---------------------------------------------------------------------------

/** 全局预算：一小时内最多建几个交接会话。 */
export const BUDGET_WINDOW_MS = 60 * 60 * 1000;
export const BUDGET_MAX_PER_WINDOW = 3;
/** 同一个来源会话的冷却：这段时间内重复请求一律拒（防"同一会话反复交接"）。 */
export const SOURCE_COOLDOWN_MS = 30 * 60 * 1000;
/** 记录文件里最多留多少条（只用于人看，清理靠时间窗）。 */
export const BUDGET_MAX_RECORDS = 200;

/** 预算文件名（与 pending.json 同一个状态目录）。 */
export function budgetFile(dir) {
	return join(dir === undefined || dir === null ? pendingDir() : dir, 'handoff-budget.json');
}

/** 读预算记录：文件不存在/坏/空都当"没有记录"，绝不抛。 */
export function readBudget(dir) {
	try {
		const raw = readFileSync(budgetFile(dir), 'utf8');
		if (raw.trim() === '') return { records: [] };
		const parsed = JSON.parse(raw);
		const records = Array.isArray(parsed?.records) ? parsed.records : [];
		return { records: records.filter((r) => r !== null && typeof r === 'object' && Number.isFinite(r.at)) };
	} catch {
		return { records: [] };
	}
}

/** 写预算记录：先临时文件再 rename（与 pending 同一套，半截文件不会被读到）。 */
export function writeBudget(state, dir) {
	const records = state.records.slice(-BUDGET_MAX_RECORDS);
	writeFileAtomic(budgetFile(dir), `${JSON.stringify({ records }, null, 2)}\n`);
}

/** 记录一次成功的交接（**只在真的建出会话之后**调用）。 */
export function noteHandoff(input, dir, log) {
	try {
		const state = readBudget(dir);
		state.records.push({
			at: Date.now(),
			sourceSession: typeof input?.sourceSession === 'string' ? input.sourceSession : '',
			seq: Number.isSafeInteger(input?.seq) ? input.seq : null,
			handoffChars: typeof input?.handoff === 'string' ? input.handoff.length : 0,
		});
		writeBudget(state, dir);
		return true;
	} catch (error) {
		// 记账失败**不拦本次交接**（会话已经建好了，回滚代价更大），但要留证据。
		log(`预算记账失败（本次交接照常放行）：${errorMessage(error)}`);
		return false;
	}
}

/**
 * 三道闸的判定：**只读，不改任何状态**（放行时才由 `noteHandoff` 记账）。
 * @returns {{ allow: true, window: number, sourceCooldown: number } | { allow: false, status: number, error: string, reason: string }}
 */
export function checkHandoffGate(input, log) {
	const now = Date.now();
	const { records } = readBudget(undefined);
	const fresh = records.filter((r) => now - r.at < Math.max(BUDGET_WINDOW_MS, SOURCE_COOLDOWN_MS));
	const source = typeof input.sourceSession === 'string' ? input.sourceSession : '';

	// ② 同源冷却：**这一条不消耗预算**（它是一次重复请求，不是一次新交接）。
	if (source !== '') {
		const last = [...fresh].reverse().find((r) => r.sourceSession === source);
		if (last && now - last.at < SOURCE_COOLDOWN_MS) {
			const waitMin = Math.ceil((SOURCE_COOLDOWN_MS - (now - last.at)) / 60_000);
			return {
				allow: false,
				status: 429,
				error: `同一会话 ${source.slice(0, 24)} 刚交接不到 ${Math.round(SOURCE_COOLDOWN_MS / 60_000)} 分钟（再等 ${waitMin} 分钟）`,
				reason: 'source-cooldown',
			};
		}
	}

	// ① 全局预算：整个宿主在窗口内建了几个。
	const inWindow = fresh.filter((r) => now - r.at < BUDGET_WINDOW_MS);
	if (inWindow.length >= BUDGET_MAX_PER_WINDOW) {
		const oldest = inWindow[0].at;
		const waitMin = Math.ceil((BUDGET_WINDOW_MS - (now - oldest)) / 60_000);
		return {
			allow: false,
			status: 429,
			error: `本小时交接预算已用完（${inWindow.length}/${BUDGET_MAX_PER_WINDOW}），最早一次在 ${waitMin} 分钟后出窗`,
			reason: 'budget',
		};
	}
	log(`交接闸放行：本窗口已用 ${inWindow.length}/${BUDGET_MAX_PER_WINDOW}，同源冷却 ${Math.round(SOURCE_COOLDOWN_MS / 60_000)} 分钟`);
	return { allow: true, window: inWindow.length, sourceCooldown: SOURCE_COOLDOWN_MS };
}

// ---------------------------------------------------------------------------
// 读待接：不存在 / 空 / 坏 JSON 都算"空"，并记一行日志（坏 JSON 要留证据）
// ---------------------------------------------------------------------------

/**
 * 读磁盘上的待接。
 * @returns {{ pending: object|null, stale: boolean }}
 *   `stale` 表示文件本身有效但已经超过 2 小时——调用方只字不提地把内容丢掉，
 *   但会记日志，避免"待接凭空消失"这种查不出来的怪事。
 */
export function readPending(dir, log) {
	const file = pendingFile(dir);
	const dropped = (why) => {
		log(`pending 丢弃（${why}）：${file}`);
		return { pending: null, stale: false, acked: false };
	};

	let raw;
	try {
		raw = readFileSync(file, 'utf8');
	} catch (error) {
		// 不存在是**正常状态**（绝大多数时候没有待接），不是错误：不记日志、不抛。
		if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { pending: null, stale: false, acked: false };
		return dropped(`读不动 ${errorCode(error)}`);
	}
	if (raw.trim() === '') return dropped('文件是空的');

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// 坏 JSON 当空处理并留一行证据；原版这里如果 throw，整个 pending 路由就 500 了。
		return dropped('JSON 解析失败');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return dropped('顶层不是对象');

	// handled 的那条**留在盘上**（它的 `at` 就是去重凭据），但不算"待接"。
	// 只在 ack 里把它单独讲清楚，避免"重复 ack"和"从没待接"被混成同一种回答。
	if (parsed.handled === true) return { pending: null, stale: false, acked: true };

	const at = parseAt(parsed.at);
	if (at !== null && Date.now() - at > MAX_PENDING_AGE_MS) {
		log(`pending 超过 2 小时，跳过（at=${String(parsed.at)}，age=${Math.round((Date.now() - at) / 60000)} 分钟）`);
		return { pending: null, stale: true, acked: false };
	}
	if (at === null && parsed.at !== undefined && parsed.at !== null) log(`pending 的 at 不是时间（${String(parsed.at)}），按"不过期"处理`);
	return { pending: parsed, stale: false, acked: false };
}

/** 记待接。`log` 可省略（selftest 之外的调用点都会传）。 */
export function writePending(pending, dir, log) {
	const file = pendingFile(dir);
	mkdirSync(dir === undefined || dir === null ? pendingDir() : dir, { recursive: true });
	writeFileAtomic(file, `${JSON.stringify(pending, null, 2)}\n`);
	if (typeof log === 'function') log(`已写待接：newSessionId=${String(pending.newSessionId)} sourceSession=${String(pending.sourceSession)} ${pending.handoffChars} 字`);
	return pending;
}

/** 错误对象的 code，取不到就退化成名字。 */
export function errorCode(error) {
	if (error !== null && typeof error === 'object' && typeof error.code === 'string') return error.code;
	return error instanceof Error ? error.name : String(error);
}

export function errorMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

/** ISO 时间戳 → 毫秒；认不出来返回 null（而不是 NaN 悄悄让比较恒为 false）。 */
export function parseAt(value) {
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}
