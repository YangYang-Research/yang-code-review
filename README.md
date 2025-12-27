# 🤖 YangYang Code Review (YCR)

YangYang Code Review (YCR) for Pull Requests

## 🛡 Security

- `CLIENT_ID` and `CLIENT_SECRET` are **masked automatically** in GitHub Actions logs

## 🔐 Required Secrets

- `CLIENT_ID` – Client ID for authentication with the YangYang API service
- `CLIENT_SECRET` – Client secret for authentication with the YangYang API service

## ⚙️ Inputs

| Name | Required | Description |
|----|----|----|
| CLIENT_ID | yes | Client ID for authentication with the YangYang API service |
| CLIENT_SECRET | yes | Client secret for authentication with the YangYang API service |
| AGENT_NAME | yes | Name of the agent to use for code review |
| MODEL_NAME | yes | Name of the model to use for code review |
| MODEL_TEMPERATURE | yes | Temperature for the model |
| github_token | yes | GitHub token for PR comments |

## Models Supported

| Model Name | Description |
|------------|-------------|
| anthropic_claude_sonet_4_5 | Claude Sonet 4.5 |
| gpt_oss_120b | GPT-OSS 120B |
| llama_4_scout_17b_instruct | Llama 4 Scout 17B Instruct |

## Agents Supported

| Agent Name | Description |
|------------|-------------|
| yang-code-review | YangYang Code Review |

## 🚀 Usage Example

```yaml
name: YangYang Code Review (YCR)

on:
  push:
    branches: [ main ]
  pull_request:
    branches: [ main ]

jobs:
  code-review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: yang-code-review
        uses: YangYang-Research/yang-code-review@v1.0.1
        with:
          CLIENT_ID: ${{ secrets.YANG_CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.YANG_CLIENT_SECRET }}
          AGENT_NAME: 'yang-code-review'
          MODEL_NAME: 'anthropic_claude_sonet_4_5'
          MODEL_TEMPERATURE: 0.7
          GITHUB_TOKEN: ${{ secrets.GH_PAT }}
```

## Free Trial

| Account Type | Client ID | Client Secret | Quota | Input Limit | Output Limit |
|------------|------------|------------|------------|------------|------------|
| Free Trial | zekX2UMXId | 1/P5uT4+S`0-\19/o62m | 100 requests per day | 8000 tokens per request | 5000 tokens per request |

## 🏷 Marketplace

This action is marketplace-ready:
- Bundled with `@vercel/ncc`
- Branded icon & color
- Semantic versioning recommended (`v1`, `v1.1.0`)

## 🏗 Build (Required)

This action uses **@vercel/ncc** to bundle all dependencies into a single file.

```bash
npm install
npm run build
```

This will generate `dist/index.js` which **must be committed**.

## 🧪 Testing

There are several ways to test this GitHub Action:

### Method 1: Local Test Script (Recommended for Development)

Use the included test script to mock the GitHub Actions environment:

```bash
# Set required environment variables
export CLIENT_ID="your-client-id"
export CLIENT_SECRET="your-client-secret"
export AGENT_NAME="yang-code-review"
export MODEL_NAME="anthropic_claude_sonet_4_5"
export MODEL_TEMPERATURE="0.7"
export GITHUB_TOKEN="your-github-token"  # Optional, for testing API calls

# Run the test
node test.js
```

The test script will:
- Mock `@actions/core` and `@actions/github` modules
- Simulate a pull request context
- Execute the action code
- Show any errors or failures

### Method 2: Using `act` (Run GitHub Actions Locally)

Install [act](https://github.com/nektos/act) to run GitHub Actions locally:

```bash
# Install act (macOS)
brew install act

# Or using other methods (see act documentation)

# Create a test workflow file: .github/workflows/test.yml
# Then run:
act pull_request
```

### Method 3: Test in a Real Repository

1. Create a test repository on GitHub
2. Create a test workflow file (`.github/workflows/test.yml`):

```yaml
name: Test YCR Action

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: ./
        with:
          CLIENT_ID: ${{ secrets.CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.CLIENT_SECRET }}
          AGENT_NAME: 'yang-code-review'
          MODEL_NAME: 'anthropic_claude_sonet_4_5'
          MODEL_TEMPERATURE: '0.7'
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

3. Create a test PR to trigger the workflow
4. Check the Actions tab for results

### Method 4: Manual Testing Checklist

- [ ] Verify all required inputs are provided
- [ ] Test with valid credentials
- [ ] Test with invalid credentials (should fail gracefully)
- [ ] Test on a real pull request
- [ ] Verify secrets are masked in logs
- [ ] Test API timeout handling (15 seconds)
- [ ] Verify error messages are clear
