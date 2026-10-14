import assert from 'node:assert/strict';
import test from 'node:test';

import {buildRefineMessages} from '../src/prompt.js';
import {
  DEFAULT_INPUT_TOKEN_LIMIT,
  estimateCharsPerToken,
  isInputTokenLimitError,
  parseTokenLimitError,
  requestReviewWithSplit,
  splitUnifiedDiff
} from '../src/splitReview.js';

test('detects yangyang input token limit errors', () => {
  const err = new Error(
    'yangyang API error (HTTP 400): Total tokens exceed the input max tokens limit. 423081 > 32768'
  );
  assert.equal(isInputTokenLimitError(err), true);
  const parsed = parseTokenLimitError(err);
  assert.equal(parsed.actual, 423081);
  assert.equal(parsed.limit, 32768);
});

test('falls back to default limit when numbers missing', () => {
  const parsed = parseTokenLimitError(
    new Error('yangyang API error (HTTP 400): input max tokens limit exceeded')
  );
  assert.equal(parsed.actual, null);
  assert.equal(parsed.limit, DEFAULT_INPUT_TOKEN_LIMIT);
});

test('splitUnifiedDiff packs files under maxChars', () => {
  const diff = [
    'diff --git a/a.js b/a.js\n+aaa\n',
    'diff --git a/b.js b/b.js\n+bbb\n',
    'diff --git a/c.js b/c.js\n+ccc\n'
  ].join('');
  const chunks = splitUnifiedDiff(diff, 80);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every((c) => c.length <= 80 || c.includes('diff --git')));
  assert.ok(chunks.join('').includes('a.js'));
  assert.ok(chunks.join('').includes('c.js'));
});

test('splitUnifiedDiff hard-splits oversized single file', () => {
  const huge = `diff --git a/big.js b/big.js\n${'+x'.repeat(5000)}\n`;
  const chunks = splitUnifiedDiff(huge, 200);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 200));
});

test('estimateCharsPerToken uses observed ratio', () => {
  assert.equal(estimateCharsPerToken(4000, 1000), 4);
  assert.ok(estimateCharsPerToken(0, 1000) === 4);
});

test('buildRefineMessages asks for one final ycr-findings block', () => {
  const messages = buildRefineMessages({
    owner: 'acme',
    repo: 'app',
    eventName: 'pull_request',
    partials: ['report A', 'report B'],
    includeSystem: false
  });
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /merging 2 partial/);
  assert.match(messages[0].content, /ycr-findings/);
  assert.match(messages[0].content, /partial_report index="1"/);
});

test('requestReviewWithSplit retries via chunks then refine on token limit', async () => {
  let calls = 0;
  const fetchImpl = async (_url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    const user = body.messages.find((m) => m.role === 'user')?.content || '';
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({
            error: {
              message:
                'Total tokens exceed the input max tokens limit. 20000 > 1000'
            }
          });
        }
      };
    }
    const isRefine = user.includes('merging') && user.includes('partial');
    const content = isRefine
      ? '# Final\n```ycr-findings\n[]\n```'
      : `# Part\n${user.slice(0, 40)}\n\`\`\`ycr-findings\n[]\n\`\`\``;
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          choices: [{message: {content}}]
        });
      }
    };
  };

  const file = (name, n) =>
    `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n${'+line\n'.repeat(n)}`;
  const diff = file('a.js', 80) + file('b.js', 80) + file('c.js', 80);

  const events = [];
  const result = await requestReviewWithSplit({
    config: {
      name: 'yangyang',
      protocol: 'openai',
      apiKey: 'k',
      baseUrl: 'https://example.test/v1'
    },
    model: 'auto',
    maxTokens: 256,
    owner: 'acme',
    repo: 'app',
    eventName: 'pull_request',
    diff,
    includeSystem: false,
    maxAttempts: 1,
    fetchImpl,
    onSplit: (info) => events.push(['split', info.chunkCount]),
    onPart: (info) => events.push(['part', info.index]),
    onRefine: (info) => events.push(['refine', info.partialCount])
  });

  assert.match(result, /Final|ycr-findings/);
  assert.ok(calls >= 3, `expected split+parts+refine, got ${calls} calls`);
  assert.ok(events.some(([k]) => k === 'split'));
  assert.ok(events.some(([k]) => k === 'refine'));
});
