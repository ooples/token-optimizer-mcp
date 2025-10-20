# Contributing to Token Optimizer MCP

Thank you for your interest in contributing to Token Optimizer MCP! This document provides guidelines and information for contributors.

## Table of Contents

- [Getting Started](#getting-started)
- [Development Guidelines](#development-guidelines)
- [Testing Requirements](#testing-requirements)
- [Pull Request Process](#pull-request-process)
- [Release Process](#release-process)

## Getting Started

### Prerequisites

- **Node.js**: Version 20.x or higher
- **npm**: Version 8.x or higher
- **Git**: Latest stable version
- **TypeScript**: 5.9+ (installed via npm)

### Initial Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/token-optimizer-mcp.git
   cd token-optimizer-mcp
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Build the Project**
   ```bash
   npm run build
   ```

4. **Verify Installation**
   ```bash
   npm test
   ```

### Development Workflow

1. **Create a Feature Branch**
   ```bash
   git checkout -b feat/your-feature-name
   # or
   git checkout -b fix/your-bug-fix
   ```

2. **Make Changes**
   - Write your code following our coding standards
   - Add tests for new functionality
   - Update documentation as needed

3. **Build and Test**
   ```bash
   npm run build
   npm test
   npm run lint
   ```

4. **Commit Your Changes**
   ```bash
   git add .
   git commit -m "feat: add new feature"
   ```

5. **Push and Create PR**
   ```bash
   git push origin feat/your-feature-name
   ```

## Development Guidelines

### Code Style

We use **ESLint** and **Prettier** to maintain consistent code style.

- **Run linter**: `npm run lint`
- **Auto-fix issues**: `npm run lint:fix`
- **Format code**: `npm run format`
- **Check formatting**: `npm run format:check`

### TypeScript Conventions

1. **Type Safety**
   - Always provide explicit types for function parameters and return values
   - Avoid using `any` - use `unknown` or proper types instead
   - Use TypeScript's strict mode features

2. **File Organization**
   - One primary export per file
   - Group related types and interfaces together
   - Use barrel exports (`index.ts`) for clean imports

3. **Naming Conventions**
   - **Files**: kebab-case (e.g., `smart-cache.ts`)
   - **Classes**: PascalCase (e.g., `CacheEngine`)
   - **Functions**: camelCase (e.g., `getCachedData`)
   - **Constants**: UPPER_SNAKE_CASE (e.g., `MAX_CACHE_SIZE`)
   - **Interfaces/Types**: PascalCase (e.g., `CacheOptions`)

4. **Error Handling**
   - Always handle errors explicitly
   - Use custom error classes for specific error types
   - Provide meaningful error messages

### Commit Message Format

We follow **Conventional Commits** specification:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `chore`: Maintenance tasks
- `ci`: CI/CD changes

**Examples:**
```bash
feat(cache): add predictive caching capability
fix(compression): resolve memory leak in brotli compression
docs(api): update smart-cache documentation
test(cache): add integration tests for cache warmup
```

**Important Notes:**
- Use present tense ("add feature" not "added feature")
- Use imperative mood ("move cursor to..." not "moves cursor to...")
- First line should be 72 characters or less
- Reference issues in footer (e.g., "Closes #123")

### Branch Naming Conventions

- `feat/feature-name` - New features
- `fix/bug-description` - Bug fixes
- `docs/documentation-update` - Documentation updates
- `refactor/code-improvement` - Code refactoring
- `test/test-addition` - Test additions
- `chore/maintenance-task` - Maintenance tasks

## Testing Requirements

### Running Tests

```bash
# Run all tests
npm test

# Run with coverage
npm run test:coverage

# Run in watch mode (development)
npm run dev
```

### Coverage Requirements

- **Minimum coverage**: 80% overall
- **Line coverage**: 80%
- **Branch coverage**: 75%
- **Function coverage**: 80%

### Writing Tests

1. **Test File Location**
   - Place test files next to the code they test
   - Use `.test.ts` extension (e.g., `smart-cache.test.ts`)

2. **Test Structure**
   ```typescript
   import { describe, it, expect } from '@jest/globals';

   describe('FeatureName', () => {
     describe('methodName', () => {
       it('should do something specific', () => {
         // Arrange
         const input = 'test';

         // Act
         const result = methodName(input);

         // Assert
         expect(result).toBe('expected');
       });
     });
   });
   ```

3. **Test Coverage Areas**
   - Happy path scenarios
   - Error conditions
   - Edge cases
   - Boundary conditions
   - Integration points

### Performance Benchmarks

For performance-critical features, include benchmarks:

```bash
npm run benchmark
```

Expected performance targets:
- Cache operations: <10ms
- Token counting: <5ms per 1000 tokens
- Compression: ~1ms per KB
- Cache hit rate: >80%

## Pull Request Process

### Before Submitting

1. **Ensure all tests pass**
   ```bash
   npm test
   npm run lint
   npm run build
   ```

2. **Update documentation**
   - Add/update JSDoc comments
   - Update README.md if needed
   - Update API.md for new tools

3. **Add tests**
   - New features must include tests
   - Bug fixes should include regression tests
   - Maintain or improve coverage

### PR Template

When you create a PR, fill out the template completely:

- **Description**: Clear explanation of changes
- **Type of change**: feat/fix/docs/etc.
- **Checklist**: All items must be checked
- **Related issues**: Link to issues

### Required Status Checks

All PRs must pass:

1. **Continuous Integration**
   - Build succeeds
   - All tests pass
   - Code coverage meets threshold

2. **Code Quality**
   - ESLint passes (no errors)
   - Prettier formatting applied
   - TypeScript type checks pass

3. **Review Requirements**
   - At least 1 approval from maintainers
   - All conversations resolved
   - No merge conflicts

### Review Process

1. **Automated Checks**
   - CI/CD pipeline runs automatically
   - Code quality tools provide feedback

2. **Code Review**
   - Maintainers review code quality
   - Security implications considered
   - Performance impact evaluated

3. **Feedback and Iteration**
   - Address reviewer comments
   - Push updates to the same branch
   - Request re-review when ready

4. **Merge**
   - Maintainer merges approved PRs
   - Squash and merge is preferred
   - Delete branch after merge

## Release Process

### Automated Releases

We use **semantic-release** for automated versioning and publishing:

1. **Version Bumps**
   - `feat:` → Minor version (0.x.0)
   - `fix:` → Patch version (0.0.x)
   - `BREAKING CHANGE:` → Major version (x.0.0)

2. **Release Triggers**
   - Automatic on merge to `main` branch
   - Triggered by CI/CD pipeline
   - Changelog auto-generated

3. **Publishing**
   - npm package published automatically
   - GitHub release created
   - Changelog updated

### For Maintainers

See [RELEASE.md](./RELEASE.md) for detailed release procedures.

## Community Guidelines

### Code of Conduct

Please review and follow our [Code of Conduct](./CODE_OF_CONDUCT.md).

### Communication

- **GitHub Issues**: Bug reports and feature requests
- **Pull Requests**: Code contributions and discussions
- **Discussions**: General questions and ideas

### Getting Help

- Check existing [issues](https://github.com/ooples/token-optimizer-mcp/issues)
- Read the [documentation](./docs/API.md)
- Review [examples](./README.md#usage-examples)

## License

By contributing to Token Optimizer MCP, you agree that your contributions will be licensed under the MIT License.

## Recognition

Contributors are recognized in:
- GitHub contributors page
- Release notes
- Project README (for significant contributions)

Thank you for contributing to Token Optimizer MCP!
