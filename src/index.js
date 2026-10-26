import * as core from '@actions/core';
import * as github from '@actions/github';
import fs from 'fs';
import path from 'path';
import {resolveProviderConfig} from './providers.js';
import {requestReviewWithSplit} from './splitReview.js';
import {
  buildArtifactName,
  buildSarif,
  formatDependabotStyleComment,
  isGeneratedPath,
  parseFindings,
  reportDateStamp,
  resolveFindingPath
} from './sarif.js';

const AI_REVIEW_LABEL = 'ai-review';
const AI_REVIEW_LABEL_COLOR = '5319E7';
const AI_REVIEW_LABEL_DESCRIPTION = 'Reviewed by Yang Code Review (YCR)';

async function ensureAiReviewLabel(octokit, {owner, repo}) {
  try {
    await octokit.rest.issues.getLabel({
      owner,
      repo,
      name: AI_REVIEW_LABEL
    });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
    await octokit.rest.issues.createLabel({
      owner,
      repo,
      name: AI_REVIEW_LABEL,
      color: AI_REVIEW_LABEL_COLOR,
      description: AI_REVIEW_LABEL_DESCRIPTION
    });
  }
}

async function addAiReviewLabel(octokit, {owner, repo, issueNumber}) {
  await ensureAiReviewLabel(octokit, {owner, repo});
  await octokit.rest.issues.addLabels({
    owner,
    repo,
    issue_number: issueNumber,
    labels: [AI_REVIEW_LABEL]
  });
}

