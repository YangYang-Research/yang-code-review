#!/usr/bin/env node

/**
 * Test script for yang-code-review action
 * 
 * This script mocks the GitHub Actions environment and allows you to test
 * the action locally without needing a real PR or GitHub Actions runner.
 * 
 * Usage:
 *   node test.js
 * 
 * Environment variables required:
 *   CLIENT_ID - Your YangYang API client ID
 *   CLIENT_SECRET - Your YangYang API client secret
 *   AGENT_NAME - Agent name (e.g., 'yang-code-review')
 *   MODEL_NAME - Model name (e.g., 'anthropic_claude_sonet_4_5')
 *   MODEL_TEMPERATURE - Model temperature (e.g., '0.7')
 *   GITHUB_TOKEN - GitHub personal access token (optional, for testing API calls)
 *   TEST_PR_OWNER - Repository owner (optional, defaults to 'octocat')
 *   TEST_PR_REPO - Repository name (optional, defaults to 'Hello-World')
 *   TEST_PR_NUMBER - PR number to test with (optional, defaults to 1)
 */

// Mock @actions/core
const mockCore = {
  inputs: {},
  secrets: new Set(),
  failed: false,
  failedMessage: null,
  
  getInput: (name, options) => {
    const value = process.env[name] || mockCore.inputs[name];
    if (options?.required && !value) {
      throw new Error(`Input required and not supplied: ${name}`);
    }
    return value || '';
  },
  
  setSecret: (secret) => {
    mockCore.secrets.add(secret);
    console.log(`[MOCK] Secret masked: ${secret.substring(0, 4)}...`);
  },
  
  setFailed: (message) => {
    mockCore.failed = true;
    mockCore.failedMessage = message;
    console.error(`[FAILED] ${message}`);
  },
  
  info: (message) => console.log(`[INFO] ${message}`),
  warning: (message) => console.warn(`[WARNING] ${message}`),
  error: (message) => console.error(`[ERROR] ${message}`),
};

// Mock @actions/github
const mockGithub = {
  context: {
    payload: {
      pull_request: {
        number: parseInt(process.env.TEST_PR_NUMBER || '1'),
      }
    },
    repo: {
      owner: process.env.TEST_PR_OWNER || 'octocat',
      repo: process.env.TEST_PR_REPO || 'Hello-World',
    }
  },
  
  getOctokit: (token) => {
    if (!token) {
      throw new Error('GitHub token is required');
    }
    
    return {
      request: async (method, options) => {
        console.log(`[MOCK] GitHub API call: ${method}`);
        console.log(`[MOCK] Options:`, JSON.stringify(options, null, 2));
        
        // Return a mock diff response
        return {
          data: `diff --git a/test.js b/test.js
index 1234567..abcdefg 100644
--- a/test.js
+++ b/test.js
@@ -1,3 +1,5 @@
 function hello() {
-  console.log('Hello');
+  console.log('Hello World');
+  console.log('This is a test');
 }
`
        };
      }
    };
  }
};

// Replace the modules before importing the action
const Module = require('module');
const originalRequire = Module.prototype.require;

Module.prototype.require = function(...args) {
  if (args[0] === '@actions/core') {
    return mockCore;
  }
  if (args[0] === '@actions/github') {
    return mockGithub;
  }
  return originalRequire.apply(this, args);
};

// Now require the bundled action
async function runTest() {
  console.log('🧪 Starting test for yang-code-review action\n');
  console.log('📋 Test Configuration:');
  console.log(`   CLIENT_ID: ${process.env.CLIENT_ID ? '***' + process.env.CLIENT_ID.slice(-4) : 'NOT SET'}`);
  console.log(`   CLIENT_SECRET: ${process.env.CLIENT_SECRET ? '***' + process.env.CLIENT_SECRET.slice(-4) : 'NOT SET'}`);
  console.log(`   AGENT_NAME: ${process.env.AGENT_NAME || 'NOT SET'}`);
  console.log(`   MODEL_NAME: ${process.env.MODEL_NAME || 'NOT SET'}`);
  console.log(`   MODEL_TEMPERATURE: ${process.env.MODEL_TEMPERATURE || 'NOT SET'}`);
  console.log(`   GITHUB_TOKEN: ${process.env.GITHUB_TOKEN ? '***' + process.env.GITHUB_TOKEN.slice(-4) : 'NOT SET'}`);
  console.log(`   Repository: ${mockGithub.context.repo.owner}/${mockGithub.context.repo.repo}`);
  console.log(`   PR Number: ${mockGithub.context.payload.pull_request.number}\n`);

  // Check required environment variables
  const required = ['CLIENT_ID', 'CLIENT_SECRET', 'AGENT_NAME', 'MODEL_NAME', 'MODEL_TEMPERATURE'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\nPlease set them before running the test:');
    console.error('   export CLIENT_ID="your-client-id"');
    console.error('   export CLIENT_SECRET="your-client-secret"');
    console.error('   export AGENT_NAME="yang-code-review"');
    console.error('   export MODEL_NAME="anthropic_claude_sonet_4_5"');
    console.error('   export MODEL_TEMPERATURE="0.7"');
    process.exit(1);
  }

  try {
    // Load and run the action
    require('./dist/index.js');
    
    // Wait a bit for async operations
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (mockCore.failed) {
      console.log('\n❌ Test failed:', mockCore.failedMessage);
      process.exit(1);
    } else {
      console.log('\n✅ Test completed successfully!');
      process.exit(0);
    }
  } catch (error) {
    console.error('\n❌ Test error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

runTest();

