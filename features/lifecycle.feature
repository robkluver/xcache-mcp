# language: en
@lifecycle
Feature: Process lifecycle (startup, signals, shutdown)
  As an operator
  I want predictable startup banners and a graceful shutdown that drains pending logs
  So that the proxy is friendly to systemd-style supervision and to manual ctrl-C usage.

  # ---------- Startup ----------

  Scenario: Cold start initializes config, db, log writer, and tool context
    Given a fresh installation with no data directory yet
    When the proxy starts with X_BEARER_TOKEN set
    Then the data directory is created
    And the SQLite database file is opened in WAL mode
    And the schema is bootstrapped via "CREATE TABLE IF NOT EXISTS"
    And the throttle config is loaded from disk
    And the LogWriter is started with a periodic flush timer
    And the tool context (token, API base, log-bodies flag) is initialized

  Scenario: Startup banner is written to stderr (not stdout)
    When the proxy boots
    Then a banner line goes to stderr
    And no banner contamination appears on stdout (which is reserved for MCP)

  Scenario: HTTP listener binds and announces its address on stderr
    Given server.http.enabled is true
    When the proxy boots
    Then "[xcache-mcp] HTTP listening on <host>:<port>" appears on stderr

  Scenario: stdio transport announces itself on stderr
    Given server.stdio.enabled is true
    When the proxy boots
    Then "[xcache-mcp] MCP stdio transport connected" appears on stderr

  Scenario: Both transports may be active simultaneously
    Given both server.http.enabled and server.stdio.enabled are true
    When the proxy boots
    Then both the HTTP listener and the stdio transport are active

  # ---------- CLI subcommand dispatch ----------

  Scenario: `xcache-mcp consolidate <args>` forwards to the consolidation script
    When the proxy CLI is invoked with first arg "consolidate"
    Then the index entrypoint imports "../bin/consolidate.js"
    And calls runConsolidate with the remaining argv

  # ---------- SIGHUP ----------

  Scenario: SIGHUP reloads the throttle config
    Given the proxy is running
    When SIGHUP is delivered to the process
    Then the throttle config is reloaded from disk
    And a confirmation line is written to stderr
    And the proxy keeps running

  Scenario: SIGHUP failure leaves the previous config in place
    Given the throttle config file has been corrupted on disk
    When SIGHUP is delivered
    Then a failure message appears on stderr
    And the previously-loaded config is still active

  # ---------- SIGTERM / SIGINT ----------

  Scenario Outline: <signal> triggers a graceful shutdown
    Given the proxy is running
    When the proxy receives <signal>
    Then "received <signal>, shutting down" appears on stderr
    And the HTTP listener is closed (if active)
    And the MCP stdio transport is closed (if active)
    And the LogWriter is drained with a 5-second deadline
    And the LogWriter's periodic timer is stopped
    And the SQLite database is closed
    And process.exit(0) is called

    Examples:
      | signal  |
      | SIGTERM |
      | SIGINT  |

  Scenario: Final-second requests are durably persisted before exit
    Given the proxy is processing requests
    When SIGTERM is sent ~100ms after the last request response
    Then the corresponding event log entries are present in the JSONL file after the process has exited

  Scenario: drainWithDeadline gives up after 5 seconds if writes keep failing
    Given the disk is unwriteable
    When SIGTERM is received
    Then drainWithDeadline returns after at most 5 seconds
    And the process still exits with code 0

  # ---------- Fatal errors during boot ----------

  Scenario: Fatal startup error writes a stack to stderr and exits 1
    Given the throttle config is malformed at startup
    When the proxy attempts to start
    Then a "fatal:" line with the error stack is written to stderr
    And process.exit(1) is called

  # ---------- Re-startability ----------

  Scenario: Restarting against an existing database reuses all cached data
    Given the proxy ran previously and accumulated url_cache, posts, and follow_snapshots rows
    When the proxy is restarted
    Then no data is dropped
    And the schema bootstrap is a no-op (tables already exist)
    And tool calls immediately benefit from the existing cache and gate state
