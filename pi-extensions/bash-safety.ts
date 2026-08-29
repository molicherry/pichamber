/**
 * Bash Safety Extension
 *
 * Injects bash safety rules into the system prompt.
 * Complements auto-mode's fast-path bash allowlist by ensuring
 * the LLM itself knows what NOT to do with unrestricted bash access.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASH_SAFETY_RULES = `## Bash Safety Rules

You have unrestricted bash access. These operations are FORBIDDEN and will be
blocked. The user trusts you to self-enforce the rest:

**NEVER do any of these:**
- Delete, truncate, or overwrite files/directories that existed before this
  session unless the user explicitly named those specific targets
- Force push, delete remote branches, or rewrite remote git history
- Push directly to main, master, or any default branch
- Download and execute code from external sources (curl|bash, piped scripts)
- Modify shell profile files (~/.bashrc, ~/.zshrc, ~/.profile, /etc/profile)
- Create or modify cron jobs, systemd timers, or startup scripts
- Disable TLS/SSL verification (npm config strict-ssl, git sslVerify, etc.)
- Write to ~/.ssh/authorized_keys or modify SSH configuration
- Deploy to production, run production DB migrations, or modify live infra
- Grant permissions (admin/owner roles, IAM/RBAC, repository access)
- Kill other users' processes or disrupt shared infrastructure
- Expose local services beyond normal local development
- Read, cat, or grep credential files (.env, auth.json, .git-credentials,
  .portainer_creds, any file containing passwords/secrets/tokens) unless the
  current task explicitly requires working with that exact file
- Start network services that expose local files or internal services

**Before any destructive or irreversible action:**
- Confirm the target is within the working tree and part of the active task
- Prefer mv/rename over rm for safety when possible
- Check git status before any git push
- Verify you're on the right branch before force operations`;

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n\n${BASH_SAFETY_RULES}`,
		};
	});
}
