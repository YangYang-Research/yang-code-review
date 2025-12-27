import * as core from '@actions/core';
import * as github from '@actions/github';
import { create } from '@actions/artifact';
import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

async function run() {
  try {
    // Mask sensitive input
    const clientId = core.getInput('CLIENT_ID', { required: true });
    const clientSecret = core.getInput('CLIENT_SECRET', { required: true });
    const agentName = core.getInput('AGENT_NAME', { required: true });
    const modelName = core.getInput('MODEL_NAME', { required: true });
    const modelTemperature = core.getInput('MODEL_TEMPERATURE', { required: true });
    const githubToken = core.getInput('GITHUB_TOKEN', { required: true });

    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    core.setSecret(auth);
    core.setSecret(clientId);
    core.setSecret(clientSecret);
    core.setSecret(githubToken);

    const context = github.context;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const octokit = github.getOctokit(githubToken);

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
    let apiResponse;
    try {
      apiResponse = await fetch('https://yyng.icu/ycr/v1/code-review/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-yang-auth': `Basic ${auth}`,
          'user-agent': 'github-actions/yang-code-review'
        },
        body: JSON.stringify({
          chat_session_id: chatSessionId,
          agent_name: agentName,
          model_name: modelName,
          temprature: modelTemperature,
          messages: [
            {
              role: 'user',
              content: diff
            }
          ]
        })
      });

      clearTimeout(timeout);

      if (!apiResponse.ok) {
        // For error responses, read as text to check for Cloudflare challenges
        const errorText = await apiResponse.text();
        if (errorText.includes('Just a moment...') || errorText.includes('_cf_chl_opt') || errorText.includes('challenge-platform')) {
          throw new Error('API request was blocked by Cloudflare protection. The API endpoint may be temporarily unavailable or require additional authentication.');
        }
        throw new Error(`YangYang API error: ${apiResponse.status} - ${errorText.substring(0, 500)}`);
      }

      // Handle response like test.js example
      const reviewContent = await apiResponse.text();
      
      // Check for Cloudflare challenge or HTML responses
      if (reviewContent.includes('Just a moment...') || reviewContent.includes('_cf_chl_opt') || reviewContent.includes('challenge-platform')) {
        throw new Error('API request was blocked by Cloudflare protection. The API endpoint may be temporarily unavailable or require additional authentication.');
      }
      if (reviewContent.trim().startsWith('<!DOCTYPE') || reviewContent.trim().startsWith('<html')) {
        throw new Error('API returned HTML instead of expected response. This may indicate the request was blocked or redirected.');
      }
      
      if (!reviewContent || reviewContent.trim().length === 0) {
        throw new Error('Received empty response from YangYang API');
      }

      // Log the full accumulated content
      console.log('\n\n=== Full Review Content ===');
      console.log(reviewContent);

      // Handle output based on event type
      if (isPushEvent) {
        // Save review as artifact for push events
        try {
          const artifactName = `code-review-${commitSha.substring(0, 7)}`;
          const artifactPath = path.join(process.cwd(), 'code-review-result.md');
          
          // Create the review content with metadata
          const artifactContent = `# 🤖 Yang Code Review (YCR)\n\n**Commit:** ${commitSha}\n**Repository:** ${owner}/${repo}\n**Date:** ${new Date().toISOString()}\n\n---\n\n${reviewContent}`;
          
          // Write to file
          fs.writeFileSync(artifactPath, artifactContent, 'utf8');
          
          // Upload artifact
          const artifactClient = create();
          await artifactClient.uploadArtifact(artifactName, [artifactPath], process.cwd(), {
            retentionDays: 90
          });
          
          console.log(`\n✅ Review saved as artifact: ${artifactName}`);
        } catch (artifactError) {
          core.warning(`Failed to save artifact: ${artifactError.message}`);
          // Don't fail the action if artifact upload fails
        }
      } else {
        // Post review as a comment on the PR for pull_request events
        const pr = context.payload.pull_request;
        const pull_number = pr.number;
        
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
