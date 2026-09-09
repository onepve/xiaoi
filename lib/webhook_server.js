#!/usr/bin/env node
/**
 * 小爱音箱 Webhook 服务（可常驻）
 *
 * 设计目标:
 * - 可被 pm2 常驻运行，不需要挂着终端
 * - 优先读取 ~/.xiaoi/config.json，其次读取项目根目录 config.json
 * - 引擎未就绪时返回 503，而不是直接退出（避免 pm2 无限重启）
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const speaker = require("./speaker");
const {
    ensureUserConfigExists,
    getUserConfigPath,
    normalizeSpeakerConfigForMultiTarget,
} = require("./config");

function getHomeDir() {
    return process.env.USERPROFILE || process.env.HOME || "";
}

function getDefaultConfigPath() {
    const homeDir = getHomeDir();
    if (homeDir) {
        return path.join(homeDir, ".xiaoi", "config.json");
    }
    return path.join(__dirname, "..", "config.json");
}

function resolveConfigPath() {
    const homeDir = getHomeDir();
    const homeConfig = homeDir
        ? path.join(homeDir, ".xiaoi", "config.json")
        : null;
    const localConfig = path.join(__dirname, "..", "config.json");

    if (homeConfig && fs.existsSync(homeConfig)) return homeConfig;
    if (fs.existsSync(localConfig)) return localConfig;

    // 都不存在时，返回默认推荐位置（用于错误提示）
    return homeConfig || localConfig;
}

function loadConfigSafe() {
    // 确保用户目录下至少有一个空配置文件，便于首次部署/常驻时直接编辑
    ensureUserConfigExists();

    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
        const err = new Error(
            `找不到配置文件，请先在 TUI 中配置账号，或创建:\n  - ${configPath}`
        );
        err.code = "CONFIG_NOT_FOUND";
        throw err;
    }

    const raw = fs.readFileSync(configPath, "utf-8");
    const config = normalizeSpeakerConfigForMultiTarget(JSON.parse(raw));
    return { config, configPath };
}

function resolveLogFile(config, configPath) {
    const homeDir = getHomeDir();
    const fallback = homeDir
        ? path.join(homeDir, ".xiaoi", "webhook.log")
        : path.join(process.cwd(), "webhook.log");

    const val =
        config && config.webhook && typeof config.webhook.logFile === "string"
            ? config.webhook.logFile.trim()
            : "";
    if (!val) return fallback;

    if (path.isAbsolute(val)) return val;
    return path.join(path.dirname(configPath || getDefaultConfigPath()), val);
}

function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    if (!dir) return;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getBeijingTime() {
    return new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

function mask(str, showLast = 4) {
    if (!str) return "";
    const s = String(str);
    if (s.length <= showLast) return "****";
    return "****" + s.slice(-showLast);
}

function createLogger(logFile) {
    ensureDir(logFile);
    return function log(msg) {
        const line = `[${getBeijingTime()}] ${msg}\n`;
        console.log(line.trim());
        try {
            if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) {
                fs.renameSync(logFile, logFile + ".bak");
            }
            fs.appendFileSync(logFile, line, "utf-8");
        } catch {
            // 忽略写日志失败，避免服务崩溃
        }
    };
}

function generateToken() {
    // 32 bytes => 64 hex chars
    return crypto.randomBytes(32).toString("hex");
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error("JSON 解析失败"));
            }
        });
        req.on("error", reject);
    });
}

function sendJSON(res, statusCode, data) {
    res.writeHead(statusCode, {
        "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(data, null, 2));
}

function checkAuth(req, token) {
    if (!token) return true;

    const auth = req.headers["authorization"] || "";
    if (typeof auth === "string" && auth.startsWith("Bearer ")) {
        const t = auth.slice("Bearer ".length).trim();
        if (t && t === token) return true;
    }

    const xToken = req.headers["x-xiaoi-token"];
    if (typeof xToken === "string" && xToken.trim() === token) return true;

    return false;
}

function normalizeDid(value) {
    return typeof value === "string" ? value.trim() : "";
}

function buildSpeakerMap(speakerConfig) {
    const map = new Map();
    if (!speakerConfig || typeof speakerConfig !== "object") return map;

    const list = Array.isArray(speakerConfig.speakers) ? speakerConfig.speakers : [];
    for (const item of list) {
        if (!item || typeof item !== "object") continue;
        const did = normalizeDid(item.did);
        if (!did) continue;
        map.set(did, {
            did,
            name: typeof item.name === "string" ? item.name.trim() : "",
            model: typeof item.model === "string" ? item.model.trim() : "",
            enabled: item.enabled !== false,
        });
    }

    const legacyDid = normalizeDid(speakerConfig.did);
    if (legacyDid && !map.has(legacyDid)) {
        map.set(legacyDid, {
            did: legacyDid,
            name: legacyDid,
            model: "",
            enabled: true,
        });
    }

    const defaultDid = normalizeDid(speakerConfig.defaultDid);
    if (defaultDid && !map.has(defaultDid)) {
        map.set(defaultDid, {
            did: defaultDid,
            name: defaultDid,
            model: "",
            enabled: true,
        });
    }

    return map;
}

function resolveTargetDid(body, config) {
    const speakerConf = config && config.speaker ? config.speaker : {};
    const envDefaultDid = normalizeDid(process.env.XIAOI_DEFAULT_DID);
    const speakerMap = buildSpeakerMap(speakerConf);
    const requestedDid = normalizeDid(body && body.did);
    if (envDefaultDid && !speakerMap.has(envDefaultDid)) {
        speakerMap.set(envDefaultDid, {
            did: envDefaultDid,
            name: envDefaultDid,
            model: "",
            enabled: true,
        });
    }

    const pickEnabled = (did, source, strict) => {
        const normalizedDid = normalizeDid(did);
        if (!normalizedDid) return null;
        const item = speakerMap.get(normalizedDid);
        if (item && item.enabled) {
            return { did: normalizedDid, source };
        }
        if (strict) {
            const err = new Error(`did 不存在或未启用: ${normalizedDid}`);
            err.statusCode = 400;
            throw err;
        }
        return null;
    };

    if (requestedDid) {
        return pickEnabled(requestedDid, "request", true);
    }

    return (
        pickEnabled(speakerConf.defaultDid, "defaultDid", false) ||
        pickEnabled(envDefaultDid, "env", false) ||
        pickEnabled(speakerConf.did, "legacyDid", false) ||
        (() => {
            const err = new Error("未找到可用默认音箱，请先在音箱列表中添加并启用设备");
            err.statusCode = 500;
            throw err;
        })()
    );
}

async function startServer() {
    let config = null;
    let configPath = null;
    let log = createLogger(path.join(getHomeDir() || process.cwd(), ".xiaoi", "webhook.log"));

    let engineReady = false;
    let lastInitError = null;
    let webhookToken = "";

    function ensureWebhookToken(c, p) {
        if (!c.webhook) c.webhook = {};
        const existing = typeof c.webhook.token === "string" ? c.webhook.token.trim() : "";
        if (existing) return existing;

        const t = generateToken();
        c.webhook.token = t;

        try {
            ensureDir(p);
            fs.writeFileSync(p, JSON.stringify(c, null, 4), "utf-8");
            // 不把完整 token 写入日志文件（避免意外泄露）；控制台提示一次即可
            console.log(`🔐 已自动生成 webhook.token（已写入配置文件）: ${t}`);
            log(`🔐 已自动生成 webhook.token: ${mask(t, 8)}`);
        } catch (e) {
            console.log(`🔐 已自动生成 webhook.token（未能写入配置文件，将仅本次进程生效）: ${t}`);
            log(`🔐 已自动生成 webhook.token（未写入配置文件）: ${mask(t, 8)}`);
        }

        return t;
    }

    function reloadConfig() {
        // 如果用户目录配置存在，优先使用它（与 README 约定一致）
        const userCfg = getUserConfigPath();
        if (userCfg && fs.existsSync(userCfg)) {
            try {
                const raw = fs.readFileSync(userCfg, "utf-8");
                config = normalizeSpeakerConfigForMultiTarget(JSON.parse(raw));
                configPath = userCfg;

                const logFile = resolveLogFile(config, configPath);
                log = createLogger(logFile);
                webhookToken = ensureWebhookToken(config, configPath);
                return { config, configPath, logFile };
            } catch {
                // 解析失败则继续走原逻辑（按优先级探测）
            }
        }

        const r = loadConfigSafe();
        config = normalizeSpeakerConfigForMultiTarget(r.config);
        configPath = r.configPath;

        const logFile = resolveLogFile(config, configPath);
        log = createLogger(logFile);
        webhookToken = ensureWebhookToken(config, configPath);
        return { config, configPath, logFile };
    }

    async function initSpeakerOnce() {
        try {
            const r = reloadConfig();

            const speakerConf = config && config.speaker ? config.speaker : null;
            if (!speakerConf || !speakerConf.userId) {
                throw new Error("speaker 配置不完整（需要至少 userId）");
            }

            const target = resolveTargetDid({}, config);
            const initConfig = { ...speakerConf, did: target.did };
            await speaker.init(initConfig);
            engineReady = true;
            lastInitError = null;
            log(
                `🤖 引擎已就绪，设备=${target.did}(${target.source})，用户=${mask(speakerConf.userId)}，配置=${configPath}`
            );
            return true;
        } catch (e) {
            engineReady = false;
            lastInitError = e && e.message ? e.message : String(e);
            log(`⚠️ 引擎初始化失败: ${lastInitError}`);
            return false;
        }
    }

    // 启动后立即尝试初始化，失败则定时重试（避免 pm2 无限重启）
    initSpeakerOnce();
    setInterval(() => {
        if (!engineReady) initSpeakerOnce();
    }, 30000);

    const server = http.createServer(async (req, res) => {
        // CORS 支持
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Xiaoi-Token");

        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }

        const url = new URL(req.url, "http://localhost");

        if (req.method === "GET" && url.pathname === "/") {
            const speakerConf = config && config.speaker ? config.speaker : {};
            const did = speakerConf.did;
            const defaultDid = speakerConf.defaultDid;
            const envDefaultDid = normalizeDid(process.env.XIAOI_DEFAULT_DID);
            const speakers = buildSpeakerMap(speakerConf);
            const userId = config && config.speaker ? config.speaker.userId : "";
            const webhook = config && config.webhook ? config.webhook : {};

            return sendJSON(res, 200, {
                status: "running",
                engine_ready: engineReady,
                last_error: lastInitError,
                time: getBeijingTime(),
                config: {
                    path: configPath,
                    speaker: {
                        userId: userId ? mask(userId) : "",
                        did: did || "",
                        defaultDid: defaultDid || "",
                        envDefaultDid,
                        totalSpeakers: speakers.size,
                    },
                    webhook: {
                        port: webhook.port,
                        host: webhook.host,
                        logFile: webhook.logFile,
                        token_set: !!webhookToken,
                        token_hint: webhookToken ? mask(webhookToken, 8) : "",
                    },
                },
                endpoints: {
                    "POST /webhook/tts": "body: { text: '要说的话', did?: '目标音箱did' }",
                    "POST /webhook/audio": "body: { url: 'https://example.com/audio.mp3', did?: '目标音箱did' }",
                    "POST /webhook/volume": "body: { volume: 50, did?: '目标音箱did' } (0-100，不传 volume 或传 action:'get' 则获取音量)",
                    "GET /webhook/volume": "query: ?did=目标音箱did (获取当前音箱音量)",
                    "POST /webhook/volume/get": "body: { did?: '目标音箱did' } (获取当前音箱音量)",
                    "POST /webhook/command": "body: { siid: 3, aiid: 1, params: [], did?: '目标音箱did' }",
                },
            });
        }

        // 支持 GET /webhook/volume 查询音量
        if (req.method === "GET" && url.pathname === "/webhook/volume") {
            if (!checkAuth(req, webhookToken)) {
                return sendJSON(res, 401, { error: "未授权（需要 webhook.token）" });
            }
            if (!engineReady) {
                return sendJSON(res, 503, {
                    error: "引擎尚未就绪，请稍后重试",
                    last_error: lastInitError,
                });
            }
            try {
                const targetDid = url.searchParams.get("did") || "";
                const target = resolveTargetDid({ did: targetDid }, config);
                log(`[Target] did=${target.did}, source=${target.source}`);
                log(`[GetVolume] 正在读取当前音量`);
                const volume = await speaker.getVolume({ did: target.did });
                log(`[GetVolume] 当前音量: ${volume}`);
                return sendJSON(res, 200, {
                    success: true,
                    action: "get_volume",
                    targetDid: target.did,
                    targetSource: target.source,
                    volume,
                });
            } catch (e) {
                const msg = e && e.message ? e.message : String(e);
                log(`[Error] GET /webhook/volume - ${msg}`);
                return sendJSON(res, 500, { error: msg });
            }
        }

        // 仅支持 POST
        if (req.method !== "POST") {
            return sendJSON(res, 405, { error: "仅支持 GET/POST 请求" });
        }

        // 鉴权（可选）
        if (!checkAuth(req, webhookToken)) {
            return sendJSON(res, 401, { error: "未授权（需要 webhook.token）" });
        }

        if (!engineReady) {
            return sendJSON(res, 503, {
                error: "引擎尚未就绪，请稍后重试",
                last_error: lastInitError,
            });
        }

        let body;
        try {
            body = await parseBody(req);
        } catch (e) {
            return sendJSON(res, 400, { error: e.message });
        }

        try {
            switch (url.pathname) {
                case "/webhook/tts": {
                    const text = body && body.text ? String(body.text) : "";
                    if (!text) return sendJSON(res, 400, { error: "缺少 text 字段" });
                    const target = resolveTargetDid(body, config);
                    log(`[Target] did=${target.did}, source=${target.source}`);
                    log(`[TTS] ${text}`);
                    const result = await speaker.tts(text, { did: target.did });
                    return sendJSON(res, 200, {
                        success: true,
                        action: "tts",
                        targetDid: target.did,
                        targetSource: target.source,
                        text,
                        result,
                    });
                }

                case "/webhook/audio": {
                    const audioUrl = body && body.url ? String(body.url) : "";
                    if (!audioUrl) return sendJSON(res, 400, { error: "缺少 url 字段" });
                    const target = resolveTargetDid(body, config);
                    log(`[Target] did=${target.did}, source=${target.source}`);
                    log(`[Audio] ${audioUrl}`);
                    const result = await speaker.playAudio(audioUrl, { did: target.did });
                    return sendJSON(res, 200, {
                        success: true,
                        action: "audio",
                        targetDid: target.did,
                        targetSource: target.source,
                        url: audioUrl,
                        result,
                    });
                }

                case "/webhook/volume":
                case "/webhook/volume/get":
                case "/webhook/get-volume": {
                    const target = resolveTargetDid(body, config);
                    // 支持无参数、action='get' 或特定路由直接获取音量
                    if (
                        url.pathname === "/webhook/volume/get" ||
                        url.pathname === "/webhook/get-volume" ||
                        (body && body.action === "get") ||
                        (body && body.volume === undefined)
                    ) {
                        log(`[Target] did=${target.did}, source=${target.source}`);
                        log(`[GetVolume] 正在读取当前音量`);
                        const volume = await speaker.getVolume({ did: target.did });
                        log(`[GetVolume] 当前音量: ${volume}`);
                        return sendJSON(res, 200, {
                            success: true,
                            action: "get_volume",
                            targetDid: target.did,
                            targetSource: target.source,
                            volume,
                        });
                    }

                    const volume = Number(body && body.volume);
                    if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
                        return sendJSON(res, 400, { error: "volume 字段必须为 0-100 的数字" });
                    }
                    log(`[Target] did=${target.did}, source=${target.source}`);
                    log(`[Volume] ${volume}`);
                    const result = await speaker.setVolume(Math.round(volume), {
                        did: target.did,
                    });
                    return sendJSON(res, 200, {
                        success: true,
                        action: "volume",
                        targetDid: target.did,
                        targetSource: target.source,
                        volume: Math.round(volume),
                        result,
                    });
                }

                case "/webhook/command": {
                    const siid = Number(body && body.siid);
                    const aiid = Number(body && body.aiid);
                    const params = body && Array.isArray(body.params) ? body.params : [];
                    if (!Number.isFinite(siid) || !Number.isFinite(aiid)) {
                        return sendJSON(res, 400, { error: "siid/aiid 必须为数字" });
                    }
                    const target = resolveTargetDid(body, config);
                    log(`[Target] did=${target.did}, source=${target.source}`);
                    log(`[Command] siid=${siid}, aiid=${aiid}, params=${JSON.stringify(params)}`);
                    const result = await speaker.doAction(siid, aiid, params, {
                        did: target.did,
                    });
                    return sendJSON(res, 200, {
                        success: true,
                        action: "command",
                        targetDid: target.did,
                        targetSource: target.source,
                        siid,
                        aiid,
                        params,
                        result,
                    });
                }

                default:
                    return sendJSON(res, 404, { error: `未知路径: ${url.pathname}` });
            }
        } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            log(`[Error] ${url.pathname} - ${msg}`);
            const statusCode =
                e && Number.isFinite(Number(e.statusCode))
                    ? Number(e.statusCode)
                    : 500;
            return sendJSON(res, statusCode, { error: msg });
        }
    });

    // 监听端口/host
    let port = 3088;
    let host = undefined;
    try {
        const r = config || (reloadConfig() && config);
        const webhook = r && r.webhook ? r.webhook : {};
        port = Number(webhook.port) || 3088;
        host = webhook.host ? String(webhook.host).trim() : undefined;
    } catch (e) {
        // 配置不存在也允许启动，方便用户在浏览器查看状态页
        lastInitError = e && e.message ? e.message : String(e);
    }

    const onListen = () => {
        const bind = host ? `${host}:${port}` : `${port}`;
        log("========================================");
        log(`✅ Webhook 服务已启动，监听: ${bind}`);
        log(`📡 状态页: http://localhost:${port}/`);
        log("========================================");
    };

    server.on("error", (e) => {
        const msg = e && e.message ? e.message : String(e);
        log(`❌ Webhook 启动失败: ${msg}`);
    });

    if (host) {
        server.listen(port, host, onListen);
    } else {
        server.listen(port, onListen);
    }

    function shutdown(signal) {
        log(`收到信号 ${signal}，正在退出...`);
        try {
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 2000).unref();
        } catch {
            process.exit(0);
        }
    }

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    return server;
}

module.exports = { startServer };

if (require.main === module) {
    startServer().catch((e) => {
        const msg = e && e.message ? e.message : String(e);
        // 这里不要 throw，避免 pm2 直接重启；直接挂起并打印错误
        console.error(msg);
        setInterval(() => {}, 3600000);
    });
}
