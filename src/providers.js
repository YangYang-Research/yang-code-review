import fetch from 'node-fetch';

const PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai'
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic'
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    protocol: 'google'
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    protocol: 'openai'
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    protocol: 'openai'
  }
};

const RETRYABLE_STATUS_CODES = new Set([408, 409, 425, 429]);

function normalizeProvider(provider) {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'nvida' ? 'nvidia' : normalized;
}

export function resolveProviderConfig({provider, apiKey}) {
  const name = normalizeProvider(provider);
  const definition = PROVIDERS[name];
  if (!definition) {
    throw new Error(
      `Unsupported PROVIDER "${provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}`
    );
  }

  if (!apiKey) {
    throw new Error(`API_KEY is required for provider "${name}"`);
  }

  return {
    name,
    protocol: definition.protocol,
    apiKey,
    baseUrl: definition.baseUrl
  };
}

function createOpenAIRequest(config, {model, temperature, maxTokens, messages}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'github-actions/yang-code-review'
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  if (config.name === 'openrouter') {
    headers['x-openrouter-title'] = 'Yang Code Review';
  }

  const body = {
    model,
    messages,
    stream: false
  };
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  if (config.name === 'openai') {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  return {
    url: `${config.baseUrl}/chat/completions`,
    headers,
    body
  };
}

function createAnthropicRequest(config, {model, temperature, maxTokens, messages}) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation = messages.filter((message) => message.role !== 'system');

  const body = {
    model,
    system,
    messages: conversation,
    max_tokens: maxTokens
  };
  if (temperature !== undefined) {
    body.temperature = temperature;
  }

  return {
    url: `${config.baseUrl}/messages`,
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.apiKey,
      'anthropic-version': '2023-06-01',
      'user-agent': 'github-actions/yang-code-review'
    },
    body
  };
}

function createGoogleRequest(config, {model, temperature, maxTokens, messages}) {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{text: message.content}]
    }));

  const generationConfig = {
    maxOutputTokens: maxTokens
  };
  if (temperature !== undefined) {
    generationConfig.temperature = temperature;
  }

  return {
    url: `${config.baseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': config.apiKey,
      'user-agent': 'github-actions/yang-code-review'
    },
    body: {
      systemInstruction: {parts: [{text: systemText}]},
      contents,
      generationConfig
    }
  };
}

export function createProviderRequest(config, options) {
  if (config.protocol === 'anthropic') {
    return createAnthropicRequest(config, options);
  }
  if (config.protocol === 'google') {
    return createGoogleRequest(config, options);
  }
  return createOpenAIRequest(config, options);
}

function extractTextParts(parts) {
  if (!Array.isArray(parts)) {
    return '';
  }
  return parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n');
}

export function parseProviderResponse(config, payload) {
  let content = '';
  if (config.protocol === 'anthropic') {
    content = extractTextParts(payload?.content);
  } else if (config.protocol === 'google') {
    content = extractTextParts(payload?.candidates?.[0]?.content?.parts);
  } else {
    const messageContent = payload?.choices?.[0]?.message?.content;
    content =
      typeof messageContent === 'string'
        ? messageContent
        : extractTextParts(messageContent);
  }

  if (!content.trim()) {
    throw new Error(`${config.name} returned no review content`);
  }
  return content.trim();
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status) || status >= 500;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function requestReview({
  config,
  model,
  temperature,
  maxTokens,
  messages,
  timeoutMs = 300000,
  maxAttempts = 3,
  fetchImpl = fetch,
  onRetry = () => {}
}) {
  const request = createProviderRequest(config, {
    model,
    temperature,
    maxTokens,
    messages
  });
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST',
        signal: controller.signal,
        headers: request.headers,
        body: JSON.stringify(request.body)
      });
      const responseText = await response.text();
      let payload;
      try {
        payload = JSON.parse(responseText);
      } catch {
        const error = new Error(
          `${config.name} returned a non-JSON response (HTTP ${response.status})`
        );
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }

      if (!response.ok) {
        const detail =
          payload?.error?.message || payload?.message || responseText.slice(0, 500);
        const error = new Error(
          `${config.name} API error (HTTP ${response.status}): ${detail}`
        );
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }

      return parseProviderResponse(config, payload);
    } catch (error) {
      const isAbort = error.name === 'AbortError';
      lastError = isAbort
        ? new Error(`${config.name} request timed out after ${timeoutMs}ms`)
        : error;
      const retryable = isAbort || error.retryable || error.code === 'ECONNRESET';
      if (!retryable || attempt === maxAttempts) {
        throw lastError;
      }
      onRetry(attempt, maxAttempts, lastError);
      await sleep(attempt * 2000);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}
