import {buildRefineMessages, buildReviewMessages} from './prompt.js';
import {requestReview} from './providers.js';

const TOKEN_LIMIT_RE =
  /Total tokens exceed the input max tokens limit\.\s*(\d+)\s*>\s*(\d+)/i;
const TOKEN_LIMIT_LOOSE_RE = /input max tokens limit/i;

/** Default yangyang / agent input ceiling when the error omits numbers. */
export const DEFAULT_INPUT_TOKEN_LIMIT = 32768;

/** Leave headroom for prompt wrapper + model variance. */
const SAFETY_RATIO = 0.8;

/**
 * Hard cap on diff / refine text per call.
 * Workers Free kills ~100KB `/v1/agents` bodies (`exceededCpu`). 32KB stays near parts that completed.
 */
export const MAX_PART_CHARS = 32_000;

export function isInputTokenLimitError(error) {
  const message = String(error?.message || error || '');
  return TOKEN_LIMIT_RE.test(message) || TOKEN_LIMIT_LOOSE_RE.test(message);
}

export function parseTokenLimitError(error) {
  const message = String(error?.message || error || '');
  const match = message.match(TOKEN_LIMIT_RE);
  if (!match) {
    return {
      actual: null,
      limit: DEFAULT_INPUT_TOKEN_LIMIT,
      message
    };
  }
  return {
    actual: Number(match[1]),
    limit: Number(match[2]),
    message
  };
}

/** Rough chars/token from the failed request (fallback ~4). */
export function estimateCharsPerToken(messageChars, actualTokens) {
  if (!actualTokens || actualTokens < 1 || !messageChars || messageChars < 1) {
    return 4;
  }
  return Math.max(1, messageChars / actualTokens);
}

export function measureMessagesChars(messages) {
  return (messages || []).reduce(
    (sum, message) => sum + String(message?.content || '').length,
    0
  );
}

/**
 * Split a unified diff into chunks under maxChars.
 * Prefers file boundaries (`diff --git`); oversized files split by lines.
 */
export function splitUnifiedDiff(diff, maxChars) {
  const text = String(diff || '');
  if (!text.trim()) return [];
  if (maxChars < 64) {
    throw new Error(`maxChars too small for split (${maxChars})`);
  }
  if (text.length <= maxChars) return [text];

  const files = text.split(/(?=^diff --git )/m).filter((part) => part.trim());
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current.trim()) {
      chunks.push(current);
      current = '';
    }
  };

  const pushPiece = (piece) => {
    if (!piece.trim()) return;
    if (piece.length > maxChars) {
      flush();
      for (const lineChunk of splitByLines(piece, maxChars)) {
        chunks.push(lineChunk);
      }
      return;
    }
    if (!current) {
      current = piece;
      return;
    }
    if (current.length + piece.length <= maxChars) {
      current += piece;
      return;
    }
    flush();
    current = piece;
  };

  for (const file of files.length ? files : [text]) {
    pushPiece(file);
  }
  flush();
  return chunks;
}

