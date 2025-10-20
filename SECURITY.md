# Security Policy

## Supported Versions

We actively support and provide security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Reporting a Vulnerability

We take the security of Token Optimizer MCP seriously. If you discover a security vulnerability, please follow these steps:

### Reporting Process

1. **DO NOT** open a public GitHub issue for security vulnerabilities
2. **DO NOT** disclose the vulnerability publicly until it has been addressed

3. **Submit a private report** via one of these methods:

   **Method 1: GitHub Security Advisories (Preferred)**
   - Navigate to the [Security tab](https://github.com/ooples/token-optimizer-mcp/security/advisories)
   - Click "Report a vulnerability"
   - Fill out the advisory form with details

   **Method 2: Email**
   - Send details to: security@ooples.com (if available)
   - Use subject line: `[SECURITY] Token Optimizer MCP - [Brief Description]`

### What to Include

Please provide as much information as possible:

- **Description**: Clear description of the vulnerability
- **Impact**: What could an attacker accomplish?
- **Steps to Reproduce**: Detailed steps to reproduce the issue
- **Affected Versions**: Which versions are vulnerable?
- **Proof of Concept**: Code or commands demonstrating the issue
- **Suggested Fix**: If you have ideas for remediation
- **Disclosure Timeline**: Your expectations for disclosure

### Example Report

```
Title: SQL Injection in Cache Query

Description:
The cache query function does not properly sanitize user input,
allowing SQL injection attacks.

Impact:
An attacker could read arbitrary data from the cache database
or potentially corrupt cached data.

Affected Versions:
- 0.1.0 through 0.2.0

Steps to Reproduce:
1. Call optimize_text with key: "test'; DROP TABLE cache;--"
2. Observe that SQL is executed directly

Proof of Concept:
[code snippet]

Suggested Fix:
Use parameterized queries instead of string concatenation
```

## Response Timeline

We aim to respond according to this timeline:

- **Initial Response**: Within 48 hours
- **Vulnerability Assessment**: Within 1 week
- **Fix Development**: Depends on severity
  - Critical: 1-3 days
  - High: 1-2 weeks
  - Medium: 2-4 weeks
  - Low: Next scheduled release
- **Patch Release**: As soon as fix is tested
- **Public Disclosure**: 7-14 days after patch release

## Severity Levels

We classify vulnerabilities using the following severity levels:

### Critical
- Remote code execution
- Authentication bypass
- Privilege escalation
- Data exfiltration at scale

### High
- SQL injection
- Cross-site scripting (XSS)
- Sensitive data exposure
- Directory traversal

### Medium
- Denial of service
- Information disclosure
- Insecure dependencies

### Low
- Minor information disclosure
- Configuration issues
- Best practice violations

## Security Best Practices

When using Token Optimizer MCP:

### For Users

1. **Keep Updated**
   ```bash
   # Check for updates regularly
   npm outdated -g token-optimizer-mcp

   # Update to latest version
   npm update -g token-optimizer-mcp
   ```

2. **Validate Input**
   - Don't cache untrusted data without validation
   - Sanitize cache keys before use
   - Be cautious with compression of sensitive data

3. **Secure Configuration**
   - Restrict file system permissions on cache database
   - Use environment variables for sensitive config
   - Don't commit cache database to version control

4. **Monitor for Issues**
   - Watch GitHub releases for security updates
   - Subscribe to security advisories
   - Review CHANGELOG for security fixes

### For Developers

1. **Code Security**
   - Never use `eval()` or similar unsafe functions
   - Validate all user inputs
   - Use parameterized database queries
   - Sanitize file paths (prevent directory traversal)

2. **Dependencies**
   ```bash
   # Audit dependencies regularly
   npm audit

   # Fix vulnerabilities automatically
   npm audit fix
   ```

3. **Secrets Management**
   - Never hardcode credentials
   - Use environment variables
   - Don't commit `.env` files
   - Use secrets management tools

4. **Testing**
   - Include security tests in test suite
   - Test for common vulnerabilities (OWASP Top 10)
   - Perform fuzzing on input validation

## Known Security Considerations

### Cache Storage

- Cache database is stored locally in SQLite
- Database file permissions should be restricted
- Sensitive data in cache is not encrypted by default
- Consider encrypting sensitive data before caching

### Compression

- Brotli compression is used for token optimization
- Compression bombs are theoretically possible
- Size limits are in place to prevent resource exhaustion

### Token Counting

- Uses tiktoken library for token counting
- No external API calls required
- Operates completely offline

### File System Access

- Server may access file system for cache storage
- Path traversal protections are implemented
- Runs with user's permissions (not elevated)

## Security Updates

Security fixes are released as:

1. **Patch Releases**: For all supported versions
2. **GitHub Security Advisories**: Published after fix
3. **npm Advisories**: Automatically flagged by npm

### Subscribing to Updates

- **Watch Repository**: Click "Watch" → "Custom" → "Security alerts"
- **npm Notifications**: `npm audit` will show security issues
- **GitHub Notifications**: Enable security alert emails

## Acknowledgments

We appreciate security researchers who responsibly disclose vulnerabilities:

- Security researchers will be credited in:
  - Security advisory
  - CHANGELOG
  - Release notes
  - GitHub security acknowledgments

- We follow a **responsible disclosure** policy
- Public disclosure only after patch is available
- Credit given unless anonymity requested

## Security Resources

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [npm Security Advisories](https://www.npmjs.com/advisories)
- [GitHub Security Advisories](https://github.com/advisories)

## Scope

### In Scope

- All code in this repository
- Dependencies we maintain
- Configuration recommendations
- Documentation accuracy

### Out of Scope

- Third-party dependencies (report to maintainers)
- Issues in Claude Desktop/Claude Code
- Network infrastructure
- Social engineering

## Legal

- Researchers acting in good faith will not face legal action
- We will not pursue legal action for security research
- Please act in good faith and avoid:
  - Privacy violations
  - Data destruction
  - Service disruption
  - Unauthorized access beyond proof of concept

## Contact

For security concerns:
- GitHub Security Advisories: [Create advisory](https://github.com/ooples/token-optimizer-mcp/security/advisories/new)
- General inquiries: [GitHub Issues](https://github.com/ooples/token-optimizer-mcp/issues) (non-security only)

Thank you for helping keep Token Optimizer MCP secure!
