# Automatic connection recovery

MCP connectivity and provider proxy connectivity are separate. A connected MCP server can still
have a dead provider proxy. Every MCP host now runs the same background recovery loop: it checks
existing proxy routes every five seconds, restarts an unavailable supervisor, and restores the
recorded routes and ports. This includes routes that originally needed an alternative port because
their preferred port was busy. Recovery does not block the MCP handshake.

The loop runs while at least one MCP session is connected. After a reboot, opening a client starts
it again. An interrupted provider request may fail before recovery finishes; the client's next
retry can use the same URL. Occupied ports, blocked process creation, provider outages, and invalid
credentials still require their own resolution. A saved PID or URL alone is never proof of a live
proxy.

## Coverage by client

| Clients | Routing and recovery |
| --- | --- |
| Claude Code | Managed session proxy or installed background route. Restores the original provider behind an optimizer-owned endpoint; maintains the installed route while MCP is connected. |
| Codex | Managed session proxy using its configured provider, including recovery of an optimizer-owned endpoint in provider configuration. |
| Gemini, Qwen, Crush, Droid, Continue (`cn`), Copilot, Amp | Managed session proxy using each client's own endpoint variable. A saved optimizer route resolves to its recorded provider, preserving custom provider paths. |
| OpenCode | Provider-specific proxies inside its plugin. Saved optimizer endpoints resolve to their original providers before proxy creation. |
| Zed | Explicitly configured background routes recover with the shared supervisor. Provider/model selection remains opt-in. |
| Cursor, Cline, Windsurf, Kilo, Roo | Shared MCP startup and installation repair apply. These integrations expose no supported provider redirect; they do not acquire a proxy dependency. |

Session proxies live with their launcher or client process and do not write their temporary URLs
into permanent provider configuration. The shared supervisor restores all of its routes, irrespective
of which client originally requested them. User-owned local gateways remain upstreams; loopback
addresses alone are not treated as optimizer-owned.

## Upgrades

Starting the updated MCP server in any supported client also starts a separate, nonblocking repair
worker. It upgrades unchanged managed shell functions, Windows command launchers, and manually
installed Claude hooks that still point at an older package. It can repair a removed old package too.
It creates no new client registrations or shell wrappers, does not change PATH, and preserves hook
options, profile encoding, unrelated settings, edited launchers, newer installations, and explicit
version pins. Existing terminals need to reload their profile to use updated shell functions.

`TOKEN_OPTIMIZER_AUTO_REPAIR=0` disables installation repair. `TOKEN_OPTIMIZER_PROXY=0` or
`TOKEN_OPTIMIZER_MODE=off` disables proxy recovery. `TOKEN_OPTIMIZER_PROXY_AUTOSTART=0` prevents
starting a background supervisor. Installation repair does not rewrite arbitrary user-maintained MCP
commands: a deliberately pinned registration must first be upgraded by its owner.

## Regression coverage

- Real HTTP requests through all ten managed CLI routing paths, starting with a dead recorded proxy.
- Shell and Windows launcher upgrades for every managed CLI, including preservation and uninstall checks.
- A real MCP server remains connected while its supervisor is killed or terminated; the same provider
  URL works again, and startup also repairs a stale Codex launcher.
- Multiple persistent routes and a collision-assigned port survive supervisor restart without clients
  registering again; maintenance also works without a Claude settings file.

The CLI tests use synthetic client processes and local providers. They verify the configuration and
transport contracts without claiming to exercise every vendor's installed CLI or authentication flow.
