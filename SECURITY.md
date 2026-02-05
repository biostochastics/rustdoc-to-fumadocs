# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability, please:

1. **Do not** open a public issue
2. Email security concerns to the maintainer
3. Include:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

We will respond within 48 hours and work with you to address the issue.

## Security Measures

This tool includes several security measures:

- **Input size limits**: Maximum 100MB input file
- **Path sanitization**: Prevents directory traversal attacks
- **Output validation**: Ensures output stays within designated directory
- **Recursion limits**: Prevents stack overflow attacks
