import removeMarkdown from "remove-markdown";

const TOKEN_REFRESH_BEFORE_EXPIRY = 3 * 60;
const VOICE_ALIASES = {
    alloy: "zh-CN-XiaoxiaoNeural",
    ash: "zh-CN-YunxiNeural",
    ballad: "zh-CN-XiaoyiNeural",
    coral: "zh-CN-XiaochenNeural",
    echo: "zh-CN-YunyangNeural",
    fable: "zh-CN-YunjianNeural",
    nova: "zh-CN-XiaoxuanNeural",
    onyx: "zh-CN-YunfengNeural",
    sage: "zh-CN-XiaoruiNeural",
    shimmer: "zh-CN-XiaohanNeural"
};
const VOICES = [
    "zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-XiaochenNeural",
    "zh-CN-XiaohanNeural", "zh-CN-XiaomengNeural", "zh-CN-XiaomoNeural",
    "zh-CN-XiaoqiuNeural", "zh-CN-XiaoruiNeural", "zh-CN-XiaoshuangNeural",
    "zh-CN-XiaoxuanNeural", "zh-CN-XiaoyanNeural", "zh-CN-XiaoyouNeural",
    "zh-CN-XiaozhenNeural", "zh-CN-YunxiNeural", "zh-CN-YunyangNeural",
    "zh-CN-YunjianNeural", "zh-CN-YunfengNeural", "zh-CN-YunhaoNeural",
    "zh-CN-YunxiaNeural", "zh-CN-YunyeNeural", "zh-CN-YunzeNeural"
];
const VALID_STYLES = new Set([
    "general", "assistant", "chat", "customerservice", "newscast",
    "affectionate", "calm", "cheerful", "gentle", "lyrical", "serious"
]);
const VALID_VOICES = new Set([...VOICES, ...Object.keys(VOICE_ALIASES)]);
const MAX_INPUT_LENGTH = 10_000;

const DECIMAL_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;
const INTEGER_RE = /^-?\d+$/;

function toStrictNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
    if (typeof value !== "string") return NaN;
    const s = value.trim();
    if (!DECIMAL_RE.test(s)) return NaN;
    return Number(s);
}

function toStrictInt(value) {
    if (typeof value === "number") return Number.isFinite(value) && Number.isInteger(value) ? value : NaN;
    if (typeof value !== "string") return NaN;
    const s = value.trim();
    if (!INTEGER_RE.test(s)) return NaN;
    return Number(s);
}

function validateTtsParams(input, voice, speed, pitch, volume, style) {
    if (typeof input !== "string" || !input.trim()) {
        return { status: 400, code: "invalid_input", message: "input 必须为非空字符串" };
    }
    if (input.length > MAX_INPUT_LENGTH) {
        return { status: 413, code: "input_too_long", message: `input 长度不能超过 ${MAX_INPUT_LENGTH} 字符` };
    }
    if (typeof voice !== "string" || !VALID_VOICES.has(voice)) {
        return { status: 400, code: "invalid_voice", message: `不支持的语音: ${voice}` };
    }
    const numSpeed = toStrictNumber(speed);
    if (Number.isNaN(numSpeed) || numSpeed < 0.5 || numSpeed > 2.0) {
        return { status: 400, code: "invalid_speed", message: "speed 必须在 0.5 - 2.0 之间" };
    }
    const numPitch = toStrictInt(pitch);
    if (Number.isNaN(numPitch) || numPitch < -50 || numPitch > 50) {
        return { status: 400, code: "invalid_pitch", message: "pitch 必须为整数，范围 -50 到 50" };
    }
    const numVolume = toStrictInt(volume);
    if (Number.isNaN(numVolume) || numVolume < -100 || numVolume > 100) {
        return { status: 400, code: "invalid_volume", message: "volume 必须为整数，范围 -100 到 100" };
    }
    if (typeof style !== "string" || !VALID_STYLES.has(style)) {
        return { status: 400, code: "invalid_style", message: `不支持的风格: ${style}` };
    }
    return null;
}

function errorResponse(status, code, message) {
    return new Response(JSON.stringify({
        error: { message, type: "invalid_request_error", param: null, code }
    }), {
        status,
        headers: { "Content-Type": "application/json", ...makeCORSHeaders() }
    });
}

let tokenInfo = {
    endpoint: null,
    token: null,
    expiredAt: null
};


