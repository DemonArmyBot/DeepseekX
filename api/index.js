const axios = require('axios');
const CryptoJS = require('crypto-js');

let globalSession = null;
let lastInitTime = 0;

const SESSION_TTL_MS = 5 * 60 * 1000;

const MODELS = [
  'DeepSeek-V1',
  'DeepSeek-V2',
  'DeepSeek-V2.5',
  'DeepSeek-V3',
  'DeepSeek-V3-0324',
  'DeepSeek-V3.1',
  'DeepSeek-V3.2',
  'DeepSeek-R1',
  'DeepSeek-R1-0528',
  'DeepSeek-R1-Distill',
  'DeepSeek-Prover-V1',
  'DeepSeek-Prover-V1.5',
  'DeepSeek-Prover-V2',
  'DeepSeek-VL',
  'DeepSeek-Coder',
  'DeepSeek-Coder-V2',
  'DeepSeek-Coder-6.7B-base',
  'DeepSeek-Coder-6.7B-instruct',
];

// ─── Utils ─────────────────────────────────────────────────────────────────────

function getPath(req) {
  if (Array.isArray(req.query?.path)) return `/${req.query.path.join('/')}`;
  try {
    const url = new URL(req.url, 'http://localhost');
    return url.pathname || '/';
  } catch {
    return req.url || '/';
  }
}

function safeJsonBody(req, res) {
  try {
    const body = req.body || {};
    return body;
  } catch (e) {
    res.status(400).json({
      error: {
        message: 'Invalid JSON body',
        type: 'invalid_request_error',
      },
    });
    return null;
  }
}

