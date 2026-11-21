// ============================================================================
// AI PRO STUDIO — Secure Node.js AI Proxy & Static Server (Zero External Deps)
// Supports: Google Gemini Image API, OpenAI (gpt-image-1), and Replicate.
// Keeps secret API keys strictly in .env on your server — never in browser code.
// ============================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');

// Minimal .env loader (zero external dependencies)
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq > 0) {
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  });
}

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 30 * 1024 * 1024; // 30 MB limit for high-res DSLR/Gallery photos
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Payload exceeds 30MB limit.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (_) {
        reject(new Error('Invalid JSON payload.'));
      }
    });
    req.on('error', reject);
  });
}

function validateImageDataUrl(dataUrl) {
  if (!dataUrl) return true;
  return typeof dataUrl === 'string' && /^data:image\/(png|jpeg|jpg|webp);base64,/.test(dataUrl);
}

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/.exec(dataUrl || '');
  if (!m) return null;
  return { mimeType: m[1] === 'image/jpg' ? 'image/jpeg' : m[1], base64: m[2] };
}

function buildTaskPrompt(taskType, body) {
  if (body.prompt && String(body.prompt).trim()) return String(body.prompt).trim();
  switch (taskType) {
    case 'virtual-try-on':
      return `Edit this portrait photo to dress the person in a realistic ${body.color || ''} ${body.fabric || ''} ${body.outfit || 'stylish outfit'}. Preserve the exact face, pose, skin tone, hands, and background naturally.`;
    case 'hairstyle':
      return `Edit this portrait photo to give the person a realistic ${body.hairstyle || 'modern'} hairstyle${body.hairColor ? ' in ' + body.hairColor + ' color' : ''}. Keep the face, expression, clothing, and background identical.`;
    case 'enhance':
      return `Professionally enhance this photo (${body.mode || '4x studio quality'}): sharpen fine details, balance exposure and skin tones naturally, reduce noise, and maintain authentic facial features.`;
    case 'background-generate':
      return 'Photorealistic high-resolution studio photography backdrop, soft cinematic lighting, shallow depth of field.';
    default:
      return 'Enhance photography lighting, clarity, and color balance naturally.';
  }
}

// 1) Google Gemini Image Editing & Generation Adapter (supports ALL 5 tasks!)
async function callGeminiImage(taskType, body) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
  const prompt = buildTaskPrompt(taskType, body);

  const parts = [{ text: prompt }];
  const mainImg = parseDataUrl(body.imageDataUrl);
  if (mainImg) {
    parts.push({ inline_data: { mime_type: mainImg.mimeType, data: mainImg.base64 } });
  }
  const garmentImg = parseDataUrl(body.garmentDataUrl);
  if (garmentImg) {
    parts.push({ inline_data: { mime_type: garmentImg.mimeType, data: garmentImg.base64 } });
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { status: resp.status, payload: { ok: false, error: data.error?.message || `Gemini API error (HTTP ${resp.status})` } };
  }
  const resParts = data.candidates?.[0]?.content?.parts || [];
  const imgPart = resParts.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (imgPart) {
    const inline = imgPart.inlineData || imgPart.inline_data;
    const mime = inline.mimeType || inline.mime_type || 'image/png';
    return { status: 200, payload: { ok: true, imageDataUrl: `data:${mime};base64,${inline.data}`, meta: { provider: 'gemini', model } } };
  }
  return { status: 502, payload: { ok: false, error: 'Gemini did not return an edited image. Try rephrasing your prompt.' } };
}

// 2) OpenAI Image Edit & Generation Adapter (gpt-image-1)
async function callOpenAIImage(taskType, body) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
  const prompt = buildTaskPrompt(taskType, body);
  const mainImg = parseDataUrl(body.imageDataUrl);

  let resp;
  if (mainImg && taskType !== 'background-generate') {
    const form = new FormData();
    form.append('model', model);
    form.append('prompt', prompt);
    form.append('size', '1024x1024');
    const buf = Buffer.from(mainImg.base64, 'base64');
    form.append('image', new Blob([buf], { type: mainImg.mimeType }), 'input.png');
    resp = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form
    });
  } else {
    resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, prompt, size: '1024x1024' })
    });
  }

  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { status: resp.status, payload: { ok: false, error: data.error?.message || `OpenAI API error (HTTP ${resp.status})` } };
  }
  const b64 = data.data?.[0]?.b64_json;
  if (b64) {
    return { status: 200, payload: { ok: true, imageDataUrl: `data:image/png;base64,${b64}`, meta: { provider: 'openai', model } } };
  }
  const url = data.data?.[0]?.url;
  if (url) {
    const imgRes = await fetch(url);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { status: 200, payload: { ok: true, imageDataUrl: `data:image/png;base64,${buf.toString('base64')}`, meta: { provider: 'openai', model } } };
  }
  return { status: 502, payload: { ok: false, error: 'OpenAI returned no image data.' } };
}

