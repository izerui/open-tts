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

## 开发

- 修改网页、TTS 参数或合成逻辑：编辑 `index.js`。
- 修改 HTTP 服务、鉴权或健康检查：编辑 `server.mjs`。
- 修改默认 API Key：编辑 `Dockerfile` 中的 `API_KEY`。
- 配置默认语音转文字 Token：设置 `SILICONFLOW_API_KEY` 环境变量。
- 检查 JavaScript 语法：运行 `npm run check`。

当前输出格式固定为 MP3。

## 安全提示

默认 Key 是公开固定值，只适合测试或受信任网络。公网部署应通过环境变量更换，并在入口增加限流、访问日志和调用配额。

## License

MIT
