# language: en
@tool @x_follows_changes_since @monitoring
Feature: Tool x_follows_changes_since (★ preferred for follow-list monitoring)
  As an MCP agent
  I want a continually-growing cache of who a user follows
  So that I can detect new follows promptly while the proxy fills out older follows incrementally over time.

  # Operation:    get_user_following
  # Default gate: 24h
  # Account ID:   resolved user_id (the follower we are monitoring)
  # Upstream:     GET /2/users/:id/following
  #               Each call walks at most 5 pages: page 1 with early-stop on
  #               first already-cached follow, then up to 4 more pages from a
  #               persisted pagination_token until backfill.complete = true.
  # Storage:      following_history (one row per (follower, followed) pair,
  #               immutable first_observed_at + first_observed_via)
  #               + following_state (next_pagination_token, caught_up).

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "get_user_following" to a 24h interval

  # ---------- First observation ----------

  Scenario: First observation walks page 1 + up to 4 more pages of older territory
    Given there is no following_state row for the user
    And the gate is open
    When the agent calls x_follows_changes_since with {"username": "..."}
    Then the proxy walks page 1 with no token
    And it walks up to 4 more pages from page 1's next_token
    And every observed (follower, followed) pair is upserted into following_history
    And the first observation entries are tagged first_observed_via = "forward" if seen on page 1
    And entries observed on pages 2-5 are tagged first_observed_via = "backfill"
    And following_state is written with next_pagination_token = the deepest token seen (or null if walk reached end)
    And following_state.caught_up is true iff the walk reached the end of /following
    And response.first_observation is true
    And response.backfill.complete reflects whether the walk reached the end

  # ---------- Steady-state walk ----------

  Scenario: Subsequent walk: page 1 with early-stop on first cached follow
    Given a following_history row exists for at least one of the user's followings
    And the gate is open
    When the agent calls x_follows_changes_since
    Then page 1 walks until it sees a follow already in following_history
    And it stops walking page 1 at that point
    And new follows on page 1 are upserted with first_observed_via = "forward" and a fresh first_observed_at
    And existing follows have only their last_observed_at updated; first_observed_at and first_observed_via are preserved

  Scenario: Backfill continues from the persisted token
    Given following_state.caught_up is false
    And following_state.next_pagination_token is "tok_42"
    And the gate is open
    When the agent calls x_follows_changes_since
    Then after the page-1 walk, the proxy walks up to 4 more pages from "tok_42"
    And those observations are tagged first_observed_via = "backfill" (only on insert; preserved on conflict)
    And following_state.next_pagination_token is updated to the deepest token seen this call
    And if the walk reached the end of /following, following_state.caught_up is set to true and the token is set to null

  Scenario: Backfill is skipped once caught_up is true
    Given following_state.caught_up is true
    When the agent calls x_follows_changes_since
    Then only page 1 is walked (subject to early-stop)
    And no backfill pages are fetched
    And the upstream cost approaches 1 page per call

  # ---------- Walk caps ----------

  Scenario: A single call walks at most 5 upstream pages
    Given there is no early-stop hit on page 1 (e.g., first observation)
    When the agent calls x_follows_changes_since
    Then the proxy walks at most 5 pages total: page 1 + up to 4 backfill pages
    And the upper bound holds even on first observation for a power user with thousands of follows
    # The cache fills out over multiple weekly walks.

  # ---------- Throttling ----------

  Scenario: Gate dedups within 24h
    Given a successful x_follows_changes_since call was made 1 hour ago
    When the agent calls again
    Then no upstream call is issued
    And response.touched_upstream is false
    And the response returns the cached followings unchanged

  Scenario: force_refresh bypasses the gate (if policy allows)
    Given the gate is closed (interval not elapsed)
    And tools.permit_force_refresh is true
    When the agent calls with {"force_refresh": true}
    Then a fresh walk happens despite the gate

  Scenario: force_refresh is ignored when policy disallows it
    Given tools.permit_force_refresh is false
    When the agent calls with {"force_refresh": true}
    Then the gate is honored as if force_refresh were false
    And response.force_refresh_suppressed is true

  # ---------- Response shape ----------

  Scenario: Response includes the standard fields
    When the agent receives any successful response
    Then it has the fields:
      | followings (array)                  |
      | since_iso_requested (echoed or null)|
      | first_observation (boolean)         |
      | touched_upstream (boolean)          |
      | backfill (object)                   |
      | gate (object)                       |
    And each followings entry has:
      | user_id            |
      | username           |
      | name               |
      | first_observed_at  |
      | first_observed_via |
      | last_observed_at   |
    And followings is ordered DESC by first_observed_at

  Scenario: backfill object exposes cache-completion progress
    When the agent receives a response
    Then response.backfill is shaped like:
      """
      { "complete": boolean, "has_more": boolean, "last_walked_at": ISO|null }
      """
    And complete is true once the proxy has paginated to the end of /following at least once
    And has_more is the negation of complete

  # ---------- Detecting new follows ----------

  Scenario: Agent computes new follows by filtering on (forward + recent)
    Given a populated followings list with mixed first_observed_via values
    When the agent wants follows added in the last 24h
    Then the correct filter is:
      """
      followings.filter(f =>
        f.first_observed_at >= cutoff && f.first_observed_via === "forward")
      """
    # Backfilled follows have a recent first_observed_at but represent
    # follows the proxy just LEARNED about, not necessarily new follow events.

  # ---------- No unfollow detection in this version ----------

  Scenario: Unfollows are not detected
    Given a user actually unfollowed an account they previously followed
    When subsequent x_follows_changes_since walks happen
    Then the unfollowed account remains in followings
    And the response has no unfollows field
    # A future release may add an active=true flag, populated by an audit walk
    # that runs at a much slower cadence (e.g. 6 months).

  # ---------- Errors ----------

  Scenario: Invalid since_iso (when provided) returns a structured error
    When the agent calls with {"username": "u", "since_iso": "not-a-date"}
    Then the response is {"error": "invalid_since_iso", "message": "..."}

  Scenario: Unknown username returns user_not_found
    When the upstream user resolution returns 404
    Then the response is {"error": "user_not_found", "message": "..."}

  Scenario: Mid-walk error closes the gate via error_retry_intervals
    When pagination fails at page 3
    Then partial observations from earlier pages are persisted (history is append-only)
    And following_state is NOT updated (we'd lose pagination position)
    And a fetch_gate error row is written with the upstream status

  # ---------- Description ----------

  Scenario: Description marks the tool as preferred and explains the model
    When the agent reads the tool's description
    Then it explains the page-1 + backfill model
    And it warns against using x_raw_get to walk /following directly
    And it documents that unfollow detection is not provided in this version
