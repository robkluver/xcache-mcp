# language: en
@tool @x_verify_posts @deletion @expensive
Feature: Tool x_verify_posts (active deletion detection)
  As an MCP agent
  I want to verify which previously-cached posts are still live upstream
  So that I can confidently quote a post knowing it has not been deleted on X.

  # Operation:    verify_posts
  # Default gate: 7d (this tool is expensive — many requests per call)
  # Account ID:   resolved user_id
  # Upstream:     GET /2/tweets?ids=... in batches of 100

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "verify_posts" to a 7d interval

  # ---------- Gate-closed early return ----------

  Scenario: Gate closed → returns verified=false without hitting upstream
    Given a successful x_verify_posts call was made 1 day ago
    When the agent calls x_verify_posts again
    Then the response is {"verified": false, "reason": "gate_closed", "next_eligible_at": "..."}
    And no upstream call is made

  # ---------- Standard verification flow ----------

  Scenario: First call selects all live (non-deleted) cached posts and verifies them
    Given the cache contains 250 posts for the user with created_at >= since_iso, all with deleted_at = null
    And the gate is open
    When the agent calls x_verify_posts with the matching since_iso
    Then the proxy issues 3 batched GET requests to /2/tweets?ids=... (100 + 100 + 50)
    And response.batches is 3
    And response.checked is 250

  Scenario: Tweets returned in data are refreshed and counted as refreshed
    Given a batch response includes 90 tweets in data
    When x_verify_posts processes the batch
    Then those 90 tweet rows are upserted with the latest metrics
    And their last_observed_at is updated to now
    And response.refreshed is incremented by 90

  Scenario: Tweets in errors[] are marked deleted
    Given a batch response includes errors[] entries with resource_type "tweet" and a not-found code
    When x_verify_posts processes the batch
    Then each matching cached post has deleted_at set to now
    And response.newly_deleted is incremented per ID newly transitioning to deleted

  Scenario: Tweets missing from data and not in errors[] are also treated as deleted
    Given a batch was sent with 100 IDs
    And the response data array contains only 95 tweets
    And errors[] is empty
    When x_verify_posts processes the batch
    Then the 5 missing IDs have deleted_at set to now
    And response.newly_deleted increases by 5

  Scenario: Idempotent — already-deleted posts do not increment newly_deleted
    Given a post is already in the deleted state (deleted_at not null) before this call
    When x_verify_posts re-observes the post as still missing upstream
    Then deleted_at is not changed
    And response.newly_deleted is not incremented for this post

  # ---------- Response shape ----------

  Scenario: Successful response includes counts
    When x_verify_posts completes successfully
    Then the response has fields:
      | verified (true)      |
      | checked              |
      | newly_deleted        |
      | refreshed            |
      | batches              |

  Scenario: Empty post set short-circuits with zero work
    Given there are 0 cached posts for the user with created_at >= since_iso
    When the agent calls x_verify_posts
    Then the proxy makes 0 upstream calls
    And the response is {"verified": true, "checked": 0, "newly_deleted": 0, "refreshed": 0, "batches": 0}
    And the gate is written with success

  # ---------- Errors ----------

  Scenario: Mid-flight error closes the gate via error_retry_intervals
    Given verification has completed batches 1 and 2 of 3
    When batch 3 fails with a 503
    Then partial deletion-marking and metric updates from batches 1 and 2 are persisted
    And response.verified is false
    And response.error includes the upstream status
    And a fetch_gate error row is written with last_status 503

  Scenario: Invalid since_iso returns a structured error
    When the agent calls with {"since_iso": "not-a-date"}
    Then the response is {"error": "invalid_since_iso", "message": "..."}

  # ---------- Tool description ----------

  Scenario: Description marks the tool as expensive and recommends x_posts_since for routine monitoring
    When the agent reads the tool's description
    Then it begins by labeling the tool EXPENSIVE
    And it explains the use case (verifying live status before quoting)
    And it recommends x_posts_since for routine monitoring as far cheaper

  # ---------- Event log ----------

  Scenario: Each batch produces its own event log entry sharing one pagination_chain_id
    When x_verify_posts walks N batches
    Then N event log entries are recorded
    And all entries share the same pagination_chain_id
    And pagination_depth is 0, 1, ..., N-1
