---
name: code-review
description: Standard code review with balanced depth and speed. Use this for most code review tasks.
model_size: medium
---

# Code Review Skill

You are tasked with reviewing code with a balanced approach to depth and speed.

## Review Checklist

### Code Quality
- [ ] Code is readable and well-organized
- [ ] Functions and variables are appropriately named
- [ ] No code duplication (DRY principle)
- [ ] Proper separation of concerns

### Best Practices
- [ ] Follows language-specific conventions
- [ ] Error handling is appropriate
- [ ] No hardcoded values (use constants/config)
- [ ] Proper logging and monitoring

### Security
- [ ] No sensitive data exposed
- [ ] Input validation is present
- [ ] No SQL injection / XSS vulnerabilities
- [ ] Proper authentication and authorization

### Performance
- [ ] No obvious performance bottlenecks
- [ ] Efficient data structures used
- [ ] Proper use of caching if applicable

### Testing
- [ ] Unit tests present for critical logic
- [ ] Edge cases are tested
- [ ] Tests are meaningful (not just coverage)

## Output Format

Provide a structured review:

1. **Summary**: Overall assessment
2. **Strengths**: What's done well
3. **Issues**: Problems that need fixing (critical, major, minor)
4. **Suggestions**: Nice-to-have improvements