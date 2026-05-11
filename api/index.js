const axios = require('axios');
const CryptoJS = require('crypto-js');

let globalSession = null;
let lastInitTime = 0;

const MODELS = [
  "DeepSeek-V3", "DeepSeek-V3.1", "DeepSeek-V3.2", "DeepSeek-R1",
  "DeepSeek-R1-0528", "DeepSeek-Coder-V2", "DeepSeek-Prover-V2",
  "DeepSeek-V2.5", "DeepSeek-VL"
];

async function initSession() {
  const now = Date.now();
  if (globalSession && (now - lastInitTime < 300000)) return globalSession; // 5 min cache

  console.log("🔄 Initializing new Asmodeus session...");

  const session = axios.create({
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
    },
    maxRedirects: 5,
    timeout: 30000
  });

  // Get main page
  const mainPage = await session.get('https://asmodeus.free.nf/');
  const matches = mainPage.data.match(/toNumbers\("([a-f0-9]+)"\)/g);

  if (!matches || matches.length < 3) {
    throw new Error("Failed to extract encryption data");
  }

  const nums = matches.map(m => m.match(/([a-f0-9]+)/)[1]);
  const key = CryptoJS.enc.Hex.parse(nums[0]);
  const iv = CryptoJS.enc.Hex.parse(nums[1]);
  const data = CryptoJS.enc.Hex.parse(nums[2]);

  const decrypted = CryptoJS.AES.decrypt(
    { ciphertext: data },
    key,
    { iv: iv }
  ).toString(CryptoJS.enc.Utf8);

  // Set cookie
  session.defaults.headers.Cookie = `__test=${decrypted}`;

  await session.get('https://asmodeus.free.nf/index.php?i=1');

  globalSession = session;
  lastInitTime = now;
  console.log("✅ Session initialized successfully");
  return session;
}

function simulateStream(res, content) {
  const words = content.split(' ');
  let i = 0;

  const interval = setInterval(() => {
    if (i < words.length) {
      const chunk = {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "DeepSeek-V3",
        choices: [{
          delta: { content: words[i] + " " },
          index: 0,
          finish_reason: null
        }]
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      i++;
    } else {
      const done = {
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "DeepSeek-V3",
        choices: [{
          delta: {},
          index: 0,
          finish_reason: "stop"
        }]
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write('data: [DONE]\n\n');
      clearInterval(interval);
      res.end();
    }
  }, 40); // \~25 tokens/sec feel
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Models endpoint
  if (req.url.includes('/v1/models') || req.method === 'GET') {
    return res.json({
      object: "list",
      data: MODELS.map(m => ({
        id: m,
        object: "model",
        created: 1710000000,
        owned_by: "deepseek"
      }))
    });
  }

  // Chat completions
  if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });

  try {
    const { model = "DeepSeek-V3", messages, stream = false } = req.body;

    if (!messages || !messages.length) {
      return res.status(400).json({ error: "Messages are required" });
    }

    const session = await initSession();

    // Combine history into one prompt
    const historyPrompt = messages.map(m => {
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`;
    }).join('\n\n');

    const response = await session.post(
      'https://asmodeus.free.nf/deepseek.php',
      {
        model: model,
        question: historyPrompt
      },
      { params: { i: '1' } }
    );

    const match = response.data.match(/<div class="response-content">(.*?)<\/div>/s);
    const content = match ? match[1].trim() : "No response from proxy.";

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      simulateStream(res, content);
    } else {
      res.json({
        id: "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: { role: "assistant", content: content },
          finish_reason: "stop"
        }]
      });
    }

  } catch (error) {
    console.error("Proxy Error:", error.message);
    
    // Auto refresh session on failure
    globalSession = null;
    
    res.status(500).json({
      error: {
        message: error.message || "Internal proxy error",
        type: "proxy_error"
      }
    });
  }
};