function splitByLines(text, maxChars) {
  const lines = text.split('\n');
  const out = [];
  let buf = '';
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length <= maxChars) {
      buf = next;
      continue;
    }
    if (buf) out.push(buf);
    if (line.length > maxChars) {
      // Hard-split a single enormous line.
      for (let i = 0; i < line.length; i += maxChars) {
        out.push(line.slice(i, i + maxChars));
      }
      buf = '';
    } else {
      buf = line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function maxDiffCharsForLimit({
  limit,
  charsPerToken,
  overheadChars,
  safetyRatio = SAFETY_RATIO
}) {
  const budgetChars = Math.floor(limit * safetyRatio * charsPerToken);
  const fitted = Math.max(1024, budgetChars - Math.max(0, overheadChars));
  return Math.min(fitted, MAX_PART_CHARS);
}

/** Greedy groups whose combined text stays under maxChars. A single oversized item stays alone. */
export function packByChars(items, maxChars) {
  const groups = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const text = String(item ?? '');
    const len = text.length;
    if (current.length > 0 && size + len > maxChars) {
      groups.push(current);
      current = [];
      size = 0;
    }
    current.push(text);
    size += len;
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Review a large diff: on input-token 400, split → N reviews → one refine pass.
 */
export async function requestReviewWithSplit({
  config,
  model,
  temperature,
  maxTokens,
  agent,
  owner,
  repo,
  eventName,
  diff,
  includeSystem,
  timeoutMs,
  maxAttempts,
  fetchImpl,
  onRetry,
  onSplit,
  onPart,
  onPartError,
  onRefine
}) {
  const buildMessages = (chunk, partLabel) =>
    buildReviewMessages({
      owner,
      repo,
      eventName,
      diff: chunk,
      includeSystem,
      partLabel
    });

  const baseMessages = buildMessages(diff);
  try {
    return await requestReview({
      config,
      model,
      temperature,
      maxTokens,
      agent,
      messages: baseMessages,
      timeoutMs,
      maxAttempts,
      fetchImpl,
      onRetry
    });
  } catch (error) {
    if (!isInputTokenLimitError(error)) {
      throw error;
    }

    const {actual, limit} = parseTokenLimitError(error);
    const messageChars = measureMessagesChars(baseMessages);
    const charsPerToken = estimateCharsPerToken(messageChars, actual);
    const overheadChars = Math.max(0, messageChars - String(diff).length);
    let maxDiffChars = maxDiffCharsForLimit({
      limit,
      charsPerToken,
      overheadChars
    });

    let chunks = splitUnifiedDiff(diff, maxDiffChars);
    // If estimate was too optimistic and we still got 1 huge chunk, tighten.
    if (chunks.length === 1 && chunks[0].length > maxDiffChars) {
      maxDiffChars = Math.max(1024, Math.floor(maxDiffChars * 0.5));
      chunks = splitUnifiedDiff(diff, maxDiffChars);
    }
    if (chunks.length < 2) {
      // Still one piece — force line split at half budget.
      maxDiffChars = Math.max(1024, Math.floor(maxDiffChars * 0.5));
      chunks = splitUnifiedDiff(diff, maxDiffChars);
    }
    if (chunks.length < 2) {
      throw error;
    }

    onSplit?.({
      actual,
      limit,
      chunkCount: chunks.length,
      maxDiffChars
    });

    const partials = [];
    let lastPartError = null;
    for (let i = 0; i < chunks.length; i += 1) {
      const index = i + 1;
      const partLabel = `${index}/${chunks.length}`;
      onPart?.({index, total: chunks.length, chars: chunks[i].length});
      try {
        const partContent = await requestReview({
          config,
          model,
          temperature,
          maxTokens,
          agent,
          messages: buildMessages(chunks[i], partLabel),
          timeoutMs,
          maxAttempts,
          fetchImpl,
          onRetry
        });
        if (String(partContent || '').trim()) {
          partials.push(partContent);
        }
      } catch (partError) {
        lastPartError = partError;
        onPartError?.({
          index,
          total: chunks.length,
          error: partError
        });
      }
    }
    if (partials.length === 0) {
      throw lastPartError || error;
    }

    return refinePartials(partials, {
      config,
      model,
      temperature,
      maxTokens,
      agent,
      owner,
      repo,
      eventName,
      includeSystem,
      timeoutMs,
      maxAttempts,
      fetchImpl,
      onRetry,
      onRefine
    });
  }
}

async function refinePartials(partials, ctx) {
  let current = partials.slice();
  while (current.length > 1) {
    const groups = packByChars(current, MAX_PART_CHARS);
    const stuck = groups.length === current.length && groups.every((group) => group.length === 1);
    if (groups.length === 1 || stuck) {
      ctx.onRefine?.({partialCount: current.length});
      return requestReview({
        config: ctx.config,
        model: ctx.model,
        temperature: ctx.temperature,
        maxTokens: ctx.maxTokens,
        agent: ctx.agent,
        messages: buildRefineMessages({
          owner: ctx.owner,
          repo: ctx.repo,
          eventName: ctx.eventName,
          partials: current,
          includeSystem: ctx.includeSystem
        }),
        timeoutMs: ctx.timeoutMs,
        maxAttempts: ctx.maxAttempts,
        fetchImpl: ctx.fetchImpl,
        onRetry: ctx.onRetry
      });
    }
    const next = [];
    for (const group of groups) {
      if (group.length === 1) {
        next.push(group[0]);
        continue;
      }
      ctx.onRefine?.({partialCount: group.length});
      next.push(
        await requestReview({
          config: ctx.config,
          model: ctx.model,
          temperature: ctx.temperature,
          maxTokens: ctx.maxTokens,
          agent: ctx.agent,
          messages: buildRefineMessages({
            owner: ctx.owner,
            repo: ctx.repo,
            eventName: ctx.eventName,
            partials: group,
            includeSystem: ctx.includeSystem
          }),
          timeoutMs: ctx.timeoutMs,
          maxAttempts: ctx.maxAttempts,
          fetchImpl: ctx.fetchImpl,
          onRetry: ctx.onRetry
        })
      );
    }
    current = next;
  }
  return current[0];
}
