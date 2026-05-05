# language: en
@tool @x_follows_changes_since @monitoring
Feature: Tool x_follows_changes_since (★ preferred for monitoring follow-list changes)
  As an MCP agent
  I want to detect new follows and unfollows for a target user over time
  So that I can track changes without re-walking and re-comparing on every call.

  # Operation:    get_user_following
  # Default gate: 24h
  # Account ID:   resolved user_id
  # Upstream:     GET /2/users/:id/following (paginated to completion, capped at 100 pages)

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "get_user_following" to a 24h interval

  # ---------- Snapshot capture ----------

  Scenario: First observation walks the entire following list and records a snapshot
    Given there are no follow_snapshots rows for the user
    And the gate is open
    When the agent calls x_follows_changes_since
    Then the proxy walks /2/users/:id/following paginated to completion (cap 100 pages)
    And a new follow_snapshots row is inserted with taken_at = now
    And follow_snapshot_members rows are inserted for every followed account
    And follow_user_details is upserted for every member returned in the expansion
    And response.first_observation is true
    And response.new_follows contains every member of the snapshot
    And response.unfollows is empty

  Scenario: Throttle dedup within 24h
    Given a successful x_follows_changes_since call was made 1 hour ago
    When the agent calls again
    Then no upstream call is issued
    And response.touched_upstream is false
    And the diff is computed against the existing snapshots
    And gate.next_eligible_at is approximately 23h from now

  Scenario: force_refresh bypasses the gate
    Given the gate is closed (interval not elapsed)
    When the agent calls with {"force_refresh": true}
    Then a fresh snapshot is taken and inserted

  # ---------- Diffing ----------

  Scenario: Subsequent call computes new_follows and unfollows by set diff
    Given an earlier snapshot S1 has members {A, B, C}
    And the latest snapshot S2 has members {B, C, D, E}
    When x_follows_changes_since is called with since_iso between S1 and S2
    Then response.new_follows contains user IDs {D, E}
    And response.unfollows contains user IDs {A}
    And response.baseline_snapshot_at is S1's taken_at (ISO)
    And response.latest_snapshot_at is S2's taken_at (ISO)
    And response.first_observation is false

  Scenario: FollowDetail enrichment via follow_user_details
    Given user details for {D, E, A} were stored in earlier snapshot expansions
    When the diff returns user IDs
    Then each FollowDetail entry has user_id, username, name from follow_user_details
    And missing details fall back to {user_id, username: null, name: null}

  Scenario: Baseline selection uses snapshotAtOrBefore(since_iso)
    Given snapshots exist at taken_at = T1 < T2 < T3
    When the agent calls with since_iso between T2 and T3
    Then the baseline is S2 (the newest snapshot at-or-before since_iso)
    And the latest snapshot is S3

  Scenario: No baseline before since_iso → first_observation true
    Given snapshots exist only at T2 and later
    When the agent calls with since_iso = T1 (earlier than any snapshot)
    Then response.baseline_snapshot_at is null
    And response.first_observation is true
    And response.new_follows contains every member of the latest snapshot
    And response.unfollows is empty

  # ---------- Precision note ----------

  Scenario: Response includes a precision_note explaining over-inclusion
    When the agent receives any non-empty diff
    Then response.precision_note is a human-readable string
    And it explains that the baseline snapshot may be from before since_iso
    And it acknowledges that new_follows can over-include accounts followed slightly before the cutoff

  # ---------- Pagination safety ----------

  Scenario: Defensive page cap of 100 prevents runaway pagination
    Given upstream keeps returning next_token indefinitely (pathological case)
    When the agent calls x_follows_changes_since
    Then the proxy stops walking after at most 100 pages
    And no infinite loop occurs

  Scenario: Mid-pagination error discards the partial snapshot
    When pagination fails at page 5 of an in-progress walk
    Then no new follow_snapshots row is inserted
    And no follow_snapshot_members rows are inserted
    And a fetch_gate error row is written with the upstream status

  # ---------- Response shape ----------

  Scenario: Response includes the standard fields
    When the agent receives any response
    Then it has the fields:
      | new_follows           |
      | unfollows             |
      | baseline_snapshot_at  |
      | latest_snapshot_at    |
      | since_iso_requested   |
      | first_observation     |
      | touched_upstream      |
      | precision_note        |
      | gate                  |

  # ---------- Errors ----------

  Scenario: Invalid since_iso returns a structured error
    When the agent calls with {"since_iso": "not-a-date"}
    Then the response is {"error": "invalid_since_iso", "message": "..."}

  Scenario: Unknown username returns user_not_found
    When the upstream user resolution returns 404
    Then the response is {"error": "user_not_found", "message": "..."}

  # ---------- Description ----------

  Scenario: Description begins with a star and warns against direct /following walks
    When the agent reads the tool's description
    Then it emphasizes monitoring follow-list changes over time
    And it explicitly warns against using x_raw_get to walk /2/users/:id/following
