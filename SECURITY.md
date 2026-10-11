# Security policy

This repository contains code that runs inside a NanoClaw host and handles passwords, backup keys and provider
credentials. Please report a vulnerability **privately**, not in a public issue.

- Use GitHub's *Report a vulnerability* button on the repository's **Security** tab (private vulnerability
  reporting).
- Include the version or commit, what you did, what happened and what you expected. Do not include real
  credentials, backups or personal data; invented values are enough.

What is in scope: the panel's authentication, sessions, CSRF and request checks, the handling of secrets, the
backup format and restore (including the archive reader and writer), the credential helper, and the
scheduled-backup key handling.

What is not: vulnerabilities in NanoClaw itself or in the services it talks to (report those upstream), and
exposure caused by a configuration the guide warns against, such as serving the panel over plain HTTP on an
untrusted network.

This is a small project maintained in spare time: expect an acknowledgement within about a week and a fix or a
clear answer after that. Fixes are released on the main branch with a note in the commit message.
