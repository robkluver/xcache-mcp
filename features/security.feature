# language: en
@security
Feature: Security and read-only invariants
  As a single-user owner running this on a personal machine
  I want strong protection of the bearer token and a strictly read-only surface
  So that no log file leaks the token and no request can mutate the X account.

  # ---------- Bearer token redaction ----------

  Scenario: Authorization header is redacted at the lowest level
    Given the proxy makes any upstream HTTP call
    When response headers are normalized for persistence
    Then the "Authorization" key (case-insensitive) is replaced with "<redacted>"
    And this redaction happens before any row enters the log queue or url_cache

  Scenario: Bearer token does not appear in url_cache.headers
    When a successful upstream response is cached
    Then the headers field stored in url_cache contains "<redacted>" for any Authorization key
    And does not contain the literal value of X_BEARER_TOKEN

  Scenario: Bearer token does not appear in events log
    When events are flushed to events/<UTC-date>.jsonl
    Then a recursive grep for the bearer token across all event files returns no matches

  Scenario: Bearer token does not appear in bodies log
    When bodies are flushed to bodies/<UTC-date>.jsonl
    Then a recursive grep for the bearer token across all body files returns no matches

  Scenario: Token redaction is preserved across log rotation
    When events log files are gzipped after 7 days
    Then a recursive grep for the bearer token across both .jsonl and .jsonl.gz files returns no matches

  Scenario: Token never appears in stderr or stdout diagnostics
    When the proxy emits any startup banner or runtime log to stderr
    Then the bearer token does not appear in those output streams

  # ---------- Read-only surface ----------

  Scenario: No POST/PUT/PATCH/DELETE routes exist for /2/*
    When a client sends "POST /2/tweets" or any other write verb
    Then the proxy does not forward it to upstream
    And Fastify returns a 404 route-not-found

  Scenario: No tool exposes write operations
    When the agent reads the list of available tools
    Then no tool name implies a write (no post/like/follow/dm/delete tools)
    And the only side effects toward upstream are GETs

  # ---------- File permissions ----------

  Scenario: Log files have mode 0600
    When any log file is created or appended
    Then its file mode is 0600
    And it is not world-readable

  # ---------- Authentication model ----------

  Scenario: App-only bearer auth (no OAuth user-context)
    When the proxy makes any upstream call
    Then the only credential sent is "Authorization: Bearer <X_BEARER_TOKEN>"
    And no OAuth flows, refresh tokens, or PKCE handshakes occur

  Scenario: No multi-user state
    When the proxy boots
    Then there is exactly one bearer token
    And there is no per-user partition in the database
    And there is no auth scheme protecting the local HTTP listener

  # ---------- Local-only by default ----------

  Scenario: Default HTTP listener binds to 127.0.0.1
    Given XCACHE_HOST is not set
    When the HTTP listener starts
    Then it binds to 127.0.0.1
    And it is not reachable from other hosts on the network without explicit override

  # ---------- Defensive coding ----------

  Scenario: Token redaction handles arbitrary header capitalization
    When upstream responds with "AUTHORIZATION: Bearer ..."
    Then redactHeaders replaces it with "<redacted>"

  Scenario: Lookalike headers are not falsely redacted
    Given response headers include "x-authorization: foo" and "authorization-other: bar"
    When redactHeaders runs
    Then those headers retain their original values
    And only exactly-named "Authorization" keys are redacted