function stripHtml(html) {
  return String(html)
    .replace(/<brs*/?>/gi, '
')
    .replace(/</p>/gi, '
')
    .replace(/<li>/gi, '- ')
    .replace(/</li>/gi, '
')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/
{3,}/g, '

')
    .trim();
}

function normalizeMessageContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('
');
  }
  return '';
}

function buildPrompt(messages) {
  return messages
    .map((m) => {
      const role =
        m.role === 'system'
          ? 'System'
          : m.role === 'assistant'
          ? 'Assistant'
          : 'User';
      return `${role}: ${normalizeMessageContent(m.content)}`;
    })
    .join('

');
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.ceil(String(text).trim().split(/s+/).length * 1.3));
}

// ─── Session boot (matches your Python script) ───────────────────────────────

async function initSession() {
  const now = Date.now();
  if (globalSession && now - lastInitTime < SESSION_TTL_MS) {
    return globalSession;
  }

  console.log('→ Initializing Asmodeus session...');
  const session = axios.create({
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Android 12; Mobile; rv:97.0) Gecko/97.0 Firefox/97.0',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    },
    maxRedirects: 10,
    timeout: 30000,
    validateStatus: () => true,
  });

  let mainPage;
  try {
    mainPage = await session.get('https://asmodeus.free.nf/');
  } catch (e) {
    throw new Error('Network error reaching asmodeus.free.nf');
  }

  const body = String(mainPage.data || '');
  console.log(`→ Main page status: ${mainPage.status}, body preview: ${body.slice(0, 400)}`);

  if (mainPage.status === 403) {
    throw new Error('asmodeus.free.nf returned 403 Forbidden');
  }
  if (mainPage.status !== 200) {
    throw new Error(`asmodeus.free.nf returned HTTP ${mainPage.status}`);
  }

  const matches = body.match(/toNumbers("([a-f0-9]+)")/gi);
  if (!matches || matches.length < 3) {
    throw new Error('Failed to parse AES params from page');
  }

  const nums = matches.map((m) => {
    const found = m.match(/([a-f0-9]+)/i);
    return found ? found[1] : '';
  });

  if (nums.some((v) => !v)) {
    throw new Error('Invalid AES hex parameter');
  }

  const key = CryptoJS.enc.Hex.parse(nums[0]);
  const iv  = CryptoJS.enc.Hex.parse(nums[1]);
  const data = CryptoJS.enc.Hex.parse(nums[2]);

  let decrypted = '';
  try {
    decrypted = CryptoJS.AES.decrypt({ ciphertext: data }, key, { iv }).toString(
      CryptoJS.enc.Utf8
    );
  } catch (e) {
    throw new Error('AES decryption failed');
  }

  if (!decrypted) {
    throw new Error('Decrypted cookie is empty');
  }

  session.defaults.headers.Cookie = `__test=${decrypted}`;
  session.defaults.headers.Referer = 'https://asmodeus.free.nf/';
  session.defaults.headers.Origin = 'https://asmodeus.free.nf';

  const confirm = await session.get('https://asmodeus.free.nf/index.php?i=1', {
    validateStatus: () => true,
  });

  console.log(`→ Session confirm: ${confirm.status}`);
  globalSession = session;
  lastInitTime = now;

  return session;
}

// ─── Streaming ───────────────────────────────────────────────────────────────

function writeSseChunk(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}

`);
}

function simulateStream(res, content, model) {
  const words = String(content).split(/s+/).filter(Boolean);
  const id = `chatcmpl-${Date.now()}`;
  let i = 0;

  const interval = setInterval(() => {
    if (i < words.length) {
      writeSseChunk(res, {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            delta: { content: `${i === 0 ? '' : ' '}${words[i]}` },
            index: 0,
            finish_reason: null,
          },
        ],
      });
      i += 1;
      return;
    }

    writeSseChunk(res, {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          delta: {},
          index: 0,
          finish_reason: 'stop',
        },
      ],
    });
    res.write('data: [DONE]

');
    clearInterval(interval);
    res.end();
  }, 40);

  res.on('close', () => clearInterval(interval));
  res.on('finish', () => clearInterval(interval));
  res.on('error', () => clearInterval(interval));
}

// ─── Chat handler (matches your Python logic) ────────────────────────────────

async function handleChat(req, res) {
  const body = safeJsonBody(req, res);
  if (!body) return;

  const {
    model = 'DeepSeek-V3',
    messages,
    stream = false,
  } = body;

  if (!MODELS.includes(model)) {
    return res.status(400).json({
      error: {
        message: `Unsupported model "${model}"`,
        type: 'invalid_request_error',
      },
    });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({
      error: {
        message: 'messages array is required and not empty',
        type: 'invalid_request_error',
      },
    });
  }

  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      return res.status(400).json({
        error: {
          message: 'Each message must be an object',
          type: 'invalid_request_error',
        },
      });
    }

    if (!['system', 'user', 'assistant'].includes(m.role)) {
      return res.status(400).json({
        error: {
          message: 'message.role must be system, user, or assistant',
          type: 'invalid_request_error',
        },
      });
    }

    const content = normalizeMessageContent(m.content);
    if (!content) {
      return res.status(400).json({
        error: {
          message: 'message.content must be non‑empty',
          type: 'invalid_request_error',
        },
      });
    }
  }

  const prompt = buildPrompt(messages);
  const session = await initSession();

  const upstream = await session.post(
    'https://asmodeus.free.nf/deepseek.php',
    { model, question: prompt },
    {
      params: { i: '1' },
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    }
  );

  console.log(`→ deepseek.php status: ${upstream.status}`);
  if (upstream.status === 403 || upstream.status >= 500) {
    throw new Error(`Upstream error HTTP ${upstream.status}`);
  }

  const bodyText =
    typeof upstream.data === 'string'
      ? upstream.data
      : JSON.stringify(upstream.data || {});

  const replyMatch = bodyText.match(/<div class="response-content">(.*?)</div>/i);
  const rawContent = replyMatch ? replyMatch[1] : bodyText;
  const content = stripHtml(rawContent);

  if (!content) {
    throw new Error('Got empty response from upstream');
  }

  const promptTokens = estimateTokens(prompt);
  const completionTokens = estimateTokens(content);

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    return simulateStream(res, content, model);
  }

  return res.status(200).json({
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

// ─── Vercel handler (root‑mounted) ───────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const path = getPath(req);
  console.log(`→ ${req.method} ${path}`);

  if (req.method === 'GET' && (path === '/' || path === '/api')) {
    return res.status(200).json({
      status: 'ok',
      message: 'DeepSeek Vercel Proxy Running',
      endpoints: {
        models: 'GET /v1/models',
        chat: 'POST /v1/chat/completions',
      },
    });
  }

  if (req.method === 'GET' && path.endsWith('/v1/models')) {
    return res.status(200).json({
      object: 'list',
      data: MODELS.map((id) => ({
        id,
        object: 'model',
        created: 1710000000,
        owned_by: 'deepseek',
      })),
    });
  }

  if (req.method === 'POST' && path.endsWith('/v1/chat/completions')) {
    try {
      return await handleChat(req, res);
    } catch (err) {
      console.error('💥 Proxy error:', err.message);
      globalSession = null;

      return res.status(500).json({
        error: {
          message: err.message || 'Internal proxy error',
          type: 'proxy_error',
        },
      });
    }
  }

  return res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${path}`,
      type: 'not_found',
      valid_routes: ['GET /v1/models', 'POST /v1/chat/completions'],
    },
  });
};