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
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: yang-org/yang-code-review@v1
        with:
          CLIENT_ID: ${{ secrets.YANG_CLIENT_ID }}
          CLIENT_SECRET: ${{ secrets.YANG_CLIENT_SECRET }}
          AGENT_NAME: 'yang-code-review'
          MODEL_NAME: 'anthropic_claude_sonet_4_5'
          MODEL_TEMPERATURE: 0.7
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Free Trial

| Account Type | Client ID | Client Secret | Quota | Input Limit | Output Limit |
|------------|------------|------------|------------|------------|------------|
| Free Trial | zekX2UMXId | }qzb/&fx|Uef#SkW@F+YECoUMUx>&d | 100 requests per day | 8000 tokens per request | 5000 tokens per request |

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
````

This will generate `dist/index.js` which **must be committed**.
