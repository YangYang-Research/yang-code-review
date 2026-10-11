import * as core from '@actions/core';
import * as github from '@actions/github';
import {DefaultArtifactClient} from '@actions/artifact';
import fs from 'fs';
import path from 'path';
import {requestReview, resolveProviderConfig} from './providers.js';
import {buildReviewMessages} from './prompt.js';
import {
  buildArtifactName,
  buildSarif,
  parseFindings,
  reportDateStamp
} from './sarif.js';

async function uploadReportArtifact({artifact, name, files, cwd}) {
  const {id, size} = await artifact.uploadArtifact(name, files, cwd, {
    retentionDays: 90
  });
  console.log(`\n✅ Review saved as artifact: ${name} (id: ${id}, bytes: ${size})`);
  return {id, size};
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
    const artifact = new DefaultArtifactClient();

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
      const reviewContent = await requestReview({
        config: providerConfig,
        model: modelName,
        temperature: parsedTemperature,
        maxTokens: parsedMaxTokens,
        agent: useYangyangAgent ? 'yang-code-review' : undefined,
        messages: buildReviewMessages({
          owner,
          repo,
          eventName: context.eventName,
          diff,
          includeSystem: !useYangyangAgent
        }),
        onRetry: (attempt, attempts, error) => {
          core.warning(
            `${providerConfig.name} attempt ${attempt}/${attempts} failed: ${error.message}. Retrying...`
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

      const findings = parseFindings(reviewContent);
      const sarif = buildSarif({
        findings,
        reportText: reviewContent,
        owner,
        repo,
        commitSha
      });

      fs.writeFileSync(mdPath, `${header}${reviewContent}`, 'utf8');
      fs.writeFileSync(sarifPath, `${JSON.stringify(sarif, null, 2)}\n`, 'utf8');
      core.setOutput('sarif_path', sarifPath);
      core.setOutput('artifact_name', artifactName);
      core.setOutput('findings_count', String(findings.length));

      if (!isPushEvent) {
        try {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pullNumber,
            body: `## 🤖 Yang Code Review (YCR)\n\n${reviewContent}`
          });
          console.log(`\n✅ Review posted as comment on PR #${pullNumber}`);
        } catch (commentError) {
          core.warning(`Failed to post comment on PR: ${commentError.message}`);
        }
      }

      try {
        core.info(`Uploading artifact ${artifactName}`);
        await uploadReportArtifact({
          artifact,
          name: artifactName,
          files: [mdFileName, sarifFileName],
          cwd: process.cwd()
        });
      } catch (artifactError) {
        core.warning(`Failed to save artifact: ${artifactError.message}`);
      }
    } catch (error) {
      core.setFailed(error.message);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