// 3) Replicate Adapter (IDM-VTON, Real-ESRGAN, Flux/SDXL)
async function callReplicateImage(taskType, body) {
  const version = process.env.REPLICATE_MODEL_VERSION;
  const resp = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.REPLICATE_API_TOKEN}`,
      Prefer: 'wait=60'
    },
    body: JSON.stringify({
      version,
      input: {
        image: body.imageDataUrl,
        prompt: buildTaskPrompt(taskType, body)
      }
    })
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    return { status: resp.status, payload: { ok: false, error: data.detail || `Replicate API error (HTTP ${resp.status})` } };
  }
  const outUrl = Array.isArray(data.output) ? data.output[0] : data.output;
  if (outUrl) {
    const imgRes = await fetch(outUrl);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return { status: 200, payload: { ok: true, imageDataUrl: `data:image/png;base64,${buf.toString('base64')}`, meta: { provider: 'replicate' } } };
  }
  return { status: 502, payload: { ok: false, error: 'Replicate returned no output image.' } };
}

async function handleAITask(taskType, body) {
  if (!validateImageDataUrl(body.imageDataUrl) || !validateImageDataUrl(body.garmentDataUrl)) {
    return { status: 400, payload: { ok: false, error: 'Unsupported or malformed image data URL. Only PNG, JPEG, and WebP are allowed.' } };
  }

  // Respect requested provider when configured, otherwise auto-route to any available key
  const pref = body.provider || 'custom-proxy';
  if (pref === 'openai-proxy' && process.env.OPENAI_API_KEY) return callOpenAIImage(taskType, body);
  if (pref === 'replicate-proxy' && process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_MODEL_VERSION) return callReplicateImage(taskType, body);

  if (process.env.GEMINI_API_KEY) return callGeminiImage(taskType, body);
  if (process.env.OPENAI_API_KEY) return callOpenAIImage(taskType, body);
  if (process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_MODEL_VERSION) return callReplicateImage(taskType, body);

  return {
    status: 503,
    payload: {
      ok: false,
      error: `No AI API key configured on server for "${taskType}". Add GEMINI_API_KEY, OPENAI_API_KEY, or REPLICATE_API_TOKEN in your .env (or Render Environment Variables) and restart.`
    }
  };
}

function getActiveProviders() {
  const list = [];
  if (process.env.GEMINI_API_KEY) list.push('gemini');
  if (process.env.OPENAI_API_KEY) list.push('openai');
  if (process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_MODEL_VERSION) list.push('replicate');
  return list;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const urlPath = (req.url || '/').split('?')[0];

  if (req.method === 'GET' && urlPath === '/api/health') {
    const providers = getActiveProviders();
    sendJson(res, 200, {
      ok: true,
      service: 'AI Pro Studio Node.js Proxy',
      provider: providers.length ? providers.join(', ') : 'local-only (add API key in .env)',
      configured: providers.length > 0,
      endpoints: ['/api/health', '/api/ai/background-generate', '/api/ai/virtual-try-on', '/api/ai/hairstyle', '/api/ai/enhance', '/api/ai/prompt-edit']
    });
    return;
  }

  if (req.method === 'POST' && urlPath.startsWith('/api/ai/')) {
    const taskType = decodeURIComponent(urlPath.slice('/api/ai/'.length));
    try {
      const body = await readJsonBody(req);
      const result = await handleAITask(taskType, body);
      sendJson(res, result.status, result.payload);
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message || 'Bad Request' });
    }
    return;
  }

  // Serve static frontend from /public (includes latest AI_PRO_STUDIO.html as index.html)
  const safePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '').replace(/\.\./g, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);
  if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
    const ext = path.extname(fullPath).toLowerCase();
    const mime = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.json' ? 'application/json; charset=utf-8'
      : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'Not Found' });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    const providers = getActiveProviders();
    console.log(`AI PRO STUDIO Node.js Proxy running on http://localhost:${PORT}`);
    console.log(`Configured Cloud AI Providers: ${providers.length ? providers.join(', ') : 'None yet (add GEMINI_API_KEY / OPENAI_API_KEY in .env)'}`);
  });
}

module.exports = { server, validateImageDataUrl, buildTaskPrompt };
