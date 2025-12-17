import core from '@actions/core';
import github from '@actions/github';
import fetch from 'node-fetch';

async function run() {
  try {
    // Mask sensitive input
    const apiKey = core.getInput('API_KEY', { required: true });
    core.setSecret(apiKey);

    const model = core.getInput('LLM_MODEL', { required: true });
    const token = core.getInput('github_token', { required: true });

    const context = github.context;

    if (!context.payload.pull_request) {
      core.setFailed('This action can only run on pull_request events');
      return;
    }

    const pr = context.payload.pull_request;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pull_number = pr.number;

    const octokit = github.getOctokit(token);

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

    const diff = diffResponse.data;

    // Call YangYang API with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let apiResponse;
    try {
      apiResponse = await fetch('https://api.yangyang.ai/invoke', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model_name: model,
          diff_code: diff,
        })
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new Error('LLM API request timed out after 15 seconds');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (!apiResponse.ok) {
      const text = await apiResponse.text();
      throw new Error(`LLM API error: ${apiResponse.status} - ${text}`);
    }

    const result = await apiResponse.json();
    const review = result.review;

    const body = review && review.trim()
      ? `## 🤖 Yang Assistant Code Review\n\n${review}`
      : '## ⚠️ Yang Assistant\n\nNo review content was returned by the API.';

    // Post comment to PR
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull_number,
      body
    });

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
