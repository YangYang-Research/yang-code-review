import * as core from '@actions/core';
import * as github from '@actions/github';
import fetch from 'node-fetch';
import crypto from 'crypto';

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

    if (!context.payload.pull_request) {
      core.setFailed('This action can only run on pull_request events');
      return;
    }

    const pr = context.payload.pull_request;
    const owner = context.repo.owner;
    const repo = context.repo.repo;
    const pull_number = pr.number;

    const octokit = github.getOctokit(githubToken);

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

    const chatSessionId = crypto.randomUUID();
    let apiResponse;
    try {
      apiResponse = await fetch('https://yyng.icu/ycr/v1/code-review/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-yang-auth': `Basic ${auth}`
        },
        body: JSON.stringify({
          chat_session_id: chatSessionId,
          agent_name: agentName,
          model_name: modelName,
          model_temperature: modelTemperature,
          messages: [
            {
              role: 'user',
              content: diff
            }
          ]
        })
      });

      const result = await apiResponse.text();
      console.log(result);

      if (!apiResponse.ok) {
        throw new Error(`LLM API error: ${apiResponse.status} - ${result}`);
      }

    } catch (error) {
      core.setFailed(error.message);
    } 
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