async function run() {
  try {
    const provider = core.getInput('PROVIDER', {required: true});
    const apiKey = core.getInput('API_KEY', {required: true});
    const modelName = core.getInput('MODEL_NAME', {required: true});
    const modelTemperature = core.getInput('MODEL_TEMPERATURE');
    const maxTokens = core.getInput('MAX_TOKENS') || '4096';
    const githubToken = core.getInput('GITHUB_TOKEN', {required: true});

    core.setSecret(apiKey);
    core.setSecret(githubToken);

    const providerConfig = resolveProviderConfig({
      provider,
      apiKey
    });

    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const octokit = github.getOctokit(githubToken);

    let diff;
    let isPushEvent = false;
    let commitSha = null;
    let pullNumber = null;

    if (context.payload.pull_request) {
      const pr = context.payload.pull_request;
      pullNumber = pr.number;
      commitSha = pr.head.sha;

      const diffResponse = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner,
          repo,
          pull_number: pullNumber,
          headers: {
            accept: 'application/vnd.github.v3.diff'
          }
        }
      );

      diff = diffResponse.data;
    } else if (context.eventName === 'push') {
      isPushEvent = true;
      commitSha = context.sha;
      const beforeSha = context.payload.before;
      const afterSha = context.payload.after;

      try {
        const compareResponse = await octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: beforeSha,
          head: afterSha
        });

        diff = '';
        for (const file of compareResponse.data.files || []) {
          diff += `diff --git a/${file.filename} b/${file.filename}\n`;
          diff += `index ${file.sha.substring(0, 7)}..${file.sha.substring(0, 7)} ${file.status}\n`;
          diff += `--- a/${file.filename}\n`;
          diff += `+++ b/${file.filename}\n`;
          if (file.patch) {
            diff += file.patch + '\n';
          }
        }
      } catch (error) {
        core.warning(`Failed to get diff from compareCommits: ${error.message}`);
        try {
          const commitResponse = await octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: commitSha
          });

          diff = '';
          for (const file of commitResponse.data.files || []) {
            diff += `diff --git a/${file.filename} b/${file.filename}\n`;
            if (file.patch) {
              diff += file.patch + '\n';
            }
          }
        } catch (commitError) {
          throw new Error(`Failed to get commit diff: ${commitError.message}`);
        }
      }
    } else {
      core.setFailed(
        `This action can only run on pull_request or push events. Current event: ${context.eventName}`
      );
      return;
    }

    if (!diff || diff.trim().length === 0) {
      core.info('No changes detected in the diff. Skipping code review.');
      return;
    }

    const parsedTemperature =
      modelTemperature === '' ? undefined : Number(modelTemperature);
    if (
      parsedTemperature !== undefined &&
      (!Number.isFinite(parsedTemperature) ||
        parsedTemperature < 0 ||
        parsedTemperature > 1)
    ) {
      throw new Error(
        `MODEL_TEMPERATURE must be a number between 0 and 1. Received: ${modelTemperature}`
      );
    }
    const parsedMaxTokens = Number(maxTokens);
    if (!Number.isInteger(parsedMaxTokens) || parsedMaxTokens < 1) {
      throw new Error(
        `MAX_TOKENS must be a positive integer. Received: ${maxTokens}`
      );
    }

    try {
      const useYangyangAgent = providerConfig.name === 'yangyang';
      const reviewContent = await requestReviewWithSplit({
        config: providerConfig,
        model: modelName,
        temperature: parsedTemperature,
        maxTokens: parsedMaxTokens,
        agent: useYangyangAgent ? 'yang-code-review' : undefined,
        owner,
        repo,
        eventName: context.eventName,
        diff,
        includeSystem: !useYangyangAgent,
        onRetry: (attempt, attempts, error) => {
          core.warning(
            `${providerConfig.name} attempt ${attempt}/${attempts} failed: ${error.message}. Retrying...`
          );
        },
        onSplit: ({actual, limit, chunkCount, maxDiffChars}) => {
          core.warning(
            `Input tokens exceed limit (${actual ?? '?'} > ${limit}). Splitting diff into ${chunkCount} parts (≈${maxDiffChars} chars/part), then refining.`
          );
        },
        onPart: ({index, total, chars}) => {
          core.info(`Reviewing split part ${index}/${total} (${chars} chars)…`);
        },
        onPartError: ({index, total, error}) => {
          core.warning(
            `Split part ${index}/${total} failed and was skipped: ${error.message}`
          );
        },
        onRefine: ({partialCount}) => {
          core.info(
            `Merging ${partialCount} partial reviews into one refined YCR report…`
          );
        }
      });

      console.log('\n\n=== Yang Code Review (YCR) Result ===');
      console.log(reviewContent);

      const dateStamp = reportDateStamp();
      const artifactName = buildArtifactName({
        date: dateStamp,
        pullNumber
      });
      const shortSha = commitSha.substring(0, 7);
      const mdFileName = `${artifactName}-${shortSha}.md`;
      const sarifFileName = `${artifactName}.sarif`;
      const mdPath = path.resolve(process.cwd(), mdFileName);
      const sarifPath = path.resolve(process.cwd(), sarifFileName);

      const header = isPushEvent
        ? `# 🤖 Yang Code Review (YCR)\n\n**Commit:** ${commitSha}\n**Repository:** ${owner}/${repo}\n**Date:** ${new Date().toISOString()}\n\n---\n\n`
        : `# 🤖 Yang Code Review (YCR)\n\n**Pull Request:** #${pullNumber}\n**Commit:** ${commitSha}\n**Repository:** ${owner}/${repo}\n**Date:** ${new Date().toISOString()}\n\n---\n\n`;

      const findings = parseFindings(reviewContent).map((f) => {
        const wasGenerated = isGeneratedPath(f.file);
        const resolved = resolveFindingPath(f.file, (p) =>
          fs.existsSync(path.resolve(process.cwd(), p))
        );
        // Drop huge-line pins on bundles (GitHub preview: "snippet too large/minified").
        const dropPin = wasGenerated && !resolved;
        return {
          ...f,
          file: resolved,
          line: dropPin ? undefined : f.line,
          endLine: dropPin ? undefined : f.endLine
        };
      });
      const sarif = buildSarif({
        findings,
        reportText: reviewContent,
        owner,
        repo,
        commitSha,
        fallbackUri: 'README.md'
      });
      const commentBody = formatDependabotStyleComment(findings, {
        reportText: reviewContent
      });
      const artifactBody = `${header}${commentBody}\n\n---\n\n## Full model report\n\n${reviewContent}\n`;

      fs.writeFileSync(mdPath, artifactBody, 'utf8');
      fs.writeFileSync(sarifPath, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8');
      core.setOutput('sarif_path', sarifPath);
      core.setOutput('md_path', mdPath);
      core.setOutput('artifact_name', artifactName);
      core.setOutput('findings_count', String(findings.length));

      if (!isPushEvent) {
        try {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: commentBody
          });
          console.log(`\n✅ Review posted as comment on PR #${pullNumber}`);
        } catch (commentError) {
          core.warning(`Failed to post comment on PR: ${commentError.message}`);
        }

        try {
          await addAiReviewLabel(octokit, {
            owner,
            repo,
            issueNumber: pullNumber
          });
          console.log(`\n✅ Added label "${AI_REVIEW_LABEL}" on PR #${pullNumber}`);
        } catch (labelError) {
          core.warning(
            `Failed to add "${AI_REVIEW_LABEL}" label: ${labelError.message}`
          );
        }
      }
    } catch (error) {
      core.setFailed(error.message);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
