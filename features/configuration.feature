# language: en
@configuration
Feature: Configuration loading and reload
  As an operator running xcache-mcp
  I want all non-secret configuration to live in a single JSON file
  So that secrets stay out of source control and operational config stays out of the environment.

  Background:
    Given xcache-mcp is installed at the project root
    And the only env vars the proxy reads are X_BEARER_TOKEN and XCACHE_CONFIG

  # ---------- Env vars (limited surface) ----------

  Scenario: Required X_BEARER_TOKEN is missing
    Given X_BEARER_TOKEN is not set
    When the proxy starts
    Then a warning is written to stderr containing "X_BEARER_TOKEN is not set"
    And the proxy continues to boot
    But every upstream call will fail with an authentication error

  Scenario: XCACHE_CONFIG override
    Given XCACHE_CONFIG is set to "/etc/xcache-mcp/app.config.json"
    When the proxy starts
    Then the file at that path is loaded as the app config

  Scenario: XCACHE_CONFIG defaults to ./app.config.json
    Given XCACHE_CONFIG is not set
    When the proxy starts
    Then it loads "./app.config.json" relative to the working directory

  # ---------- File schema ----------

  Scenario: Loads valid config and applies all defaults
    Given an app.config.json exists with only the required fields:
      | version             |
      | throttle section    |
    When the proxy starts
    Then the HTTP listener binds to "127.0.0.1:8787" (server defaults)
    And the stdio transport is NOT attached (server.stdio.enabled defaults to false)
    And the data directory is "$HOME/.openclaw/xcache-mcp" (storage default)
    And X API base is "https://api.x.com" (x_api default)
    And logging level is "info", events on, bodies on (logging defaults)
    And only the two ★ tools are exposed (tools.enabled default)

  Scenario: Server section overrides
    Given app.config.json server section:
      """
      "server": { "host": "0.0.0.0", "port": 9000,
                  "http":  { "enabled": true },
                  "stdio": { "enabled": false } }
      """
    When the proxy starts
    Then the HTTP listener binds to 0.0.0.0:9000
    And no stdio transport is attached

  Scenario: Storage root override (with tilde expansion)
    Given app.config.json storage.root is "~/custom-cache"
    When the proxy starts
    Then the resolved data directory is "$HOME/custom-cache"
    And logs/events and logs/bodies subdirectories are created

  Scenario: x_api base override (used for testing)
    Given app.config.json x_api.base is "http://127.0.0.1:9999"
    When the proxy makes any upstream call
    Then the request goes to "http://127.0.0.1:9999/2/..."
    And no requests are made to "https://api.x.com"

  Scenario: x_api.earliest_data_iso clamps time-bounded queries
    Given app.config.json x_api.earliest_data_iso is "2025-06-01T00:00:00Z"
    When x_posts_since is called with since_iso "2024-01-01T00:00:00Z" for a user with no cursor yet
    Then the upstream request's start_time is clamped to "2025-06-01T00:00:00.000Z"
    And the local response filter still uses the caller's since_iso
    # Cached older posts (if any) are still returned to the caller; the floor
    # only governs how far back the proxy is willing to ASK upstream for data.

  Scenario: x_api.earliest_data_iso enforced via early-stop on /following
    Given app.config.json x_api.earliest_data_iso is set
    When the agent calls x_follows_changes_since for a user with a prior snapshot
    Then the proxy walks /2/users/:id/following newest-first
    And it stops on the first page that contains a known follow (cached ID)
    And the new snapshot is recorded with walk_kind = "partial"
    # /following has no time parameter, so the early-stop heuristic is the
    # functional equivalent of the time floor for that endpoint.

  Scenario Outline: x_api.earliest_data_iso must parse as ISO 8601
    Given app.config.json x_api.earliest_data_iso is "<spec>"
    When the proxy attempts to load it
    Then loading fails with an error
    And startup is aborted

    Examples:
      | spec     |
      | not-iso  |
      | 2025-13-99 |
      | yesterday|

  Scenario Outline: logging toggles
    Given app.config.json logging.<key> is <value>
    When the proxy logs upstream activity
    Then <key> log files <are_or_arent> created

    Examples:
      | key    | value | are_or_arent |
      | events | true  | are          |
      | events | false | are not      |
      | bodies | true  | are          |
      | bodies | false | are not      |

  Scenario: Logging level only affects stderr output
    Given app.config.json logging.level is "debug"
    When Fastify emits request logs
    Then those logs go to stderr only
    And stdout is reserved for the MCP protocol channel

  # ---------- tools.enabled semantics ----------

  Scenario: tools.enabled absent → default starred set
    Given app.config.json has no tools section
    When the proxy starts
    Then exactly the two ★ tools are exposed: x_posts_since, x_follows_changes_since

  Scenario: tools.enabled = "*" → all 7 tools
    Given app.config.json tools.enabled is "*"
    When the proxy starts
    Then all 7 tools are exposed via tools/list

  Scenario: tools.enabled is an explicit list
    Given app.config.json tools.enabled is ["x_posts_since", "x_get_tweet"]
    When the proxy starts
    Then exactly those 2 tools are exposed
    And calls to other tools return {"error":"tool_disabled","tool":"<name>"}

  Scenario: Empty list disables all tools (server still lists, list is empty)
    Given app.config.json tools.enabled is []
    When the proxy starts
    Then tools/list returns an empty array

  Scenario: Unknown tool names in tools.enabled are dropped with a warning
    Given app.config.json tools.enabled includes "x_made_up_tool"
    When the proxy starts
    Then a warning is written to stderr naming the unknown tool
    And only the recognized names from the list are exposed

  Scenario: tools.enabled must be an array or "*"
    Given app.config.json tools.enabled is the string "x_posts_since"
    When the proxy starts
    Then loading fails with a clear error
    And startup is aborted

  # ---------- Throttle section ----------

  Scenario Outline: Interval string parsing
    Given the throttle config has an interval "<spec>"
    When the proxy parses it
    Then the resulting interval is <parsed>

    Examples:
      | spec    | parsed                |
      | 30s     | 30000 milliseconds    |
      | 5m      | 300000 milliseconds   |
      | 2h      | 7200000 milliseconds  |
      | 1d      | 86400000 milliseconds |
      | 7d      | 604800000 milliseconds|
      | never   | the literal "never"   |
      | always  | the literal "always"  |
      | NEVER   | the literal "never"   |
      | "  10m" | 600000 milliseconds   |

  Scenario Outline: Invalid interval strings reject the config at load time
    Given app.config.json contains the throttle operation interval "<spec>"
    When the proxy attempts to load it
    Then loading fails with an error
    And startup is aborted

    Examples:
      | spec    |
      |         |
      | 10      |
      | 10x     |
      | h10     |
      | garbage |

  Scenario: Operation interval lookup falls back to default
    Given throttle.default_min_interval is "1h"
    And throttle.operations does not list "exotic_op"
    When the proxy looks up the interval for "exotic_op"
    Then the result is 1 hour

  Scenario: error_retry_intervals dispatch
    Given throttle.error_retry_intervals contains:
      | code    | spec    |
      | 401     | never   |
      | 403     | never   |
      | 404     | 1h      |
      | 429     | 1h      |
      | 5xx     | 5m      |
      | network | 1m      |
    When an upstream call returns "<status>"
    Then the gate's effective retry interval is "<expected>"

    Examples:
      | status     | expected |
      | 401        | never    |
      | 404        | 1h       |
      | 503        | 5m       |
      | 502        | 5m       |
      | network    | 1m       |

  # ---------- SIGHUP reload ----------

  Scenario: SIGHUP reloads app.config.json
    Given the proxy is running with app.config.json loaded
    When the file is edited on disk
    And the proxy receives SIGHUP
    Then the new config is parsed and replaces the in-memory copy
    And subsequent gate-state computations use the new throttle intervals
    And tools.enabled changes propagate to in-flight MCP servers immediately
    And a confirmation line is written to stderr

  Scenario: SIGHUP failure leaves the previous config in place
    Given the proxy is running
    When app.config.json is replaced with invalid JSON
    And the proxy receives SIGHUP
    Then a failure message is written to stderr
    And the previous config remains active
    And the proxy continues running normally

  Scenario: Server-level fields do NOT live-reload
    Given the proxy is running on port 8787
    When server.port is changed in app.config.json
    And the proxy receives SIGHUP
    Then the listener stays on the original port
    # Restart is required to pick up server, storage, x_api, and logging.level changes.

  # ---------- Schema validation ----------

  Scenario: Missing version → load fails
    Given app.config.json lacks a "version" field
    When the proxy attempts to load it
    Then loading fails

  Scenario: Missing throttle section → load fails
    Given app.config.json lacks a "throttle" section
    When the proxy attempts to load it
    Then loading fails

  Scenario: Missing throttle.default_min_interval → load fails
    Given throttle is present but has no default_min_interval
    When the proxy attempts to load it
    Then loading fails
