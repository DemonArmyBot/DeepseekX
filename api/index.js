const axios = require('axios');
const CryptoJS = require('crypto-js');

let globalSession = null;
let lastInitTime = 0;

const SESSION_TTL_MS = 5 * 60 * 1000;

const MODELS = [
  'DeepSeek-V3',
  'DeepSeek-V3.1',
  'DeepSeek-V3.2',
  'DeepSeek-R1',
  'DeepSeek-R1-0528',
  'DeepSeek-Coder-V2',
  'DeepSeek-Prover-V2',
  'DeepSeek-V2.5',
  'DeepSeek-VL',
];

function getPath(req) {
  if (req.query && typeof req.query.path === 'string') return req.query.path;
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
    return req.body || {};
  } catch {
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

async function initSession() {
  const now = Date.now();
  if (globalSession && now - lastInitTime < SESSION_TTL_MS) {
    return globalSession;
  }

  console.log('Initializing new Asmodeus session...');

  const session = axios.create({
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      Connection: 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'sec-ch-ua':
        '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'Cache-Control': 'max-age=0',
    },
    maxRedirects: 10,
    timeout: 30000,
    validateStatus: () => true,
  });

  let mainPage;
  try {
    mainPage = await session.get('https://asmodeus.free.nf/');
  } catch (e) {
    throw new Error(`Network error reaching asmodeus.free.nf: ${e.message}`);
  }

  const bodyText = String(mainPage.data || '');
  console.log(`Main page status: ${mainPage.status}`);
  console.log(`Body preview: ${bodyText.slice(0, 400)}`);

  if (mainPage.status === 403) {
    throw new Error(
      'asmodeus.free.nf returned 403 Forbidden. The upstream may be blocking serverless/Vercel IPs.'
    );
  }

  if (mainPage.status !== 200) {
    throw new Error(
      `asmodeus.free.nf returned HTTP ${mainPage.status}. Body: ${bodyText.slice(0, 200)}`
    );
  }

  const matches = bodyText.match(/toNumbers("([a-f0-9]+)")/gi);
  if (!matches || matches.length < 3) {
    throw new Error(
      `Could not find AES params in upstream HTML. Body starts: ${bodyText.slice(0, 300)}`
    );
  }

  const nums = matches.map((m) => {
    const found = m.match(/([a-f0-9]+)/i);
    return found ? found[1] : '';
  });

  if (nums.some((v) => !v)) {
    throw new Error('Failed to extract one or more AES parameters.');
  }

  const key = CryptoJS.enc.Hex.parse(nums[0]);
  const iv = CryptoJS.enc.Hex.parse(nums[1]);
  const data = CryptoJS.enc.Hex.parse(nums[2]);

  let decrypted = '';
  try {
    decrypted = CryptoJS.AES.decrypt({ ciphertext: data }, key, { iv }).toString(
      CryptoJS.enc.Utf8
    );
  } catch (e) {
    throw new Error(`AES decrypt threw: ${e.message}`);
  }

  if (!decrypted) {
    throw new Error('AES decryption returned an empty cookie value.');
  }

  session.defaults.headers.Cookie = `__test=${decrypted}`;
  session.defaults.headers.Referer = 'https://asmodeus.free.nf/';
  session.defaults.headers.Origin = 'https://asmodeus.free.nf';

  const confirm = await session.get('https://asmodeus.free.nf/index.php?i=1');
  console.log(`Session confirm status: ${confirm.status}`);

  globalSession = session;
  lastInitTime = now;

  return session;
}

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

  reqCleanup(res, () => clearInterval(interval));
}

function reqCleanup(res, fn) {
  res.on('close', fn);
  res.on('finish', fn);
  res.on('error', fn);
}

async function handleChat(req, res) {
  const body = safeJsonBody(req, res);
  if (!body) return;

  const { model = 'DeepSeek-V3', messages, stream = false } = body;

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
        message: 'messages array is required and must not be empty',
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
          message: 'Each message.role must be system, user, or assistant',
          type: 'invalid_request_error',
        },
      });
    }

    const content = normalizeMessageContent(m.content);
    if (!content) {
      return res.status(400).json({
        error: {
          message: 'Each message.content must be a non-empty string or text parts array',
          type: 'invalid_request_error',
        },
      });
    }
  }

  const historyPrompt = buildPrompt(messages);
  const session = await initSession();

  const upstream = await session.post(
    'https://asmodeus.free.nf/deepseek.php',
    { model, question: historyPrompt },
    {
      params: { i: '1' },
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'text/html,application/json,*/*',
      },
      validateStatus: () => true,
    }
  );

  console.log(`deepseek.php status: ${upstream.status}`);
  const rawBody =
    typeof upstream.data === 'string'
      ? upstream.data
      : JSON.stringify(upstream.data || {});
  console.log(`deepseek.php body (500): ${rawBody.slice(0, 500)}`);

  if (upstream.status === 403) {
    throw new Error('Upstream returned 403 Forbidden.');
  }

  if (upstream.status >= 500) {
    throw new Error(`Upstream server error: HTTP ${upstream.status}`);
  }

  let content = '';
  const match = rawBody.match(/<div class="response-content">([sS]*?)</div>/i);

  if (match && match[1]) {
    content = stripHtml(match[1]);
  } else {
    content = stripHtml(rawBody);
  }

  if (!content) {
    throw new Error('Empty content from upstream');
  }

  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    return simulateStream(res, content, model);
  }

  const promptTokens = estimateTokens(historyPrompt);
  const completionTokens = estimateTokens(content);

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
      message: 'DeepSeek Proxy is running',
      endpoints: {
        models: 'GET /v1/models',
        chat: 'POST /v1/chat/completions',
      },
    });
  }

  if (req.method === 'GET' && path.endsWith('/v1/models')) {
    return res.status(200).json({
      object: 'list',
      data: MODELS.map((m) => ({
        id: m,
        object: 'model',
        created: 1710000000,
        owned_by: 'deepseek',
      })),
    });
  }

  if (req.method === 'POST' && path.endsWith('/v1/chat/completions')) {
    try {
      return await handleChat(req, res);
    } catch (error) {
      console.error('Proxy error:', error.message);
      globalSession = null;

      return res.status(500).json({
        error: {
          message: error.message || 'Internal proxy error',
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