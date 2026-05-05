# language: en
@configuration
Feature: Configuration loading and reload
  As an operator running xcache-mcp
  I want predictable, file-and-env-driven configuration
  So that the proxy boots with the right token, paths, listener, and throttle policy.

  Background:
    Given xcache-mcp is installed at the project root
    And no environment variables are set unless specified

  # ---------- Environment variables ----------

  Scenario: Required X_BEARER_TOKEN is missing
    Given the environment variable "X_BEARER_TOKEN" is not set
    When the proxy starts
    Then a warning is written to stderr containing "X_BEARER_TOKEN is not set"
    And the proxy continues to boot
    But every upstream call will fail with an authentication error

  Scenario: Default listener address
    Given "X_BEARER_TOKEN" is set to "test"
    And "XCACHE_PORT" is not set
    And "XCACHE_HOST" is not set
    When the proxy starts
    Then the HTTP listener binds to "127.0.0.1:8787"

  Scenario Outline: Listener override via env vars
    Given "X_BEARER_TOKEN" is set to "test"
    And "XCACHE_HOST" is set to "<host>"
    And "XCACHE_PORT" is set to "<port>"
    When the proxy starts
    Then the HTTP listener binds to "<host>:<port>"

    Examples:
      | host      | port  |
      | 0.0.0.0   | 9000  |
      | 127.0.0.1 | 18080 |

  Scenario: Default data directory expansion
    Given "X_BEARER_TOKEN" is set to "test"
    And "XCACHE_ROOT" is not set
    When the proxy starts
    Then the data directory is "$HOME/.openclaw/xcache-mcp"
    And the SQLite file is "$HOME/.openclaw/xcache-mcp/data.db"
    And the logs directory is "$HOME/.openclaw/xcache-mcp/logs"

  Scenario: XCACHE_ROOT override creates directories on demand
    Given "X_BEARER_TOKEN" is set to "test"
    And "XCACHE_ROOT" is set to a path that does not yet exist
    When the proxy starts
    Then the path is created with its "logs/events" and "logs/bodies" subdirectories

  Scenario: Tilde expansion in XCACHE_ROOT
    Given "XCACHE_ROOT" is set to "~/custom-cache"
    When the proxy starts
    Then the resolved path is "$HOME/custom-cache"

  Scenario: Disabling the HTTP listener
    Given "XCACHE_NO_HTTP" is set to "1"
    When the proxy starts
    Then no HTTP listener is opened
    And the MCP stdio transport is still attached unless XCACHE_NO_STDIO is also set

  Scenario: Disabling the MCP stdio transport
    Given "XCACHE_NO_STDIO" is set to "1"
    When the proxy starts
    Then no stdio transport is attached
    And the HTTP listener is still opened unless XCACHE_NO_HTTP is also set

  Scenario Outline: XCACHE_LOG_BODIES toggle
    Given "XCACHE_LOG_BODIES" is set to "<value>"
    When the proxy logs an upstream call
    Then bodies log files <are_or_arent> created
    And event log entries have a body_ref of <body_ref>

    Examples:
      | value | are_or_arent | body_ref     |
      | 1     | are          | "bodies/..." |
      | 0     | are not      | null         |

  Scenario: LOG_LEVEL only affects stderr output
    Given "LOG_LEVEL" is set to "debug"
    When the proxy emits Fastify logs
    Then the logs go to stderr only
    And stdout is reserved for the MCP protocol channel

  Scenario: X_API_BASE override for testing
    Given "X_API_BASE" is set to "http://127.0.0.1:9999"
    When the proxy makes any upstream call
    Then the request goes to "http://127.0.0.1:9999/2/..."
    And no requests are made to "https://api.x.com"

  # ---------- Throttle config file ----------

  Scenario: Default throttle config path
    Given "XCACHE_THROTTLE_CONFIG" is not set
    When the proxy starts
    Then it loads "./throttle.config.json" relative to the working directory

  Scenario Outline: Interval string parsing
    Given the throttle config has an interval "<spec>"
    When the proxy parses it
    Then the resulting interval is <parsed>

    Examples:
      | spec    | parsed                   |
      | 30s     | 30000 milliseconds       |
      | 5m      | 300000 milliseconds      |
      | 2h      | 7200000 milliseconds     |
      | 1d      | 86400000 milliseconds    |
      | 7d      | 604800000 milliseconds   |
      | never   | the literal "never"      |
      | always  | the literal "always"     |
      | NEVER   | the literal "never"      |
      | "  10m" | 600000 milliseconds      |

  Scenario Outline: Invalid interval strings reject the config at load time
    Given the throttle config contains the operation interval "<spec>"
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
    Given the throttle config has "default_min_interval": "1h"
    And operations does not list "exotic_op"
    When the proxy looks up the interval for "exotic_op"
    Then the result is 1 hour

  Scenario: error_retry_intervals dispatch
    Given the throttle config has the following error_retry_intervals
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

  Scenario: SIGHUP reloads throttle config
    Given the proxy is running with throttle config loaded
    When the file at XCACHE_THROTTLE_CONFIG is edited on disk
    And the proxy receives SIGHUP
    Then the new throttle config is parsed and replaces the in-memory copy
    And subsequent gate-state computations use the new intervals
    And a confirmation line is written to stderr

  Scenario: SIGHUP reload with an invalid file leaves the previous config in place
    Given the proxy is running with throttle config loaded
    When the file at XCACHE_THROTTLE_CONFIG is replaced with invalid JSON
    And the proxy receives SIGHUP
    Then a failure message is written to stderr
    And the previous config remains active
    And the proxy continues running normally
