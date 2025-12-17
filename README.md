# 🤖 yang-assistant

AI-powered GitHub Action that automatically reviews Pull Request code by sending the diff to an external LLM API and posting feedback as a PR comment.

## 🛡 Security

- `API_KEY` is **masked automatically** in GitHub Actions logs

## 🔐 Required Secrets

- `API_KEY` – API key for authentication with the YangYang API service

## ⚙️ Inputs

| Name | Required | Description |
|----|----|----|
| API_KEY | yes | API key for authentication with the YangYang API service |
| LLM_MODEL | yes | Name of the LLM model to use for code review |
| github_token | yes | GitHub token for PR comments |

## 🚀 Usage Example

```yaml
name: Yang Assistant Code Review

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: yang-org/yang-assistant@v1
        with:
          API_KEY: ${{ secrets.YANG_API_KEY }}
          LLM_MODEL: gpt-4
          github_token: ${{ secrets.GITHUB_TOKEN }}
```

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
