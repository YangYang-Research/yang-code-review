import * as core from '@actions/core';
import * as github from '@actions/github';
import {DefaultArtifactClient} from '@actions/artifact';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function isCloudflareBlockedResponse(text) {
  if (!text) {
    return false;
  }
  return (
    text.includes('Just a moment...') ||
    text.includes('_cf_chl_opt') ||
    text.includes('challenge-platform')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  try {
    // Mask sensitive input
    const apiToken = core.getInput('X_YANG_API_TOKEN', { required: true });
    const agentName = 'yang-code-review';
    const modelName = core.getInput('MODEL_NAME', { required: true });
    const modelTemperature = core.getInput('MODEL_TEMPERATURE', { required: true });
    const githubToken = core.getInput('GITHUB_TOKEN', { required: true });

    core.setSecret(apiToken);
    core.setSecret(githubToken);

    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const octokit = github.getOctokit(githubToken);
    const artifact = new DefaultArtifactClient();

    let diff;
    let isPushEvent = false;
    let commitSha = null;

    // Handle both pull_request and push events
    if (context.payload.pull_request) {
      // Pull request event
      const pr = context.payload.pull_request;
      const pull_number = pr.number;

      // Fetch PR diff
      const diffResponse = await octokit.request(
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        {
          owner,
          repo,
          pull_number,
          headers: {
            accept: 'application/vnd.github.v3.diff'
          }
        }
      );

      diff = diffResponse.data;
    } else if (context.eventName === 'push') {
      // Push event
      isPushEvent = true;
      commitSha = context.sha;
      const beforeSha = context.payload.before;
      const afterSha = context.payload.after;

      // Get the diff between before and after commits
      try {
        const compareResponse = await octokit.rest.repos.compareCommits({
          owner,
          repo,
          base: beforeSha,
          head: afterSha
        });

        // Build diff from the comparison
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
        // Fallback: try to get diff from the commit directly
        try {
          const commitResponse = await octokit.rest.repos.getCommit({
            owner,
            repo,
            ref: commitSha
          });
          
          // Build diff from commit files
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
      core.setFailed(`This action can only run on pull_request or push events. Current event: ${context.eventName}`);
      return;
    }

    // Check if diff is empty
    if (!diff || diff.trim().length === 0) {
      core.info('No changes detected in the diff. Skipping code review.');
      return;
    }

    // Call YangYang API with timeout (increased for streaming responses)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 minutes for streaming

    const chatSessionId = crypto.randomUUID();
    const parsedTemperature = Number(modelTemperature);
    if (!Number.isFinite(parsedTemperature) || parsedTemperature < 0 || parsedTemperature > 1) {
      throw new Error(`MODEL_TEMPERATURE must be a number between 0 and 1. Received: ${modelTemperature}`);
    }
    let apiResponse;
    let reviewContent;
    try {
      const maxAttempts = 3;
      let lastError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        apiResponse = await fetch('https://api.yyng.icu/ycre/v1/code-review/github/completions', {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-yang-api-token': `Basic ${apiToken}`,
            'user-agent': 'github-actions/yang-code-review'
          },
          body: JSON.stringify({
            model_name: modelName,
            temperature: parsedTemperature,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `Repository: ${owner}/${repo}\nEvent: ${context.eventName}\nAgent: ${agentName}\nChat Session: ${chatSessionId}\n\nUnified Diff:\n${diff}`
                  }
                ]
              }
            ]
          })
        });

        const responseText = await apiResponse.text();
        if (!apiResponse.ok) {
          if (isCloudflareBlockedResponse(responseText)) {
            lastError = new Error('API request was blocked by Cloudflare protection. The API endpoint may be temporarily unavailable or require additional authentication.');
          } else {
            lastError = new Error(`YangYang API error: ${apiResponse.status} - ${responseText.substring(0, 500)}`);
          }
        } else if (isCloudflareBlockedResponse(responseText)) {
          lastError = new Error('API request was blocked by Cloudflare protection. The API endpoint may be temporarily unavailable or require additional authentication.');
        } else if (responseText.trim().startsWith('<!DOCTYPE') || responseText.trim().startsWith('<html')) {
          lastError = new Error('API returned HTML instead of expected response. This may indicate the request was blocked or redirected.');
        } else if (!responseText || responseText.trim().length === 0) {
          lastError = new Error('Received empty response from YangYang API');
        } else {
          reviewContent = responseText;
          lastError = null;
          break;
        }

        if (attempt < maxAttempts) {
          core.warning(`YangYang API attempt ${attempt}/${maxAttempts} failed: ${lastError.message}. Retrying...`);
          await sleep(attempt * 5000);
        }
      }

      clearTimeout(timeout);

      if (lastError) {
        if (lastError.message.includes('Cloudflare protection')) {
          core.warning(`${lastError.message} Skipping code review for this run.`);
          return;
        }
        throw lastError;
      }

      // Log the full accumulated content
      console.log('\n\n=== Yang Code Review (YCR) Result ===');
      console.log(reviewContent);

      // Handle output based on event type
      if (isPushEvent) {
        // Save review as artifact for push events
        try {
          const artifactFileName = `yang-code-review-${commitSha.substring(0, 7)}-report.md`;
          const artifactPath = path.resolve(process.cwd(), artifactFileName);
          
          // Create the review content with metadata
          const artifactContent = `# 🤖 Yang Code Review (YCR)\n\n**Commit:** ${commitSha}\n**Repository:** ${owner}/${repo}\n**Date:** ${new Date().toISOString()}\n\n---\n\n${reviewContent}`;
          
          // Write to file
          fs.writeFileSync(artifactPath, artifactContent, 'utf8');
          
          // Verify file exists before uploading
          if (!fs.existsSync(artifactPath)) {
            throw new Error(`Artifact file was not created: ${artifactPath}`);
          }
          
          core.info(`Uploading artifact from ${process.cwd()}`);
          core.info(`Files: ${[artifactFileName]}`);
          
          // Upload artifact - use relative filename from current working directory
          const {id, size} = await artifact.uploadArtifact(
            'yang-code-review',
            [artifactFileName],
            process.cwd(), // root directory
            {
              retentionDays: 90
            }
          );
          
          console.log(`\n✅ Review saved as artifact: yang-code-review (id: ${id}, bytes: ${size})`);
        } catch (artifactError) {
          core.warning(`Failed to save artifact: ${artifactError.message}`);
          // Don't fail the action if artifact upload fails
        }
      } else {
        // Post review as a comment on the PR for pull_request events
        const pr = context.payload.pull_request;
        const pull_number = pr.number;
        const prSha = pr.head.sha;
        
        // Post comment on PR
        try {
          await octokit.rest.issues.createComment({
            owner,
            repo,
            issue_number: pull_number,
            body: `## 🤖 Yang Code Review (YCR)\n\n${reviewContent}`
          });
          console.log(`\n✅ Review posted as comment on PR #${pull_number}`);
        } catch (commentError) {
          core.warning(`Failed to post comment on PR: ${commentError.message}`);
          // Don't fail the action if comment posting fails
        }
        
        // Save review as artifact for pull request events
        try {
          const artifactFileName = `yang-code-review-pr-${pull_number}-${prSha.substring(0, 7)}-report.md`;
          const artifactPath = path.resolve(process.cwd(), artifactFileName);
          
          // Create the review content with metadata
          const artifactContent = `# 🤖 Yang Code Review (YCR)\n\n**Pull Request:** #${pull_number}\n**Commit:** ${prSha}\n**Repository:** ${owner}/${repo}\n**Date:** ${new Date().toISOString()}\n\n---\n\n${reviewContent}`;
          
          // Write to file
          fs.writeFileSync(artifactPath, artifactContent, 'utf8');
          
          // Verify file exists before uploading
          if (!fs.existsSync(artifactPath)) {
            throw new Error(`Artifact file was not created: ${artifactPath}`);
          }
          
          core.info(`Uploading artifact from ${process.cwd()}`);
          core.info(`Files: ${[artifactFileName]}`);

          // Upload artifact - use relative filename from current working directory
          const {id, size} = await artifact.uploadArtifact(
            `yang-code-review-pr-${pull_number}`,
            [artifactFileName],
            process.cwd(), // root directory
            {
              retentionDays: 90
            }
          );
          
          console.log(`\n✅ Review saved as artifact: yang-code-review-pr-${pull_number} (id: ${id}, bytes: ${size})`);
        } catch (artifactError) {
          core.warning(`Failed to save artifact: ${artifactError.message}`);
          // Don't fail the action if artifact upload fails
        }
      }

    } catch (error) {
      clearTimeout(timeout);
      core.setFailed(error.message);
    } 
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
