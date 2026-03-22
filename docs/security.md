# Security

## Current Security Model

This repo is currently designed for a trusted, single-tenant operator deployment.

That means:

- one Railway service
- one app-owned runtime
- one shared secret boundary

## Where Secrets Live Today

### Railway-managed secrets

Best used for:

- `SETUP_PASSWORD`
- model provider keys
- database URL
- browser automation token

### App-managed connector secrets

User-entered connector credentials are currently:

- saved by the app
- persisted in the service state volume
- loaded back into the runtime environment on startup

This is convenient for operator-managed deployments, but it is not strong tenant isolation.

## What Railway Protects

Railway helps with:

- environment variable management
- secret storage in the Railway control plane
- keeping operator secrets out of the repo

## What Railway Does Not Solve

Railway does not by itself solve:

- prompt-injection risk inside the running app
- per-user secret isolation
- fine-grained authorization between users sharing one gateway

If a model or tool path can access runtime secrets, those secrets are still in the app trust boundary.

## Recommended Current Usage

Use this repo when:

- one operator controls the deployment
- one trusted user or team uses the assistant
- you are comfortable with app-owned connector credentials

Do not treat the current design as ready for:

- public SaaS
- untrusted users
- compliance-heavy environments
- strict tenant isolation

## Hardening Direction

If you want to distribute this more broadly, the next steps are:

1. keep operator root secrets in Railway
2. move connector credentials to encrypted backend storage
3. stop exposing connector secrets as model-visible runtime environment values
4. proxy Slack, Confluence, and GitHub access through narrow backend actions
5. add per-user or per-tenant isolation

## Practical Rule

For now, assume:

- operator-managed deployment: acceptable
- customer-facing self-serve product: not yet acceptable