// HTML 页面模板
const HTML_PAGE = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title data-i18n="page.title">Open TTS</title>
<meta name="description" content="" data-i18n-content="page.description">
<meta name="keywords" content="" data-i18n-content="page.keywords">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;background:#f9fafb;color:#1f2937;line-height:1.5}
.navbar{position:fixed;top:0;left:0;right:0;z-index:100;background:#fff;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;padding:0 24px;height:48px}
.navbar h1{font-size:1.15rem;font-weight:700;color:#111827;letter-spacing:-0.01em}
.navbar-right{display:flex;align-items:center;gap:12px}
.navbar-right input[type="text"]{width:200px;padding:5px 10px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;background:#f9fafb;color:#374151}
.navbar-right input[type="text"]:focus{outline:none;border-color:#3b82f6}
.lang-wrap{position:relative}
.lang-btn{display:flex;align-items:center;gap:4px;padding:5px 8px;border:1px solid #d1d5db;border-radius:4px;background:#fff;cursor:pointer;font-size:13px;color:#6b7280}
.lang-btn:hover{border-color:#9ca3af}
.lang-dd{display:none;position:absolute;top:100%;right:0;margin-top:4px;background:#fff;border:1px solid #e5e7eb;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.08);min-width:110px;overflow:hidden;z-index:200}
.lang-dd.show{display:block}
.lang-opt{display:flex;align-items:center;gap:6px;padding:7px 12px;cursor:pointer;font-size:13px;color:#4b5563}
.lang-opt:hover{background:#f3f4f6}
.lang-opt.active{background:#3b82f6;color:#fff}
.shell{max-width:960px;margin:0 auto;padding:60px 20px 40px}
.tabs{display:flex;gap:0;border-bottom:1px solid #e5e7eb;margin-bottom:0}
.tab{padding:10px 20px;font-size:14px;font-weight:500;color:#6b7280;cursor:pointer;border:none;background:none;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
.tab:hover{color:#111827}
.tab.active{color:#3b82f6;border-bottom-color:#3b82f6}
.panel{display:none;background:#fff;border:1px solid #e5e7eb;border-top:none;padding:24px}
.panel.active{display:block}
label.lbl{display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:5px}
textarea.inp{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:4px;font-size:14px;font-family:inherit;resize:vertical;min-height:100px;color:#1f2937;background:#fff}
textarea.inp:focus{outline:none;border-color:#3b82f6}
select.sel{width:100%;padding:8px 10px;border:1px solid #d1d5db;border-radius:4px;font-size:13px;color:#1f2937;background:#fff;cursor:pointer}
select.sel:focus{outline:none;border-color:#3b82f6}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 20px;border:none;border-radius:4px;font-size:14px;font-weight:500;cursor:pointer;transition:background .15s}
.btn-blue{background:#3b82f6;color:#fff;width:100%}
.btn-blue:hover:not(:disabled){background:#2563eb}
.btn-blue:disabled{opacity:.5;cursor:not-allowed}
.btn-green{background:#059669;color:#fff}
.btn-green:hover{background:#047857}
.btn-sm{padding:6px 14px;font-size:13px}
.file-toggle{display:inline-block;margin-top:6px;margin-bottom:14px;font-size:13px;color:#3b82f6;cursor:pointer;border:none;background:none;padding:0}
.file-toggle:hover{text-decoration:underline}
.drop-zone{border:2px dashed #d1d5db;border-radius:6px;padding:32px 16px;text-align:center;cursor:pointer;transition:border-color .2s;background:#fafbfc;margin-bottom:14px}
.drop-zone:hover,.drop-zone.dragover{border-color:#3b82f6;background:#eff6ff}
.drop-zone p{margin:6px 0;color:#6b7280;font-size:13px}
.drop-zone p:first-child{font-weight:500;color:#374151;font-size:14px}
.file-card{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:4px;margin-bottom:14px;font-size:13px}
.file-card .fname{font-weight:500;color:#1f2937}
.file-card .fsize{color:#9ca3af;margin-left:8px}
.file-card button{background:#ef4444;color:#fff;border:none;width:24px;height:24px;border-radius:4px;cursor:pointer;font-size:12px;line-height:1}
.result-box{margin-top:20px;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;display:none}
.spinner{width:28px;height:28px;border:3px solid #e5e7eb;border-top-color:#3b82f6;border-radius:50%;animation:spin .8s linear infinite;margin:0 auto 10px}
@keyframes spin{to{transform:rotate(360deg)}}
.progress-text{text-align:center;color:#6b7280;font-size:13px}
audio{width:100%;margin-bottom:10px}
.err-msg{color:#dc2626;background:#fef2f2;border:1px solid #fecaca;padding:10px 14px;border-radius:4px;font-size:13px}
.token-row{display:flex;gap:16px;margin-bottom:10px;font-size:13px}
.token-row label{display:flex;align-items:center;gap:5px;cursor:pointer;color:#4b5563}
.actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
.code-sec{margin-bottom:24px}
.code-sec h3{font-size:15px;font-weight:600;color:#111827;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #f3f4f6}
.code-sec p{font-size:13px;color:#6b7280;margin-bottom:8px}
.code-wrap{position:relative;background:#1e293b;border-radius:6px;overflow:hidden;margin-bottom:4px}
.code-wrap pre{margin:0;padding:16px;overflow-x:auto;font-size:12.5px;line-height:1.65}
.code-wrap code{color:#e2e8f0;font-family:'SF Mono','Fira Code',Consolas,monospace;white-space:pre}
.code-wrap .hl{color:#fbbf24}
.copy-btn{position:absolute;top:6px;right:6px;padding:3px 10px;background:rgba(255,255,255,.1);color:#94a3b8;border:1px solid rgba(255,255,255,.1);border-radius:3px;font-size:11px;cursor:pointer}
.copy-btn:hover{background:rgba(255,255,255,.2);color:#e2e8f0}
.api-tbl{width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px}
.api-tbl th{text-align:left;padding:8px 10px;background:#f9fafb;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb}
.api-tbl td{padding:8px 10px;border-bottom:1px solid #f3f4f6;color:#374151}
.api-tbl code{background:#f3f4f6;padding:1px 5px;border-radius:3px;font-size:12px;color:#3b82f6}
@media(max-width:640px){
  .navbar{padding:0 12px}
  .navbar-right input[type="text"]{width:120px}
  .shell{padding:56px 10px 24px}
  .tab{padding:8px 12px;font-size:13px}
  .panel{padding:16px}
  .grid2{grid-template-columns:1fr}
  .actions{flex-direction:column}
  .token-row{flex-direction:column;gap:8px}
}
</style>
</head>
<body>

<div class="navbar">
  <h1 data-i18n="header.title">Open TTS</h1>
  <div class="navbar-right">
    <input type="text" id="serviceApiKey" value="sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e" placeholder="API Key" autocomplete="off">
    <div class="lang-wrap">
      <div class="lang-btn" id="languageBtn">
        <span id="currentLangFlag">🌐</span>
        <span id="currentLangName" data-i18n="lang.current">English</span>
        <svg width="10" height="10" fill="currentColor" viewBox="0 0 16 16"><path d="M1.6 4.6a.5.5 0 01.8 0L8 10.3l5.6-5.7a.5.5 0 01.8.7l-6 6a.5.5 0 01-.8 0l-6-6a.5.5 0 010-.7z"/></svg>
      </div>
      <div class="lang-dd" id="languageDropdown">
        <div class="lang-opt" data-lang="en"><span>🇺🇸</span><span>English</span></div>
        <div class="lang-opt" data-lang="zh"><span>🇨🇳</span><span>中文</span></div>
        <div class="lang-opt" data-lang="ja"><span>🇯🇵</span><span>日本語</span></div>
        <div class="lang-opt" data-lang="ko"><span>🇰🇷</span><span>한국어</span></div>
        <div class="lang-opt" data-lang="es"><span>🇪🇸</span><span>Español</span></div>
        <div class="lang-opt" data-lang="fr"><span>🇫🇷</span><span>Français</span></div>
        <div class="lang-opt" data-lang="de"><span>🇩🇪</span><span>Deutsch</span></div>
        <div class="lang-opt" data-lang="ru"><span>🇷🇺</span><span>Русский</span></div>
      </div>
    </div>
  </div>
</div>

<div class="shell">
  <div class="tabs">
    <button class="tab active" data-tab="tts" data-i18n="tab.tts">文字转语音</button>
    <button class="tab" data-tab="stt" data-i18n="tab.stt">语音转文字</button>
    <button class="tab" data-tab="docs" data-i18n="tab.docs">API 文档</button>
  </div>

  <!-- TTS Panel -->
  <div class="panel active" id="panel-tts">
    <form id="ttsForm">
      <div style="margin-bottom:14px">
        <label class="lbl" for="text">输入文本</label>
        <textarea class="inp" id="text" placeholder="请输入要转换为语音的文本内容..." required></textarea>
        <button type="button" class="file-toggle" id="fileToggleBtn">或上传 txt 文件</button>
      </div>

      <div id="fileUploadArea" style="display:none">
        <div class="drop-zone" id="fileDropZone">
          <p>拖拽 txt 文件到此处，或点击选择</p>
          <p>支持 txt 格式，最大 500KB</p>
          <input type="file" id="fileInput" accept=".txt,text/plain" style="display:none">
        </div>
        <div class="file-card" id="fileInfo" style="display:none">
          <div><span class="fname" id="fileName"></span><span class="fsize" id="fileSize"></span></div>
          <button type="button" id="fileRemoveBtn">✕</button>
        </div>
      </div>

      <div class="grid2">
        <div>
          <label class="lbl" for="voice">语音选择</label>
          <select class="sel" id="voice">
            <option value="zh-CN-XiaoxiaoNeural">晓晓 (女声·温柔)</option>
            <option value="zh-CN-YunxiNeural">云希 (男声·清朗)</option>
            <option value="zh-CN-YunyangNeural">云扬 (男声·阳光)</option>
            <option value="zh-CN-XiaoyiNeural">晓伊 (女声·甜美)</option>
            <option value="zh-CN-YunjianNeural">云健 (男声·稳重)</option>
            <option value="zh-CN-XiaochenNeural">晓辰 (女声·知性)</option>
            <option value="zh-CN-XiaohanNeural">晓涵 (女声·优雅)</option>
            <option value="zh-CN-XiaomengNeural">晓梦 (女声·梦幻)</option>
            <option value="zh-CN-XiaomoNeural">晓墨 (女声·文艺)</option>
            <option value="zh-CN-XiaoqiuNeural">晓秋 (女声·成熟)</option>
            <option value="zh-CN-XiaoruiNeural">晓睦 (女声·智慧)</option>
            <option value="zh-CN-XiaoshuangNeural">晓双 (女声·活泼)</option>
            <option value="zh-CN-XiaoxuanNeural">晓萱 (女声·清新)</option>
            <option value="zh-CN-XiaoyanNeural">晓颜 (女声·柔美)</option>
            <option value="zh-CN-XiaoyouNeural">晓悠 (女声·悠扬)</option>
            <option value="zh-CN-XiaozhenNeural">晓甄 (女声·端庄)</option>
            <option value="zh-CN-YunfengNeural">云枫 (男声·磁性)</option>
            <option value="zh-CN-YunhaoNeural">云皓 (男声·豪迈)</option>
            <option value="zh-CN-YunxiaNeural">云夏 (男声·热情)</option>
            <option value="zh-CN-YunyeNeural">云野 (男声·野性)</option>
            <option value="zh-CN-YunzeNeural">云泽 (男声·深沉)</option>
          </select>
        </div>
        <div>
          <label class="lbl" for="speed">语速</label>
          <select class="sel" id="speed">
            <option value="0.5">0.5x 很慢</option>
            <option value="0.75">0.75x 慢速</option>
            <option value="1.0" selected>1.0x 正常</option>
            <option value="1.25">1.25x 快速</option>
            <option value="1.5">1.5x 很快</option>
            <option value="2.0">2.0x 极速</option>
          </select>
        </div>
        <div>
          <label class="lbl" for="pitch">音调</label>
          <select class="sel" id="pitch">
            <option value="-50">-50 很低沉</option>
            <option value="-25">-25 低沉</option>
            <option value="0" selected>0 标准</option>
            <option value="25">+25 高亢</option>
            <option value="50">+50 很高亢</option>
          </select>
        </div>
        <div>
          <label class="lbl" for="style">风格</label>
          <select class="sel" id="style">
            <option value="general" selected>通用风格</option>
            <option value="assistant">智能助手</option>
            <option value="chat">聊天对话</option>
            <option value="customerservice">客服专业</option>
            <option value="newscast">新闻播报</option>
            <option value="affectionate">亲切温暖</option>
            <option value="calm">平静舒缓</option>
            <option value="cheerful">愉快欢乐</option>
            <option value="gentle">温和柔美</option>
            <option value="lyrical">抱情诗意</option>
            <option value="serious">严肃正式</option>
          </select>
        </div>
      </div>

      <button type="submit" class="btn btn-blue" id="generateBtn">开始生成语音</button>
    </form>

    <div id="result" class="result-box">
      <div id="loading" style="display:none">
        <div class="spinner"></div>
        <p class="progress-text" id="loadingText">正在生成语音，请稍候...</p>
        <p class="progress-text" id="progressInfo"></p>
      </div>
      <div id="success" style="display:none">
        <audio id="audioPlayer" controls></audio>
        <a id="downloadBtn" class="btn btn-green btn-sm" download="speech.mp3">下载 MP3</a>
      </div>
      <div id="error" class="err-msg" style="display:none"></div>
    </div>
  </div>

  <!-- STT Panel -->
  <div class="panel" id="panel-stt">
    <form id="transcriptionForm">
      <div style="margin-bottom:14px">
        <label class="lbl">上传音频文件</label>
        <div class="drop-zone" id="audioDropZone">
          <p>拖拽音频文件到此处，或点击选择</p>
          <p>支持 mp3、wav、m4a、flac、aac、ogg、webm、amr、3gp，最大 10MB</p>
          <input type="file" id="audioFileInput" accept=".mp3,.wav,.m4a,.flac,.aac,.ogg,.webm,.amr,.3gp,audio/*" style="display:none">
        </div>
        <div class="file-card" id="audioFileInfo" style="display:none">
          <div><span class="fname" id="audioFileName"></span><span class="fsize" id="audioFileSize"></span></div>
          <button type="button" id="audioFileRemoveBtn">✕</button>
        </div>
      </div>

      <div style="margin-bottom:14px">
        <label class="lbl">API Token 配置</label>
        <div class="token-row">
          <label><input type="radio" name="tokenOption" value="default" checked> 使用服务端 Token</label>
          <label><input type="radio" name="tokenOption" value="custom"> 自定义 Token</label>
        </div>
        <input type="text" class="inp" id="tokenInput" placeholder="输入您的 API Token" style="display:none;min-height:auto;margin-top:6px">
      </div>

      <button type="submit" class="btn btn-blue" id="transcribeBtn">开始语音转录</button>
    </form>

    <div id="transcriptionResult" class="result-box">
      <div id="transcriptionLoading" style="display:none">
        <div class="spinner"></div>
        <p class="progress-text" id="transcriptionLoadingText">正在转录音频，请稍候...</p>
        <p class="progress-text" id="transcriptionProgressInfo"></p>
      </div>
      <div id="transcriptionSuccess" style="display:none">
        <label class="lbl">转录结果</label>
        <textarea class="inp" id="transcriptionText" readonly placeholder="转录结果将在这里显示..."></textarea>
        <div class="actions">
          <button type="button" class="btn btn-green btn-sm" id="copyTranscriptionBtn">复制</button>
          <button type="button" class="btn btn-green btn-sm" id="editTranscriptionBtn">编辑</button>
          <button type="button" class="btn btn-green btn-sm" id="useForTtsBtn">转为语音</button>
        </div>
      </div>
      <div id="transcriptionError" class="err-msg" style="display:none"></div>
    </div>
  </div>

  <!-- API Docs Panel -->
  <div class="panel" id="panel-docs">

    <div class="code-sec">
      <h3>OpenAI SDK (Python)</h3>
      <p>兼容 OpenAI SDK，可直接用于大模型应用中的语音合成。</p>
      <div class="code-wrap"><button type="button" class="copy-btn" onclick="copyCode(this)">复制</button><pre><code>from openai import OpenAI

client = OpenAI(
    api_key="<span class="hl">your-api-key</span>",
    base_url="<span class="hl auto-base-url">http://127.0.0.1:8787</span>/v1",
)

response = client.audio.speech.create(
    model="tts-1",
    voice="zh-CN-XiaoxiaoNeural",  # 或别名: alloy, echo, nova ...
    input="你好，这是语音合成测试。",
    speed=1.0,
)
response.write_to_file("speech.mp3")</code></pre></div>
    </div>

    <div class="code-sec">
      <h3>OpenAI SDK (Node.js)</h3>
      <div class="code-wrap"><button type="button" class="copy-btn" onclick="copyCode(this)">复制</button><pre><code>import OpenAI from "openai";
import fs from "fs";

const client = new OpenAI({
    apiKey: "<span class="hl">your-api-key</span>",
    baseURL: "<span class="hl auto-base-url">http://127.0.0.1:8787</span>/v1",
});

const response = await client.audio.speech.create({
    model: "tts-1",
    voice: "zh-CN-YunxiNeural",
    input: "你好，这是语音合成测试。",
});

const buffer = Buffer.from(await response.arrayBuffer());
fs.writeFileSync("speech.mp3", buffer);</code></pre></div>
    </div>

    <div class="code-sec">
      <h3>cURL — 文字转语音</h3>
      <div class="code-wrap"><button type="button" class="copy-btn" onclick="copyCode(this)">复制</button><pre><code>curl <span class="hl auto-base-url">http://127.0.0.1:8787</span>/v1/audio/speech \
  -H "Authorization: Bearer <span class="hl">your-api-key</span>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "你好，这是语音合成测试。",
    "voice": "zh-CN-XiaoxiaoNeural",
    "speed": 1.0
  }' \
  --output speech.mp3</code></pre></div>
    </div>

    <div class="code-sec">
      <h3>cURL — 语音转文字</h3>
      <div class="code-wrap"><button type="button" class="copy-btn" onclick="copyCode(this)">复制</button><pre><code>curl <span class="hl auto-base-url">http://127.0.0.1:8787</span>/v1/audio/transcriptions \
  -H "Authorization: Bearer <span class="hl">your-api-key</span>" \
  -F "file=@speech.mp3"</code></pre></div>
    </div>

    <div class="code-sec">
      <h3>可用接口</h3>
      <table class="api-tbl">
        <thead><tr><th>接口</th><th>方法</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td><code>/v1/audio/speech</code></td><td>POST</td><td>文字转语音</td></tr>
          <tr><td><code>/v1/audio/transcriptions</code></td><td>POST</td><td>语音转文字</td></tr>
          <tr><td><code>/v1/audio/voices</code></td><td>GET</td><td>查询可用音色</td></tr>
          <tr><td><code>/v1/models</code></td><td>GET</td><td>查询可用模型</td></tr>
          <tr><td><code>/healthz</code></td><td>GET</td><td>健康检查（无需鉴权）</td></tr>
        </tbody>
      </table>
    </div>

    <div class="code-sec">
      <h3>全部可用语音</h3>
      <p>在 <code>voice</code> 参数中传入以下值（也可通过 <code>GET /v1/audio/voices</code> 查询）：</p>
      <table class="api-tbl">
        <thead><tr><th>voice 参数值</th><th>名称</th><th>类型</th></tr></thead>
        <tbody>
          <tr><td><code>zh-CN-XiaoxiaoNeural</code></td><td>晓晓</td><td>女声·温柔</td></tr>
          <tr><td><code>zh-CN-XiaoyiNeural</code></td><td>晓伊</td><td>女声·甜美</td></tr>
          <tr><td><code>zh-CN-XiaochenNeural</code></td><td>晓辰</td><td>女声·知性</td></tr>
          <tr><td><code>zh-CN-XiaohanNeural</code></td><td>晓涵</td><td>女声·优雅</td></tr>
          <tr><td><code>zh-CN-XiaomengNeural</code></td><td>晓梦</td><td>女声·梦幻</td></tr>
          <tr><td><code>zh-CN-XiaomoNeural</code></td><td>晓墨</td><td>女声·文艺</td></tr>
          <tr><td><code>zh-CN-XiaoqiuNeural</code></td><td>晓秋</td><td>女声·成熟</td></tr>
          <tr><td><code>zh-CN-XiaoruiNeural</code></td><td>晓睿</td><td>女声·智慧</td></tr>
          <tr><td><code>zh-CN-XiaoshuangNeural</code></td><td>晓双</td><td>女声·活泼</td></tr>
          <tr><td><code>zh-CN-XiaoxuanNeural</code></td><td>晓萱</td><td>女声·清新</td></tr>
          <tr><td><code>zh-CN-XiaoyanNeural</code></td><td>晓颜</td><td>女声·柔美</td></tr>
          <tr><td><code>zh-CN-XiaoyouNeural</code></td><td>晓悠</td><td>女声·悠扬</td></tr>
          <tr><td><code>zh-CN-XiaozhenNeural</code></td><td>晓甄</td><td>女声·端庄</td></tr>
          <tr><td><code>zh-CN-YunxiNeural</code></td><td>云希</td><td>男声·清朗</td></tr>
          <tr><td><code>zh-CN-YunyangNeural</code></td><td>云扬</td><td>男声·阳光</td></tr>
          <tr><td><code>zh-CN-YunjianNeural</code></td><td>云健</td><td>男声·稳重</td></tr>
          <tr><td><code>zh-CN-YunfengNeural</code></td><td>云枫</td><td>男声·磁性</td></tr>
          <tr><td><code>zh-CN-YunhaoNeural</code></td><td>云皓</td><td>男声·豪迈</td></tr>
          <tr><td><code>zh-CN-YunxiaNeural</code></td><td>云夏</td><td>男声·热情</td></tr>
          <tr><td><code>zh-CN-YunyeNeural</code></td><td>云野</td><td>男声·野性</td></tr>
          <tr><td><code>zh-CN-YunzeNeural</code></td><td>云泽</td><td>男声·深沉</td></tr>
        </tbody>
      </table>
    </div>

    <div class="code-sec">
      <h3>OpenAI 音色别名</h3>
      <p>支持以下 OpenAI 音色别名，自动映射到对应的中文语音：</p>
      <table class="api-tbl">
        <thead><tr><th>别名</th><th>映射语音</th></tr></thead>
        <tbody>
          <tr><td><code>alloy</code></td><td>晓晓 (XiaoxiaoNeural)</td></tr>
          <tr><td><code>ash</code></td><td>云希 (YunxiNeural)</td></tr>
          <tr><td><code>ballad</code></td><td>晓伊 (XiaoyiNeural)</td></tr>
          <tr><td><code>coral</code></td><td>晓辰 (XiaochenNeural)</td></tr>
          <tr><td><code>echo</code></td><td>云扬 (YunyangNeural)</td></tr>
          <tr><td><code>fable</code></td><td>云健 (YunjianNeural)</td></tr>
          <tr><td><code>nova</code></td><td>晓萱 (XiaoxuanNeural)</td></tr>
          <tr><td><code>onyx</code></td><td>云枫 (YunfengNeural)</td></tr>
          <tr><td><code>sage</code></td><td>晓睦 (XiaoruiNeural)</td></tr>
          <tr><td><code>shimmer</code></td><td>晓涵 (XiaohanNeural)</td></tr>
        </tbody>
      </table>
    </div>

    <div class="code-sec">
      <h3>TTS 请求参数</h3>
      <table class="api-tbl">
        <thead><tr><th>参数</th><th>类型</th><th>默认值</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td><code>input</code></td><td>string</td><td>—</td><td>要转换的文本（必填）</td></tr>
          <tr><td><code>voice</code></td><td>string</td><td>XiaoxiaoNeural</td><td>语音名称或别名</td></tr>
          <tr><td><code>speed</code></td><td>number</td><td>1.0</td><td>语速 (0.5 - 2.0)</td></tr>
          <tr><td><code>pitch</code></td><td>string</td><td>"0"</td><td>音调 (-50 到 50)</td></tr>
          <tr><td><code>volume</code></td><td>string</td><td>"0"</td><td>音量百分比 (-100 到 100)</td></tr>
          <tr><td><code>style</code></td><td>string</td><td>"general"</td><td>语音风格</td></tr>
        </tbody>
      </table>
    </div>

    <div class="code-sec">
      <h3>使用限制</h3>
      <table class="api-tbl">
        <thead><tr><th>限制项</th><th>说明</th></tr></thead>
        <tbody>
          <tr><td>每 Key TTS 并发</td><td>每个 API Key 最多同时处理 10 个 TTS 请求，超出返回 <code>429</code></td></tr>
          <tr><td>文本长度</td><td>单次请求最大 10,000 字符</td></tr>
          <tr><td>请求体大小</td><td>最大 11MB，超出返回 <code>413</code></td></tr>
          <tr><td>音频文件</td><td>语音转文字最大 10MB，支持 mp3/wav/m4a/flac/aac/ogg/webm/amr/3gp</td></tr>
          <tr><td>文本文件</td><td>txt 格式，最大 500KB</td></tr>
          <tr><td>Markdown 清洗</td><td>自动去除 Markdown 标记（标题、粗体、代码围栏、LaTeX 公式符号等），保留正文内容朗读</td></tr>
        </tbody>
      </table>
    </div>

  </div>
</div>

<script>
let selectedFile = null;
let selectedAudioFile = null;
let currentLanguage = 'en';

const translations = {
  en: {
    'page.title':'Open TTS','page.description':'Self-hosted text-to-speech and speech-to-text service with an OpenAI-compatible API','page.keywords':'text to speech,speech to text,OpenAI TTS,self-hosted',
    'lang.current':'English','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'Text to Speech','tab.stt':'Speech to Text','tab.docs':'API Docs'
  },
  zh: {
    'page.title':'Open TTS','page.description':'自托管的文字转语音和语音转文字服务','page.keywords':'文字转语音,语音转文字,OpenAI TTS',
    'lang.current':'中文','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'文字转语音','tab.stt':'语音转文字','tab.docs':'API 文档'
  },
  ja: {
    'page.title':'Open TTS','page.description':'セルフホスト型音声処理プラットフォーム','page.keywords':'テキスト読み上げ,音声テキスト変換',
    'lang.current':'日本語','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'テキスト読み上げ','tab.stt':'音声テキスト変換','tab.docs':'API ドキュメント'
  },
  ko: {
    'page.title':'Open TTS','page.description':'셀프 호스팅 음성 처리 플랫폼','page.keywords':'텍스트 음성 변환,음성 텍스트 변환',
    'lang.current':'한국어','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'텍스트 음성 변환','tab.stt':'음성 텍스트 변환','tab.docs':'API 문서'
  },
  es: {
    'page.title':'Open TTS','page.description':'Plataforma de procesamiento de voz autoalojada','page.keywords':'texto a voz,voz a texto',
    'lang.current':'Español','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'Texto a Voz','tab.stt':'Voz a Texto','tab.docs':'API Docs'
  },
  fr: {
    'page.title':'Open TTS','page.description':'Plateforme de traitement vocal auto-hébergée','page.keywords':'texte vers parole,parole vers texte',
    'lang.current':'Français','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'Texte vers Parole','tab.stt':'Parole vers Texte','tab.docs':'API Docs'
  },
  de: {
    'page.title':'Open TTS','page.description':'Selbst gehostete Sprachverarbeitungsplattform','page.keywords':'Text zu Sprache,Sprache zu Text',
    'lang.current':'Deutsch','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'Text zu Sprache','tab.stt':'Sprache zu Text','tab.docs':'API Docs'
  },
  ru: {
    'page.title':'Open TTS','page.description':'Самостоятельная платформа обработки голоса','page.keywords':'текст в речь,речь в текст',
    'lang.current':'Русский','lang.en':'English','lang.zh':'中文','lang.ja':'日本語','lang.ko':'한국어','lang.es':'Español','lang.fr':'Français','lang.de':'Deutsch','lang.ru':'Русский',
    'header.title':'Open TTS','tab.tts':'Текст в Речь','tab.stt':'Речь в Текст','tab.docs':'API'
  }
};

function detectLanguage(){var s=(navigator.language||'').split('-')[0];return translations[s]?s:'en'}
function setLanguage(l){currentLanguage=l;localStorage.setItem('open-tts-language',l);document.documentElement.lang=l==='zh'?'zh-CN':l;applyTranslations();updateLangUI()}
function applyTranslations(){var d=translations[currentLanguage]||{};document.querySelectorAll('[data-i18n]').forEach(function(e){var k=e.getAttribute('data-i18n');if(d[k])e.textContent=d[k]});document.querySelectorAll('[data-i18n-content]').forEach(function(e){var k=e.getAttribute('data-i18n-content');if(d[k])e.setAttribute('content',d[k])});if(d['page.title'])document.title=d['page.title']}
function updateLangUI(){var flags={en:'🇺🇸',zh:'🇨🇳',ja:'🇯🇵',ko:'🇰🇷',es:'🇪🇸',fr:'🇫🇷',de:'🇩🇪',ru:'🇷🇺'};var d=translations[currentLanguage]||{};document.getElementById('currentLangFlag').innerHTML=flags[currentLanguage]||'';document.getElementById('currentLangName').textContent=d['lang.current']||'';document.querySelectorAll('.lang-opt').forEach(function(o){o.classList.toggle('active',o.getAttribute('data-lang')===currentLanguage)})}

function formatFileSize(b){if(!b)return '0 B';var k=1024,s=['B','KB','MB'],i=Math.floor(Math.log(b)/Math.log(k));return parseFloat((b/Math.pow(k,i)).toFixed(1))+' '+s[i]}

function copyCode(btn){var code=btn.parentElement.querySelector('code');navigator.clipboard.writeText(code.textContent).then(function(){var t=btn.textContent;btn.textContent='OK';setTimeout(function(){btn.textContent=t},1500)})}

function switchTab(name){
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('active',t.getAttribute('data-tab')===name)});
  document.querySelectorAll('.panel').forEach(function(p){p.classList.toggle('active',p.id==='panel-'+name)});
}

document.addEventListener('DOMContentLoaded', function(){
  // i18n
  var saved=localStorage.getItem('open-tts-language');
  currentLanguage=(saved&&translations[saved])?saved:detectLanguage();
  setLanguage(currentLanguage);

  // API key
  var keyEl=document.getElementById('serviceApiKey');
  keyEl.value=localStorage.getItem('open-tts-api-key')||keyEl.value;
  keyEl.addEventListener('change',function(){localStorage.setItem('open-tts-api-key',keyEl.value)});

  // auto-fill base URL
  var origin=window.location.origin;
  document.querySelectorAll('.auto-base-url').forEach(function(el){el.textContent=origin});

  // tabs
  document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){switchTab(this.getAttribute('data-tab'))})});

  // language
  var langBtn=document.getElementById('languageBtn'),langDD=document.getElementById('languageDropdown');
  langBtn.addEventListener('click',function(e){e.stopPropagation();langDD.classList.toggle('show')});
  document.addEventListener('click',function(){langDD.classList.remove('show')});
  document.querySelectorAll('.lang-opt').forEach(function(o){o.addEventListener('click',function(){setLanguage(this.getAttribute('data-lang'));langDD.classList.remove('show')})});

  // file toggle
  var fileArea=document.getElementById('fileUploadArea');
  document.getElementById('fileToggleBtn').addEventListener('click',function(){
    var showing=fileArea.style.display!=='none';
    fileArea.style.display=showing?'none':'block';
    this.textContent=showing?'\\u6216\\u4E0A\\u4F20 txt \\u6587\\u4EF6':'\\u9690\\u85CF\\u6587\\u4EF6\\u4E0A\\u4F20';
  });

  // TTS file upload
  var fdz=document.getElementById('fileDropZone'),fi=document.getElementById('fileInput'),finfo=document.getElementById('fileInfo');
  fdz.addEventListener('click',function(){fi.click()});
  fi.addEventListener('change',function(e){if(e.target.files[0])pickFile(e.target.files[0])});
  fdz.addEventListener('dragover',function(e){e.preventDefault();fdz.classList.add('dragover')});
  fdz.addEventListener('dragleave',function(e){e.preventDefault();fdz.classList.remove('dragover')});
  fdz.addEventListener('drop',function(e){e.preventDefault();fdz.classList.remove('dragover');if(e.dataTransfer.files[0])pickFile(e.dataTransfer.files[0])});
  document.getElementById('fileRemoveBtn').addEventListener('click',function(){selectedFile=null;fi.value='';finfo.style.display='none';fdz.style.display='block'});

  function pickFile(f){
    if(!f.type.includes('text/')&&!f.name.toLowerCase().endsWith('.txt')){alert('\\u8BF7\\u9009\\u62E9 txt \\u683C\\u5F0F\\u7684\\u6587\\u672C\\u6587\\u4EF6');return}
    if(f.size>500*1024){alert('\\u6587\\u4EF6\\u5927\\u5C0F\\u4E0D\\u80FD\\u8D85\\u8FC7 500KB');return}
    selectedFile=f;
    document.getElementById('fileName').textContent=f.name;
    document.getElementById('fileSize').textContent=formatFileSize(f.size);
    finfo.style.display='flex';fdz.style.display='none';
  }

  // Audio upload
  var adz=document.getElementById('audioDropZone'),afi=document.getElementById('audioFileInput'),afinfo=document.getElementById('audioFileInfo');
  adz.addEventListener('click',function(){afi.click()});
  afi.addEventListener('change',function(e){if(e.target.files[0])pickAudio(e.target.files[0])});
  adz.addEventListener('dragover',function(e){e.preventDefault();adz.classList.add('dragover')});
  adz.addEventListener('dragleave',function(e){e.preventDefault();adz.classList.remove('dragover')});
  adz.addEventListener('drop',function(e){e.preventDefault();adz.classList.remove('dragover');if(e.dataTransfer.files[0])pickAudio(e.dataTransfer.files[0])});
  document.getElementById('audioFileRemoveBtn').addEventListener('click',function(){selectedAudioFile=null;afi.value='';afinfo.style.display='none';adz.style.display='block'});

  function pickAudio(f){
    var ok=['audio/mpeg','audio/mp3','audio/wav','audio/m4a','audio/flac','audio/aac','audio/ogg','audio/webm','audio/amr','audio/3gpp'];
    var valid=ok.some(function(t){return f.type.includes(t)})||/\\.(mp3|wav|m4a|flac|aac|ogg|webm|amr|3gp)$/i.test(f.name);
    if(!valid){alert('\\u8BF7\\u9009\\u62E9\\u97F3\\u9891\\u683C\\u5F0F\\u7684\\u6587\\u4EF6');return}
    if(f.size>10*1024*1024){alert('\\u97F3\\u9891\\u6587\\u4EF6\\u5927\\u5C0F\\u4E0D\\u80FD\\u8D85\\u8FC7 10MB');return}
    selectedAudioFile=f;
    document.getElementById('audioFileName').textContent=f.name;
    document.getElementById('audioFileSize').textContent=formatFileSize(f.size);
    afinfo.style.display='flex';adz.style.display='none';
  }

  // Token config
  var tokenRadios=document.querySelectorAll('input[name="tokenOption"]'),tokenInput=document.getElementById('tokenInput');
  tokenRadios.forEach(function(r){r.addEventListener('change',function(){tokenInput.style.display=this.value==='custom'?'block':'none'})});

  // TTS form submit
  document.getElementById('ttsForm').addEventListener('submit', async function(e){
    e.preventDefault();
    var voice=document.getElementById('voice').value;
    var speed=document.getElementById('speed').value;
    var pitch=document.getElementById('pitch').value;
    var style=document.getElementById('style').value;
    var btn=document.getElementById('generateBtn');
    var box=document.getElementById('result');
    var loading=document.getElementById('loading');
    var success=document.getElementById('success');
    var error=document.getElementById('error');
    var apiKey=document.getElementById('serviceApiKey').value;

    if(!selectedFile){
      var text=document.getElementById('text').value;
      if(!text.trim()){alert('\\u8BF7\\u8F93\\u5165\\u8981\\u8F6C\\u6362\\u7684\\u6587\\u672C\\u5185\\u5BB9');return}
    }

    box.style.display='block';loading.style.display='block';success.style.display='none';error.style.display='none';
    btn.disabled=true;btn.textContent='\\u751F\\u6210\\u4E2D...';

    try {
      var resp;
      var lt=document.getElementById('loadingText'),pi=document.getElementById('progressInfo');

      if(selectedFile){
        lt.textContent='\\u6B63\\u5728\\u5904\\u7406\\u4E0A\\u4F20\\u7684\\u6587\\u4EF6...';
        pi.textContent=selectedFile.name+' ('+formatFileSize(selectedFile.size)+')';
        var fd=new FormData();fd.append('file',selectedFile);fd.append('voice',voice);fd.append('speed',speed);fd.append('pitch',pitch);fd.append('style',style);
        resp=await fetch('/v1/audio/speech',{method:'POST',headers:{'Authorization':'Bearer '+apiKey},body:fd});
      } else {
        var text=document.getElementById('text').value;
        lt.textContent=text.length>3000?'\\u6B63\\u5728\\u5904\\u7406\\u957F\\u6587\\u672C\\uFF0C\\u8BF7\\u8010\\u5FC3\\u7B49\\u5F85...':'\\u6B63\\u5728\\u751F\\u6210\\u8BED\\u97F3\\uFF0C\\u8BF7\\u7A0D\\u5019...';
        pi.textContent=text.length+' \\u5B57\\u7B26';
        resp=await fetch('/v1/audio/speech',{method:'POST',headers:{'Authorization':'Bearer '+apiKey,'Content-Type':'application/json'},body:JSON.stringify({input:text,voice:voice,speed:parseFloat(speed),pitch:pitch,style:style})});
      }

      if(!resp.ok){var ed=await resp.json();throw new Error(ed.error?.message||'\\u751F\\u6210\\u5931\\u8D25')}
      var blob=await resp.blob();var url=URL.createObjectURL(blob);
      document.getElementById('audioPlayer').src=url;document.getElementById('downloadBtn').href=url;
      loading.style.display='none';success.style.display='block';
    } catch(err){
      loading.style.display='none';error.style.display='block';
      error.textContent='\\u9519\\u8BEF: '+err.message;
    } finally {
      btn.disabled=false;btn.textContent='\\u5F00\\u59CB\\u751F\\u6210\\u8BED\\u97F3';
    }
  });

  // Transcription form submit
  document.getElementById('transcriptionForm').addEventListener('submit', async function(e){
    e.preventDefault();
    if(!selectedAudioFile){alert('\\u8BF7\\u9009\\u62E9\\u8981\\u8F6C\\u5F55\\u7684\\u97F3\\u9891\\u6587\\u4EF6');return}
    var tokenOpt=document.querySelector('input[name="tokenOption"]:checked').value;
    var customToken=document.getElementById('tokenInput').value;
    if(tokenOpt==='custom'&&!customToken.trim()){alert('\\u8BF7\\u8F93\\u5165\\u81EA\\u5B9A\\u4E49 Token');return}
    var apiKey=document.getElementById('serviceApiKey').value;
    var btn=document.getElementById('transcribeBtn');
    var box=document.getElementById('transcriptionResult');
    var loading=document.getElementById('transcriptionLoading');
    var success=document.getElementById('transcriptionSuccess');
    var error=document.getElementById('transcriptionError');

    box.style.display='block';loading.style.display='block';success.style.display='none';error.style.display='none';
    btn.disabled=true;btn.textContent='\\u8F6C\\u5F55\\u4E2D...';
    document.getElementById('transcriptionLoadingText').textContent='\\u6B63\\u5728\\u8F6C\\u5F55\\u97F3\\u9891\\uFF0C\\u8BF7\\u7A0D\\u5019...';
    document.getElementById('transcriptionProgressInfo').textContent=selectedAudioFile.name+' ('+formatFileSize(selectedAudioFile.size)+')';

    try{
      var fd=new FormData();fd.append('file',selectedAudioFile);
      if(tokenOpt==='custom')fd.append('token',customToken);
      var resp=await fetch('/v1/audio/transcriptions',{method:'POST',headers:{'Authorization':'Bearer '+apiKey},body:fd});
      if(!resp.ok){var ed=await resp.json();throw new Error(ed.error?.message||'\\u8F6C\\u5F55\\u5931\\u8D25')}
      var result=await resp.json();
      document.getElementById('transcriptionText').value=result.text||'';
      loading.style.display='none';success.style.display='block';
    }catch(err){
      loading.style.display='none';error.style.display='block';error.textContent='\\u9519\\u8BEF: '+err.message;
    }finally{
      btn.disabled=false;btn.textContent='\\u5F00\\u59CB\\u8BED\\u97F3\\u8F6C\\u5F55';
    }
  });

  // Copy transcription
  document.getElementById('copyTranscriptionBtn').addEventListener('click',function(){
    var ta=document.getElementById('transcriptionText');ta.select();document.execCommand('copy');
    var b=this;var t=b.textContent;b.textContent='\\u5DF2\\u590D\\u5236';setTimeout(function(){b.textContent=t},1500);
  });

  // Edit transcription
  document.getElementById('editTranscriptionBtn').addEventListener('click',function(){
    var ta=document.getElementById('transcriptionText');
    if(ta.readOnly){ta.readOnly=false;ta.focus();this.textContent='\\u4FDD\\u5B58'}else{ta.readOnly=true;this.textContent='\\u7F16\\u8F91'}
  });

  // Use for TTS
  document.getElementById('useForTtsBtn').addEventListener('click',function(){
    var t=document.getElementById('transcriptionText').value;
    if(!t.trim()){alert('\\u8F6C\\u5F55\\u7ED3\\u679C\\u4E3A\\u7A7A');return}
    switchTab('tts');document.getElementById('text').value=t;
    document.querySelector('.shell').scrollIntoView({behavior:'smooth'});
  });
});
</script>
</body>
</html>
`;

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};

async function handleRequest(request, env = {}) {
    _corsOrigin = env.CORS_ORIGIN || "*";

    if (request.method === "OPTIONS") {
        return handleOptions(request);
    }




    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;

    // 返回前端页面
    if (path === "/" || path === "/index.html") {
        return new Response(HTML_PAGE, {
            headers: {
                "Content-Type": "text/html; charset=utf-8",
                ...makeCORSHeaders()
            }
        });
    }

    if (path === "/v1/audio/transcriptions") {
        try {
            return await handleAudioTranscription(request, env);
        } catch (error) {
            console.error("Audio transcription error:", error);
            return new Response(JSON.stringify({
                error: {
                    message: error.message,
                    type: "api_error",
                    param: null,
                    code: "transcription_error"
                }
            }), {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }
    }

    if (path === "/v1/models" && request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "只支持 GET 方法");
    }
    if (path === "/v1/models") {
        return new Response(JSON.stringify({
            object: "list",
            data: [{
                id: "open-tts",
                object: "model",
                created: 0,
                owned_by: "open-tts"
            }]
        }), {
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }

    if (path === "/v1/audio/voices" && request.method !== "GET") {
        return errorResponse(405, "method_not_allowed", "只支持 GET 方法");
    }
    if (path === "/v1/audio/voices") {
        return new Response(JSON.stringify({
            object: "list",
            data: VOICES.map(id => ({ id, object: "voice" })),
            aliases: VOICE_ALIASES
        }), {
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }

    if (path === "/v1/audio/speech") {
        if (request.method !== "POST") {
            return errorResponse(405, "method_not_allowed", "只支持 POST 方法");
        }
        const callerKey = request.headers.get("x-authenticated-key") || null;
        try {
            const contentType = request.headers.get("content-type") || "";

            if (contentType.includes("multipart/form-data")) {
                return await handleFileUpload(request, callerKey);
            }

            let requestBody;
            try {
                requestBody = await request.json();
            } catch {
                return errorResponse(400, "invalid_json", "请求体不是有效的 JSON");
            }

            if (!requestBody || typeof requestBody !== "object") {
                return errorResponse(400, "invalid_json", "请求体必须为 JSON 对象");
            }

            const {
                input,
                voice: requestedVoice = "zh-CN-XiaoxiaoNeural",
                speed = '1.0',
                volume = '0',
                pitch = '0',
                style = "general"
            } = requestBody;

            const validationError = validateTtsParams(input, requestedVoice, speed, pitch, volume, style);
            if (validationError) {
                return errorResponse(validationError.status, validationError.code, validationError.message);
            }

            const voice = VOICE_ALIASES[requestedVoice] || requestedVoice;
            let rate = Math.trunc((parseFloat(speed) - 1.0) * 100);
            let numVolume = parseInt(volume, 10);
            let numPitch = parseInt(pitch, 10);
            const response = await getVoice(
                input,
                voice,
                rate >= 0 ? `+${rate}%` : `${rate}%`,
                numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
                numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
                style,
                "audio-24khz-48kbitrate-mono-mp3",
                callerKey
            );

            return response;

        } catch (error) {
            console.error("Error:", error);
            return errorResponse(500, "edge_tts_error", error.message);
        }
    }

    // 默认返回 404
    return new Response("Not Found", { status: 404 });
}

async function handleOptions(request) {
    return new Response(null, {
        status: 204,
        headers: {
            ...makeCORSHeaders(),
            "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
            "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "Authorization"
        }
    });
}

// 添加延迟函数
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 优化文本分块函数
function optimizedTextSplit(text, maxChunkSize = 1500) {
    const chunks = [];
    const sentences = text.split(/[。！？\n]/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence) continue;
        
        // 如果单个句子就超过最大长度，按字符分割
        if (trimmedSentence.length > maxChunkSize) {
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = '';
            }
            
            // 按字符分割长句子
            for (let i = 0; i < trimmedSentence.length; i += maxChunkSize) {
                chunks.push(trimmedSentence.slice(i, i + maxChunkSize));
            }
        } else if ((currentChunk + trimmedSentence).length > maxChunkSize) {
            // 当前块加上新句子会超过限制，先保存当前块
            if (currentChunk) {
                chunks.push(currentChunk.trim());
            }
            currentChunk = trimmedSentence;
        } else {
            // 添加到当前块
            currentChunk += (currentChunk ? '。' : '') + trimmedSentence;
        }
    }
    
    // 添加最后一个块
    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }
    
    return chunks.filter(chunk => chunk.length > 0);
}

// 批量处理音频块
async function processBatchedAudioChunks(chunks, voiceName, rate, pitch, volume, style, outputFormat, batchSize = 3, delayMs = 1000) {
    const audioChunks = [];
    
    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);
        const batchPromises = batch.map(async (chunk, index) => {
            try {
                // 为每个请求添加小延迟，避免同时发送
                if (index > 0) {
                    await delay(index * 200);
                }
                return await getAudioChunk(chunk, voiceName, rate, pitch, volume, style, outputFormat);
            } catch (error) {
                console.error(`处理音频块失败 (批次 ${Math.floor(i/batchSize) + 1}, 块 ${index + 1}):`, error);
                throw error;
            }
        });
        
        try {
            const batchResults = await Promise.all(batchPromises);
            audioChunks.push(...batchResults);
            
            // 批次间延迟
            if (i + batchSize < chunks.length) {
                await delay(delayMs);
            }
        } catch (error) {
            console.error(`批次处理失败:`, error);
            throw error;
        }
    }
    
    return audioChunks;
}

const MAX_CONCURRENT_PER_KEY = 10;
const concurrencyByKey = new Map();

function acquireConcurrency(apiKey) {
    const key = apiKey || "__anonymous__";
    const current = concurrencyByKey.get(key) || 0;
    if (current >= MAX_CONCURRENT_PER_KEY) return false;
    concurrencyByKey.set(key, current + 1);
    return true;
}

function releaseConcurrency(apiKey) {
    const key = apiKey || "__anonymous__";
    const current = concurrencyByKey.get(key) || 0;
    if (current <= 1) concurrencyByKey.delete(key);
    else concurrencyByKey.set(key, current - 1);
}

function latexToReadable(expr) {
    return expr
        .replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, "$2分之$1")
        .replace(/\\sqrt\{([^}]*)\}/g, "$1的平方根")
        .replace(/\\sum/g, "求和").replace(/\\prod/g, "求积").replace(/\\int/g, "积分")
        .replace(/\\infty/g, "无穷").replace(/\\pi/g, "π")
        .replace(/\\alpha/g, "α").replace(/\\beta/g, "β").replace(/\\gamma/g, "γ")
        .replace(/\\delta/g, "δ").replace(/\\theta/g, "θ").replace(/\\lambda/g, "λ")
        .replace(/\\mu/g, "μ").replace(/\\sigma/g, "σ").replace(/\\omega/g, "ω")
        .replace(/\\geq?/g, "大于等于").replace(/\\leq?/g, "小于等于")
        .replace(/\\neq?/g, "不等于").replace(/\\approx/g, "约等于")
        .replace(/\\times/g, "乘以").replace(/\\div/g, "除以")
        .replace(/\\pm/g, "正负").replace(/\\cdot/g, "·")
        .replace(/\\ldots|\\cdots/g, "…")
        .replace(/\\(?:left|right|Big|big)[(.)|[\]{}]?/g, "")
        .replace(/\^{([^}]*)}/g, "的$1次方").replace(/\^(\w)/g, "的$1次方")
        .replace(/_{([^}]*)}/g, "$1").replace(/_(\w)/g, "$1")
        .replace(/[\\{}]/g, "").replace(/\s+/g, " ").trim();
}

function stripMarkdown(text) {
    try {
        let result = text
            .replace(/\$\$([\s\S]*?)\$\$/g, (_, e) => latexToReadable(e))
            .replace(/\$([^$]+)\$/g, (_, e) => latexToReadable(e));
        result = removeMarkdown(result, { stripListLeaders: true, gfm: true, useImgAltText: true });
        return result.replace(/\n{3,}/g, "\n\n").trim();
    } catch (err) {
        console.error("Markdown清洗失败，使用原文:", err);
        return text;
    }
}

async function getVoice(text, voiceName = "zh-CN-XiaoxiaoNeural", rate = '+0%', pitch = '+0Hz', volume = '+0%', style = "general", outputFormat = "audio-24khz-48kbitrate-mono-mp3", apiKey = null) {
    if (!acquireConcurrency(apiKey)) {
        return errorResponse(429, "too_many_requests", "并发请求过多，请稍后再试");
    }
    try {
        const cleanText = stripMarkdown(text.trim());
        if (!cleanText) {
            throw new Error("文本内容为空");
        }

        if (cleanText.length <= 1500) {
            const audioBlob = await getAudioChunk(cleanText, voiceName, rate, pitch, volume, style, outputFormat);
            return new Response(audioBlob, {
                headers: {
                    "Content-Type": "audio/mpeg",
                    ...makeCORSHeaders()
                }
            });
        }

        const chunks = optimizedTextSplit(cleanText, 1500);

        if (chunks.length > 40) {
            return errorResponse(413, "input_too_long", `文本过长，分块数量(${chunks.length})超过限制(40)，请缩短文本`);
        }
        
        console.log(`文本已分为 ${chunks.length} 个块进行处理`);

        // 批量处理音频块，控制并发数量和频率
        const audioChunks = await processBatchedAudioChunks(
            chunks, 
            voiceName, 
            rate, 
            pitch, 
            volume, 
            style, 
            outputFormat,
            3,  // 每批处理3个
            800 // 批次间延迟800ms
        );

        // 将音频片段拼接起来
        const concatenatedAudio = new Blob(audioChunks, { type: 'audio/mpeg' });
        return new Response(concatenatedAudio, {
            headers: {
                "Content-Type": "audio/mpeg",
                ...makeCORSHeaders()
            }
        });

    } catch (error) {
        console.error("语音合成失败:", error);
        return errorResponse(500, "edge_tts_error", error.message || String(error));
    } finally {
        releaseConcurrency(apiKey);
    }
}



//获取单个音频数据（增强错误处理和重试机制）
async function getAudioChunk(text, voiceName, rate, pitch, volume, style, outputFormat = 'audio-24khz-48kbitrate-mono-mp3', maxRetries = 3) {
    const retryDelay = 500; // 重试延迟500ms
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const endpoint = await getEndpoint();
            const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
            
            // 处理文本中的延迟标记
            let m = text.match(/\[(\d+)\]\s*?$/);
            let slien = 0;
            if (m && m.length == 2) {
                slien = parseInt(m[1]);
                text = text.replace(m[0], '');
            }
            
            // 验证文本长度
            if (!text.trim()) {
                throw new Error("文本块为空");
            }
            
            if (text.length > 2000) {
                throw new Error(`文本块过长: ${text.length} 字符，最大支持2000字符`);
            }
            
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": endpoint.t,
                    "Content-Type": "application/ssml+xml",
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
                    "X-Microsoft-OutputFormat": outputFormat
                },
                body: getSsml(text, voiceName, rate, pitch, volume, style, slien),
                signal: AbortSignal.timeout(30_000)
            });

            if (!response.ok) {
                const errorText = await response.text();
                
                // 根据错误类型决定是否重试
                if (response.status === 429) {
                    // 频率限制，需要重试
                    if (attempt < maxRetries) {
                        console.log(`频率限制，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`请求频率过高，已重试${maxRetries}次仍失败`);
                } else if (response.status >= 500) {
                    // 服务器错误，可以重试
                    if (attempt < maxRetries) {
                        console.log(`服务器错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                        await delay(retryDelay * (attempt + 1));
                        continue;
                    }
                    throw new Error(`Edge TTS服务器错误: ${response.status} ${errorText}`);
                } else {
                    // 客户端错误，不重试
                    throw new Error(`Edge TTS API错误: ${response.status} ${errorText}`);
                }
            }

            return await response.blob();
            
        } catch (error) {
            if (attempt === maxRetries) {
                // 最后一次重试失败
                throw new Error(`音频生成失败（已重试${maxRetries}次）: ${error.message}`);
            }
            
            // 如果是网络错误或其他可重试错误
            if (error.message.includes('fetch') || error.message.includes('network')) {
                console.log(`网络错误，第${attempt + 1}次重试，等待${retryDelay * (attempt + 1)}ms`);
                await delay(retryDelay * (attempt + 1));
                continue;
            }
            
            // 其他错误直接抛出
            throw error;
        }
    }
}

// XML文本转义函数
function escapeXmlText(text) {
    return text
        .replace(/&/g, '&amp;')   // 必须首先处理 &
        .replace(/</g, '&lt;')    // 处理 <
        .replace(/>/g, '&gt;')    // 处理 >
        .replace(/"/g, '&quot;')  // 处理 "
        .replace(/'/g, '&apos;'); // 处理 '
}

function getSsml(text, voiceName, rate, pitch, volume, style, slien = 0) {
    // 对文本进行XML转义
    const escapedText = escapeXmlText(text);
    
    let slien_str = '';
    if (slien > 0) {
        slien_str = `<break time="${slien}ms" />`
    }
    return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> 
                <voice name="${voiceName}"> 
                    <mstts:express-as style="${style}"  styledegree="2.0" role="default" > 
                        <prosody rate="${rate}" pitch="${pitch}" volume="${volume}">${escapedText}</prosody> 
                    </mstts:express-as> 
                    ${slien_str}
                </voice> 
            </speak>`;

}

let refreshPromise = null;

async function getEndpoint() {
    const now = Date.now() / 1000;

    if (tokenInfo.token && tokenInfo.expiredAt && now < tokenInfo.expiredAt - TOKEN_REFRESH_BEFORE_EXPIRY) {
        return tokenInfo.endpoint;
    }

    if (refreshPromise) {
        return refreshPromise;
    }

    refreshPromise = (async () => {
        const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
        const clientId = crypto.randomUUID().replace(/-/g, "");

        try {
            const response = await fetch(endpointUrl, {
                method: "POST",
                headers: {
                    "Accept-Language": "zh-Hans",
                    "X-ClientVersion": "4.0.530a 5fe1dc6c",
                    "X-UserId": "0f04d16a175c411e",
                    "X-HomeGeographicRegion": "zh-Hans-CN",
                    "X-ClientTraceId": clientId,
                    "X-MT-Signature": await sign(endpointUrl),
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36 Edg/127.0.0.0",
                    "Content-Type": "application/json; charset=utf-8",
                    "Content-Length": "0",
                    "Accept-Encoding": "gzip"
                },
                signal: AbortSignal.timeout(10_000)
            });

            if (!response.ok) {
                throw new Error(`获取endpoint失败: ${response.status}`);
            }

            const data = await response.json();
            const jwt = data.t.split(".")[1];
            const decodedJwt = JSON.parse(Buffer.from(jwt, "base64url").toString());

            tokenInfo = {
                endpoint: data,
                token: data.t,
                expiredAt: decodedJwt.exp
            };

            return data;

        } catch (error) {
            console.error("获取endpoint失败:", error);
            if (tokenInfo.token) {
                console.log("使用过期的缓存token");
                return tokenInfo.endpoint;
            }
            throw error;
        } finally {
            refreshPromise = null;
        }
    })();

    return refreshPromise;
}



let _corsOrigin = "*";

function makeCORSHeaders() {
    return {
        "Access-Control-Allow-Origin": _corsOrigin,
        "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, x-api-key, Authorization",
        "Access-Control-Max-Age": "86400"
    };
}

async function hmacSha256(key, data) {
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        key,
        { name: "HMAC", hash: { name: "SHA-256" } },
        false,
        ["sign"]
    );
    const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
    return new Uint8Array(signature);
}

async function base64ToBytes(base64) {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
}

async function bytesToBase64(bytes) {
    return btoa(String.fromCharCode.apply(null, bytes));
}

function uuid() {
    return crypto.randomUUID().replace(/-/g, "");
}

async function sign(urlStr) {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = uuid();
    const formattedDate = dateFormat();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    const decode = await base64ToBytes("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const signData = await hmacSha256(decode, bytesToSign);
    const signBase64 = await bytesToBase64(signData);
    return `MSTranslatorAndroidApp::${signBase64}::${formattedDate}::${uuidStr}`;
}

function dateFormat() {
    const formattedDate = (new Date()).toUTCString().replace(/GMT/, "").trim() + " GMT";
    return formattedDate.toLowerCase();
}

// 处理文件上传的函数
async function handleFileUpload(request, apiKey = null) {
    try {
        const formData = await request.formData();
        const file = formData.get('file');
        const voice = formData.has('voice') ? String(formData.get('voice')) : 'zh-CN-XiaoxiaoNeural';
        const speed = formData.has('speed') ? String(formData.get('speed')) : '1.0';
        const volume = formData.has('volume') ? String(formData.get('volume')) : '0';
        const pitch = formData.has('pitch') ? String(formData.get('pitch')) : '0';
        const style = formData.has('style') ? String(formData.get('style')) : 'general';

        if (!file || typeof file === "string" || typeof file.arrayBuffer !== "function") {
            return errorResponse(400, "missing_file", "file 字段必须为上传的文件");
        }

        if (!file.type.includes('text/') && !(file.name || "").toLowerCase().endsWith('.txt')) {
            return new Response(JSON.stringify({
                error: {
                    message: "不支持的文件类型，请上传txt文件",
                    type: "invalid_request_error",
                    param: "file",
                    code: "invalid_file_type"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        // 验证文件大小（限制为500KB）
        if (file.size > 500 * 1024) {
            return new Response(JSON.stringify({
                error: {
                    message: "文件大小超过限制（最大500KB）",
                    type: "invalid_request_error",
                    param: "file",
                    code: "file_too_large"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        // 读取文件内容
        const text = await file.text();
        
        // 验证文本内容
        if (!text.trim()) {
            return new Response(JSON.stringify({
                error: {
                    message: "文件内容为空",
                    type: "invalid_request_error",
                    param: "file",
                    code: "empty_file"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        const validationError = validateTtsParams(text, voice, speed, pitch, volume, style);
        if (validationError) {
            return errorResponse(validationError.status, validationError.code, validationError.message);
        }

        let rate = Math.trunc((parseFloat(speed) - 1.0) * 100);
        let numVolume = Math.trunc(parseFloat(volume));
        let numPitch = Math.trunc(parseFloat(pitch));

        return await getVoice(
            text,
            voice,
            rate >= 0 ? `+${rate}%` : `${rate}%`,
            numPitch >= 0 ? `+${numPitch}Hz` : `${numPitch}Hz`,
            numVolume >= 0 ? `+${numVolume}%` : `${numVolume}%`,
            style,
            "audio-24khz-48kbitrate-mono-mp3",
            apiKey
        );

    } catch (error) {
        console.error("文件上传处理失败:", error);
        return new Response(JSON.stringify({
            error: {
                message: "文件处理失败",
                type: "api_error",
                param: null,
                code: "file_processing_error"
            }
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }
}

// 处理语音转录的函数
async function handleAudioTranscription(request, env = {}) {
    try {
        if (request.method !== 'POST') {
            return errorResponse(405, "method_not_allowed", "只支持 POST 方法");
        }

        const contentType = request.headers.get("content-type") || "";
        
        // 验证Content-Type
        if (!contentType.includes("multipart/form-data")) {
            return new Response(JSON.stringify({
                error: {
                    message: "请求必须使用multipart/form-data格式",
                    type: "invalid_request_error",
                    param: "content-type",
                    code: "invalid_content_type"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        // 解析FormData
        const formData = await request.formData();
        const audioFile = formData.get('file');
        const customToken = formData.get('token');

        if (!audioFile || typeof audioFile === "string" || typeof audioFile.arrayBuffer !== "function") {
            return errorResponse(400, "missing_file", "file 字段必须为上传的音频文件");
        }

        if (audioFile.size > 10 * 1024 * 1024) {
            return new Response(JSON.stringify({
                error: {
                    message: "音频文件大小不能超过10MB",
                    type: "invalid_request_error",
                    param: "file",
                    code: "file_too_large"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        // 验证音频文件格式
        const allowedTypes = [
            'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/m4a', 'audio/flac', 'audio/aac',
            'audio/ogg', 'audio/webm', 'audio/amr', 'audio/3gpp'
        ];
        
        const fileType = audioFile.type || "";
        const fileName = audioFile.name || "";
        const isValidType = allowedTypes.some(type => fileType.includes(type)) ||
            /\.(mp3|wav|m4a|flac|aac|ogg|webm|amr|3gp)$/i.test(fileName);

        if (!isValidType) {
            return new Response(JSON.stringify({
                error: {
                    message: "不支持的音频文件格式，请上传mp3、wav、m4a、flac、aac、ogg、webm、amr或3gp格式的文件",
                    type: "invalid_request_error",
                    param: "file",
                    code: "invalid_file_type"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        const token = customToken || env.SILICONFLOW_API_KEY;
        if (!token) {
            return new Response(JSON.stringify({
                error: {
                    message: "未配置语音转录Token，请设置SILICONFLOW_API_KEY或在请求中提供token",
                    type: "invalid_request_error",
                    param: "token",
                    code: "missing_api_key"
                }
            }), {
                status: 400,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        // 构建发送到硅基流动API的FormData
        const apiFormData = new FormData();
        apiFormData.append('file', audioFile);
        apiFormData.append('model', 'FunAudioLLM/SenseVoiceSmall');

        // 发送请求到硅基流动API
        const apiResponse = await fetch('https://api.siliconflow.cn/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`
            },
            body: apiFormData,
            signal: AbortSignal.timeout(60_000)
        });

        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error('硅基流动API错误:', apiResponse.status, errorText);
            
            let errorMessage = '语音转录服务暂时不可用';
            
            if (apiResponse.status === 401) {
                errorMessage = 'API Token无效，请检查您的配置';
            } else if (apiResponse.status === 429) {
                errorMessage = '请求过于频繁，请稍后再试';
            } else if (apiResponse.status === 413) {
                errorMessage = '音频文件太大，请选择较小的文件';
            }

            return new Response(JSON.stringify({
                error: {
                    message: errorMessage,
                    type: "api_error",
                    param: null,
                    code: "transcription_api_error"
                }
            }), {
                status: apiResponse.status,
                headers: {
                    "Content-Type": "application/json",
                    ...makeCORSHeaders()
                }
            });
        }

        // 获取转录结果
        const transcriptionResult = await apiResponse.json();

        // 返回转录结果
        return new Response(JSON.stringify(transcriptionResult), {
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });

    } catch (error) {
        console.error("语音转录处理失败:", error);
        return new Response(JSON.stringify({
            error: {
                message: "语音转录处理失败",
                type: "api_error",
                param: null,
                code: "transcription_processing_error"
            }
        }), {
            status: 500,
            headers: {
                "Content-Type": "application/json",
                ...makeCORSHeaders()
            }
        });
    }
}
