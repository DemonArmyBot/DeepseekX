const axios = require('axios');
const CryptoJS = require('crypto-js');

let globalSession = null;
let lastInitTime = 0;

const MODELS = [
  "DeepSeek-V3",
  "DeepSeek-V3.1",
  "DeepSeek-V3.2",
  "DeepSeek-R1",
  "DeepSeek-R1-0528",
  "DeepSeek-Coder-V2",
  "DeepSeek-Prover-V2",
  "DeepSeek-V2.5",
  "DeepSeek-VL"
];

// ─── Session Management ────────────────────────────────────────────────────────

async function initSession() {
  const now = Date.now();
  if (globalSession && now - lastInitTime < 300000) {
    return globalSession;
  }

  console.log("🔄 Initializing new Asmodeus session...");

  const session = axios.create({
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    maxRedirects: 5,
    timeout: 30000,
  });

  const mainPage = await session.get('https://asmodeus.free.nf/');
  const matches = mainPage.data.match(/toNumbers\("([a-f0-9]+)"\)/g);

  if (!matches || matches.length < 3) {
    throw new Error("Failed to extract encryption data from main page");
  }

  const nums = matches.map(m => m.match(/([a-f0-9]+)/)[1]);
  const key  = CryptoJS.enc.Hex.parse(nums[0]);
  const iv   = CryptoJS.enc.Hex.parse(nums[1]);
  const data = CryptoJS.enc.Hex.parse(nums[2]);

  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: data },
    key,
    { iv }
  ).toString(CryptoJS.enc.Utf8);

  if (!decrypted) {
    throw new Error("AES decryption returned empty string");
  }

  session.defaults.headers['Cookie'] = `__test=${decrypted}`;
  await session.get('https://asmodeus.free.nf/index.php?i=1');

  globalSession = session;
  lastInitTime  = now;
  console.log("✅ Session initialized successfully");
  return session;
}

// ─── Streaming Helper ──────────────────────────────────────────────────────────

function simulateStream(res, content, model) {
  const words = content.split(' ');
  let i = 0;
  const id = "chatcmpl-" + Date.now();

  const interval = setInterval(() => {
    if (i < words.length) {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          delta: { content: (i === 0 ? '' : ' ') + words[i] },
          index: 0,
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      i++;
    } else {
      const done = {
        id,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          delta: {},
          index: 0,
          finish_reason: "stop",
        }],
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write('data: [DONE]\n\n');
      clearInterval(interval);
      res.end();
    }
  }, 40);
}

// ─── Main Handler ──────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const url    = req.url || '/';
  const method = req.method;

  console.log(`→ ${method} ${url}`);

  // ── Root ping ──────────────────────────────────────────────────────────────
  if (method === 'GET' && (url === '/' || url === '')) {
    return res.status(200).json({
      status: "ok",
      message: "DeepSeek Proxy is running",
      endpoints: {
        models: "GET /v1/models",
        chat:   "POST /v1/chat/completions",
      },
    });
  }

  // ── GET /v1/models ─────────────────────────────────────────────────────────
  if (method === 'GET' && url.includes('/v1/models')) {
    return res.status(200).json({
      object: "list",
      data: MODELS.map(m => ({
        id: m,
        object: "model",
        created: 1710000000,
        owned_by: "deepseek",
      })),
    });
  }

  // ── POST /v1/chat/completions ──────────────────────────────────────────────
  if (method === 'POST' && url.includes('/v1/chat/completions')) {
    try {
      const { model = "DeepSeek-V3", messages, stream = false } = req.body || {};

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          error: {
            message: "messages array is required and must not be empty",
            type: "invalid_request_error",
          },
        });
      }

      const session = await initSession();

      const historyPrompt = messages
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');

      const response = await session.post(
        'https://asmodeus.free.nf/deepseek.php',
        { model, question: historyPrompt },
        { params: { i: '1' } }
      );

      const match = response.data.match(/<div class="response-content">([\s\S]*?)<\/div>/);
      const content = match
        ? match[1].trim()
        : (typeof response.data === 'string' ? response.data.trim() : "No response from proxy.");

      if (!content) {
        throw new Error("Empty content received from upstream proxy");
      }

      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        return simulateStream(res, content, model);
      }

      return res.status(200).json({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: historyPrompt.split(' ').length,
          completion_tokens: content.split(' ').length,
          total_tokens: historyPrompt.split(' ').length + content.split(' ').length,
        },
      });

    } catch (error) {
      console.error("❌ Proxy Error:", error.message);
      globalSession = null;

      return res.status(500).json({
        error: {
          message: error.message || "Internal proxy error",
          type: "proxy_error",
        },
      });
    }
  }

  // ── 404 Fallback ───────────────────────────────────────────────────────────
  return res.status(404).json({
    error: {
      message: `Route not found: ${method} ${url}`,
      type: "not_found",
      valid_routes: [
        "GET  /v1/models",
        "POST /v1/chat/completions",
      ],
    },
  });
};
