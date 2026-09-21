# Open TTS

Open TTS 是一个轻量、自托管的语音处理服务，提供网页操作界面和 OpenAI 风格的 HTTP API。

主要特性：

- 无需 GPU，不在本地运行语音模型
- 文字转语音和语音转文字
- 中文男声、女声音色
- 支持 OpenAI 常见音色别名
- 支持语速、音调、音量和风格参数
- 支持文本文件和音频文件上传
- 长文本自动分段和批量合成
- 中文、英文、日文、韩文、西班牙文、法文、德文和俄文界面
- API Key 鉴权
- Docker 镜像（amd64）
- 健康检查、模型列表和音色列表接口

语音合成依赖 Microsoft 在线语音服务。语音转文字使用 `FunAudioLLM/SenseVoiceSmall`，通过兼容接口调用。运行环境需要访问外网。

## 本地运行

需要 Node.js 22 或更高版本：

```bash
API_KEY=sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e node server.mjs
```

服务默认监听：

```text
http://127.0.0.1:8787
```

健康检查：

```bash
curl http://127.0.0.1:8787/healthz
```

## 构建镜像

```bash
docker build -t open-tts:latest .
```

运行：

```bash
docker run --rm \
  -p 8787:8787 \
  open-tts:latest
```

镜像内置默认 API Key：

```text
sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e
```

通过环境变量覆盖：

```bash
docker run --rm \
  -p 8787:8787 \
  -e API_KEY=your-api-key \
  -e SILICONFLOW_API_KEY=your-siliconflow-key \
  open-tts:latest
```

### 多 API Key

使用 `API_KEYS` 环境变量配置多个 Key，逗号分隔。每个 Key 独立计算并发上限（最多 10 个 TTS 并发）：

```bash
docker run --rm \
  -p 8787:8787 \
  -e API_KEYS=sk-my-private-key,sk-shared-public-key \
  -e SILICONFLOW_API_KEY=your-siliconflow-key \
  open-tts:latest
```

`API_KEYS` 优先于 `API_KEY`。未设置 `API_KEYS` 时回退到单个 `API_KEY`。

## 调用接口

```bash
curl http://127.0.0.1:8787/v1/audio/speech \
  -H "Authorization: Bearer sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1",
    "input": "你好，这是语音合成测试。",
    "voice": "zh-CN-XiaoxiaoNeural",
    "speed": 1.0
  }' \
  --output speech.mp3
```

OpenAI Python SDK：

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e",
    base_url="http://127.0.0.1:8787/v1",
)

response = client.audio.speech.create(
    model="tts-1",
    voice="zh-CN-XiaoxiaoNeural",
    input="你好，这是语音合成测试。",
    speed=1.0,
)
response.write_to_file("speech.mp3")
```

支持 OpenAI 音色别名：

```text
alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer
```

也可以直接使用中文音色，例如：

```text
zh-CN-XiaoxiaoNeural
zh-CN-YunxiNeural
```

查询全部音色：

```bash
curl http://127.0.0.1:8787/v1/audio/voices \
  -H "Authorization: Bearer sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e"
```

查询模型：

```bash
curl http://127.0.0.1:8787/v1/models \
  -H "Authorization: Bearer sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e"
```

## 语音转文字

服务端配置：

```bash
SILICONFLOW_API_KEY=your-siliconflow-key npm start
```

调用：

```bash
curl http://127.0.0.1:8787/v1/audio/transcriptions \
  -H "Authorization: Bearer sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e" \
  -F "file=@speech.mp3"
```

也可以在单次请求中提供自定义 Token：

```bash
curl http://127.0.0.1:8787/v1/audio/transcriptions \
  -H "Authorization: Bearer sk-c96e08d2c3e20a3e244c51ee69888d0a96400b1a3883aa4e" \
  -F "file=@speech.mp3" \
  -F "token=your-siliconflow-key"
```

## 发布镜像

手动发布示例：

```bash
export IMAGE=ghcr.io/izerui/open-tts:latest

docker login ghcr.io
docker buildx build \
  --platform linux/amd64 \
  -t "${IMAGE}" \
  --push \
  .
```

仓库内的 GitHub Actions 会在推送到 `main`、创建版本标签或手动触发时发布到：

```text
ghcr.io/<GitHub用户名或组织名>/<仓库名>
```

## 使用限制

| 限制项 | 说明 |
|--------|------|
| 每 Key TTS 并发 | 每个 API Key 最多同时处理 10 个 TTS 请求，超出返回 `429` |
| 文本长度 | 单次请求最大 10,000 字符 |
| 请求体大小 | 最大 11MB，超出返回 `413` |
| 音频文件 | 语音转文字最大 10MB，支持 mp3/wav/m4a/flac/aac/ogg/webm/amr/3gp |
| 文本文件 | txt 格式，最大 500KB |
| 参数范围 | speed 0.5-2.0，pitch -50~50（整数），volume -100~100（整数） |
| Markdown 清洗 | 自动去除 Markdown 标记（标题、粗体、代码围栏、LaTeX 公式符号等），保留正文内容朗读 |

## 开发

- 修改网页、TTS 参数或合成逻辑：编辑 `index.js`。
- 修改 HTTP 服务、鉴权或健康检查：编辑 `server.mjs`。
- 修改默认 API Key：编辑 `Dockerfile` 中的 `API_KEY`。
- 配置多 API Key：设置 `API_KEYS` 环境变量（逗号分隔）。
- 配置默认语音转文字 Token：设置 `SILICONFLOW_API_KEY` 环境变量。
- 配置 CORS 允许来源：设置 `CORS_ORIGIN` 环境变量，默认 `*`。
- 检查 JavaScript 语法：运行 `npm run check`。
- 运行测试：`npm test`。

当前输出格式固定为 MP3。

## 安全提示

默认 Key 是公开固定值，只适合测试或受信任网络。公网部署建议通过 `API_KEYS` 配置独立 Key。每个 Key 有独立的并发配额，互不影响。

## License

MIT
