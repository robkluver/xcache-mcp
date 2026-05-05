# language: en
@throttle @gate
Feature: Throttle gate decides whether to call upstream
  As a proxy that must minimize cost against the X API
  I want a per-(operation, account_id) throttle gate
  So that identical operations within the configured window do not hit upstream
  And so that transient failures recover faster than full polling cadence without retry storms.

  Background:
    Given the throttle config defines:
      | operation    | interval |
      | op_short     | 30s      |
      | op_long      | 1d       |
      | op_never     | never    |
      | op_always    | always   |
    And error_retry_intervals are:
      | code    | spec  |
      | 401     | never |
      | 404     | 10m   |
      | 5xx     | 1m    |
      | network | 30s   |

  # ---------- First call ----------

  Scenario: No prior gate row → gate is open with reason first_call
    Given there is no fetch_gate row for "op_short" / "acct1"
    When the proxy reads the gate state
    Then the gate is open
    And the reason is "first_call"
    And last_fetched_at is null
    And next_eligible_at is null

  # ---------- Success path ----------

  Scenario: Within the operation interval → closed
    Given a successful gate write for "op_short" / "acct1" 5 seconds ago
    When the proxy reads the gate state
    Then the gate is closed
    And the reason is "interval_not_elapsed"
    And next_eligible_at is approximately 25 seconds from now

  Scenario: After the operation interval has elapsed → open again
    Given a successful gate write for "op_short" / "acct1" 60 seconds ago
    When the proxy reads the gate state
    Then the gate is open
    And the reason is "interval_elapsed"

  Scenario: Operation with "never" interval stays closed forever after success
    Given a successful gate write for "op_never" / "acct1" 1 millisecond ago
    When the proxy reads the gate state at any time in the future
    Then the gate is closed
    And the reason is "never_after_success"
    And next_eligible_at is null

  Scenario: Operation with "always" interval is always open
    Given a successful gate write for "op_always" / "acct1" 1 millisecond ago
    When the proxy reads the gate state
    Then the gate is open

  # ---------- Error path ----------

  Scenario: After a 4xx error, the gate uses the matching error_retry_intervals entry
    Given a gate error write for "op_short" / "acct1" with status 404 1 second ago
    When the proxy reads the gate state
    Then the gate is closed
    And the reason is "interval_not_elapsed"
    And the effective interval is 10 minutes
    And last_status is 404

  Scenario: After 4xx retry interval elapses → open
    Given a gate error write for "op_short" / "acct1" with status 404 11 minutes ago
    When the proxy reads the gate state
    Then the gate is open
    And the reason is "interval_elapsed"

  Scenario: Error code mapped to "never" closes the gate forever
    Given a gate error write for "op_short" / "acct1" with status 401
    When the proxy reads the gate state
    Then the gate is closed
    And the reason is "never_after_error"
    And last_status is 401

  Scenario: 5xx errors fall back to the "5xx" retry interval
    Given a gate error write for "op_short" / "acct1" with status 503 90 seconds ago
    When the proxy reads the gate state
    Then the gate is open
    And the effective interval was 1 minute

  Scenario: Network errors with no HTTP status use the "network" retry interval
    Given a gate error write for "op_short" / "acct1" with status null and error "ECONNRESET" 60 seconds ago
    When the proxy reads the gate state
    Then the gate is open
    And the effective interval was 30 seconds

  # ---------- Transitions ----------

  Scenario: Success after error clears last_error and updates last_status
    Given a gate row for "op_short" / "acct1" with last_status 404 and last_error "not_found"
    When the proxy writes a gate success with status 200
    Then last_status is 200
    And last_error is null
    And the effective interval reverts to the operation interval

  Scenario: Error after success records the error
    Given a gate row for "op_short" / "acct1" with last_status 200 and last_error null
    When the proxy writes a gate error with status 503 and error "down"
    Then last_status is 503
    And last_error is "down"
    And the effective interval is now the 5xx retry interval

  # ---------- Scoping ----------

  Scenario: Each (operation, account_id) pair has its own gate row
    Given a successful gate write for "op_short" / "alice"
    And a successful gate write for "op_short" / "bob"
    And a successful gate write for "op_long" / "alice"
    When the proxy reads any of these gates
    Then each row is independent of the others

  Scenario: A different account on the same operation is unaffected
    Given a 60-second-recent gate row for "op_short" / "alice"
    When the proxy reads gate state for "op_short" / "carol"
    Then the gate is open with reason "first_call"

  # ---------- Use against the request flow ----------

  Scenario: Gate-open path triggers an upstream call
    Given the gate for "(op, acct)" is open
    When a tool routes through the gate
    Then the proxy issues a fresh upstream HTTP request
    And on success it writes a gate success
    And on error it writes a gate error with the response status

  Scenario: Gate-closed path with a cached response serves from cache
    Given the gate for "(op, acct)" is closed
    And url_cache has an entry for the canonical URL
    When a tool routes through the gate
    Then no upstream HTTP request is made
    And the cached body is returned to the caller
    And an event log entry with source "cache" is recorded

  Scenario: Gate-closed path with no cached response returns gate_blocked
    Given the gate for "(op, acct)" is closed because of a recent error
    And url_cache has no entry for the canonical URL
    When a tool routes through the gate
    Then no upstream HTTP request is made
    And a structured "gate_blocked" result is returned with last_status and next_eligible_at
    And an event log entry with source "gate_blocked" is recorded
