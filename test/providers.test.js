import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderRequest,
  parseProviderResponse,
  requestReview,
  resolveProviderConfig
} from '../src/providers.js';

const messages = [
  {role: 'system', content: 'Review code.'},
  {role: 'user', content: 'diff --git a/a.js b/a.js'}
];

test('resolves hardcoded provider base URLs', () => {
  const openai = resolveProviderConfig({
    provider: 'openai',
    apiKey: 'secret'
  });
  assert.equal(openai.baseUrl, 'https://api.openai.com/v1');
  assert.equal(openai.protocol, 'openai');

  const anthropic = resolveProviderConfig({
    provider: 'anthropic',
    apiKey: 'secret'
  });
  assert.equal(anthropic.baseUrl, 'https://api.anthropic.com/v1');

  const google = resolveProviderConfig({
    provider: 'google',
    apiKey: 'secret'
  });
  assert.equal(
    google.baseUrl,
    'https://generativelanguage.googleapis.com/v1beta'
  );

  const nvidia = resolveProviderConfig({
    provider: 'nvidia',
    apiKey: 'secret'
  });
  assert.equal(nvidia.baseUrl, 'https://integrate.api.nvidia.com/v1');

  const openrouter = resolveProviderConfig({
    provider: 'openrouter',
    apiKey: 'secret'
  });
  assert.equal(openrouter.baseUrl, 'https://openrouter.ai/api/v1');
});

test('rejects unsupported providers and missing keys', () => {
  assert.throws(
    () => resolveProviderConfig({provider: 'custom', apiKey: 'secret'}),
    /Unsupported PROVIDER/
  );
  assert.throws(
    () => resolveProviderConfig({provider: 'openai', apiKey: ''}),
    /API_KEY is required/
  );
});

test('creates Anthropic request format', () => {
  const config = resolveProviderConfig({
    provider: 'anthropic',
    apiKey: 'secret'
  });
  const request = createProviderRequest(config, {
    model: 'claude-sonnet-4-5',
    temperature: 0.2,
    maxTokens: 2048,
    messages
  });

  assert.equal(request.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(request.headers['x-api-key'], 'secret');
  assert.equal(request.body.system, 'Review code.');
  assert.deepEqual(request.body.messages, [messages[1]]);
  assert.equal(request.body.max_tokens, 2048);
});

test('creates Google request format', () => {
  const config = resolveProviderConfig({
    provider: 'google',
    apiKey: 'secret'
  });
  const request = createProviderRequest(config, {
    model: 'gemini-2.5-pro',
    temperature: 0.1,
    maxTokens: 1024,
    messages
  });

  assert.equal(
    request.url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'
  );
  assert.equal(request.headers['x-goog-api-key'], 'secret');
  assert.equal(request.body.systemInstruction.parts[0].text, 'Review code.');
  assert.equal(request.body.contents[0].parts[0].text, messages[1].content);
});

test('parses response formats', () => {
  assert.equal(
    parseProviderResponse(
      {name: 'openai', protocol: 'openai'},
      {choices: [{message: {content: 'OpenAI review'}}]}
    ),
    'OpenAI review'
  );
  assert.equal(
    parseProviderResponse(
      {name: 'anthropic', protocol: 'anthropic'},
      {content: [{type: 'text', text: 'Anthropic review'}]}
    ),
    'Anthropic review'
  );
  assert.equal(
    parseProviderResponse(
      {name: 'google', protocol: 'google'},
      {candidates: [{content: {parts: [{text: 'Google review'}]}}]}
    ),
    'Google review'
  );
});

test('sends an OpenAI-compatible request and returns review text', async () => {
  const config = resolveProviderConfig({
    provider: 'nvidia',
    apiKey: 'secret'
  });
  let captured;
  const fetchImpl = async (url, options) => {
    captured = {url, options};
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({choices: [{message: {content: 'NVIDIA review'}}]})
    };
  };

  const result = await requestReview({
    config,
    model: 'meta/llama',
    temperature: 0.2,
    maxTokens: 1000,
    messages,
    fetchImpl
  });

  assert.equal(result, 'NVIDIA review');
  assert.equal(
    captured.url,
    'https://integrate.api.nvidia.com/v1/chat/completions'
  );
  assert.equal(captured.options.headers.authorization, 'Bearer secret');
});
