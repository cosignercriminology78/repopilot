# Security model

This is a developer preview. Run it on a dedicated development machine/VM, not a host containing production credentials. Public fork PRs are skipped. Containers reduce exposure but share the worker kernel and do not provide a complete hostile-code boundary.

- Trusted: controller configuration and explicitly approved base-branch policy.
- Untrusted: PR descriptions, head files, model output, test output.
- Test containers: no network by default, no forwarded host credentials, read-only source bind, disposable tmpfs workspace, non-root user, dropped capabilities, resource limits. Configured dependency services enable a disposable internal Docker network with no published host ports. Internal networks are not a complete host boundary; restrict access to host gateway services using worker VM/firewall policy. See [test environments](docs/TEST-ENVIRONMENTS.md).
- Agent container: model network access is necessary; it receives an OpenAI key and repository text, but no GitHub token or host checkout. Prompt instructions and SDK sandbox settings are defense in depth, not a guarantee against prompt injection. Restrict worker egress at the VM/firewall layer when handling sensitive sources.
- Publisher: only accepts verified reports, targets an independent branch, rechecks source revisions, never merges or force-pushes.
- Snapshots: fail closed for symlinks, submodules, unsupported binaries, case collisions and path traversal. Git executable modes are retained in snapshots, exports and published trees; Windows host filesystem semantics may differ from Linux modes.
- Evidence: structured reporters check discovery, per-case identities and repeated failure fingerprints. Test code still runs in the same container as its runtime/reporter; this is not tamper-proof attestation against actively malicious code.
- Local task reports and input snapshots may contain proprietary code and logs. Keep the data directory private and out of Git. Logs are not comprehensively secret-redacted in this preview.
- Agent timeouts remove the named container. Controller crashes may leave containers; inspect `docker ps -a` for `repopilot-` names before cleanup. Do not delete unrelated containers or the entire data directory blindly.

Report vulnerabilities privately to the repository maintainer through an available private contact channel. Do not include secrets in public issues.
