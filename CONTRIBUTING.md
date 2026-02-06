# Contributing

Thanks for contributing. This project follows the Conventional Commits format
and uses commitlint + husky to enforce it.

## Commit Message Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

Examples:

```
feat(http2): add stream idle timeout
fix(nat64): handle failed prefix fallback
docs(readme): clarify NAT64 limitations
```

### Types

Common types (from the conventional commitlint config):

- `feat` new feature
- `fix` bug fix
- `docs` documentation only
- `style` formatting only (no code change)
- `refactor` code change that neither fixes a bug nor adds a feature
- `perf` performance improvement
- `test` adding or fixing tests
- `build` build system or external dependencies
- `ci` CI configuration
- `chore` maintenance tasks
- `revert` revert a previous commit

### Breaking Changes

Use `!` after the type/scope or add a `BREAKING CHANGE:` footer:

```
feat(http1)!: change response type

BREAKING CHANGE: HttpResponse is now a Web Response.
```

## Development

```bash
pnpm install
pnpm test:run
pnpm build
```
