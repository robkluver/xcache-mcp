# language: en
@tool @x_posts_since @monitoring
Feature: Tool x_posts_since (★ preferred for monitoring posts over time)
  As an MCP agent
  I want to monitor a user's recent posts
  So that I can read their timeline incrementally and at near-zero API cost when called frequently.

  # Operation:    get_latest_posts
  # Default gate: 1h
  # Account ID:   resolved user_id
  # Upstream:     GET /2/users/:id/tweets (paginated; uses since_id once a cursor exists)

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "get_latest_posts" to a 1h interval

  # ---------- Username resolution ----------

  Scenario: Resolves username to user_id via the cached lookup
    Given x_get_user_by_username for "xdevelopers" was previously cached and returned id "2244994945"
    When the agent calls x_posts_since with {"username": "xdevelopers", "since_iso": "..."}
    Then no upstream user lookup is made
    And the gate's account_id is "2244994945"

  Scenario: Resolves username on demand when not yet cached
    Given there is no cached user lookup for "xdevelopers"
    When the agent calls x_posts_since with {"username": "xdevelopers", "since_iso": "..."}
    Then the proxy issues GET /2/users/by/username/xdevelopers (gated by get_user_by_username)
    And then proceeds to the get_latest_posts flow

  # ---------- Initial fetch ----------

  Scenario: First observation uses start_time = since_iso
    Given there is no post_cursors row for the resolved user_id
    And the gate is open
    When the agent calls x_posts_since with {"since_iso": "2026-05-04T00:00:00Z"}
    Then the upstream request includes "start_time=2026-05-04T00:00:00.000Z"
    And the upstream request does NOT include since_id
    And new tweets are inserted into the posts table
    And post_cursors is initialized with the newest and oldest tweet IDs observed

  Scenario: Second observation uses since_id from the cursor
    Given a post_cursors row exists with latest_tweet_id_seen = "100"
    And the gate is open
    When the agent calls x_posts_since
    Then the upstream request includes "since_id=100"
    And the upstream request does NOT include start_time

  # ---------- Throttling ----------

  Scenario: Two calls within the throttle window: only the first hits upstream
    Given the gate has just been written with success
    When the agent calls x_posts_since
    Then no upstream call is issued
    And the response.touched_upstream is false
    And the response.posts is read from cache

  Scenario: force_refresh bypasses the gate
    Given the gate is closed (interval not yet elapsed)
    When the agent calls x_posts_since with {"force_refresh": true}
    Then the proxy issues an upstream call regardless of gate state
    And the gate is updated with the new last_fetched_at

  # ---------- Pagination ----------

  Scenario: Walks pagination internally up to max_pages
    Given upstream returns next_token on each page
    When the agent calls x_posts_since with {"max_pages": 3}
    Then up to 3 paginated upstream calls are made (until next_token is absent or 3 pages elapse)
    And all observed tweets across all pages are upserted into posts
    And response.truncated is true if the cap was hit

  Scenario: Default max_pages is 5
    Given the agent calls x_posts_since without max_pages
    When the proxy walks pagination
    Then no more than 5 pages are fetched

  Scenario: All paginated calls share one pagination_chain_id in the event log
    When the agent triggers pagination across N pages
    Then each event log entry has the same pagination_chain_id
    And pagination_depth is 0 for the first page, 1 for the second, and so on

  # ---------- Response shape ----------

  Scenario: Posts are returned filtered to created_at >= since_iso, ordered DESC
    Given the cache contains posts at created_at = [..., 100, 200, 300, 400]
    When the agent calls x_posts_since with since_iso corresponding to 200
    Then response.posts has length 3
    And the posts are ordered by created_at DESC: [400, 300, 200]

  Scenario: Each PostRecord includes deletion fields
    When the agent receives a posts array
    Then every record has fields:
      | tweet_id            |
      | user_id             |
      | text                |
      | created_at (ISO)    |
      | first_observed_at   |
      | last_observed_at    |
      | deleted (boolean)   |
      | deleted_at (or null)|
      | raw                 |
    And public_metrics is present only when at least one metric was observed

  Scenario: Response includes touched_upstream, truncated, and gate fields
    When the agent receives a response
    Then it has these top-level fields:
      | posts              |
      | latest_observed_at |
      | touched_upstream   |
      | truncated          |
      | gate               |
    And gate.last_fetched_at and gate.next_eligible_at are ISO strings

  # ---------- Mutable metric updates ----------

  Scenario: Re-observing a tweet updates metrics but preserves first_observed_at
    Given a tweet was previously inserted with like_count 5 at first_observed_at T0
    When x_posts_since observes the same tweet again at T1 with like_count 50
    Then the row's like_count is updated to 50
    And first_observed_at remains T0
    And last_observed_at advances to T1
    And deleted_at is not touched

  # ---------- Errors ----------

  Scenario: Upstream error closes the gate via error_retry_intervals
    When upstream returns 503 mid-pagination
    Then the partial work done so far is preserved (the upserts that succeeded remain)
    But no follow-up pages are fetched in this call
    And a fetch_gate error row is written with last_status 503

  Scenario: Invalid since_iso returns a structured error
    When the agent calls x_posts_since with {"since_iso": "not-a-date"}
    Then the response is {"error": "invalid_since_iso", "message": "..."}
    And no upstream call is made

  Scenario: Resolving an unknown username returns user_not_found
    When the agent calls x_posts_since with {"username": "definitely_not_a_real_user_xyz"}
    And the upstream user lookup returns 404
    Then the response is {"error": "user_not_found", "message": "..."}

  # ---------- Description ----------

  Scenario: Description begins with a star and emphasizes preference over generic tools
    When the agent reads the tool's description
    Then it emphasizes monitoring posts over time
    And it warns against using x_raw_get or x_get_tweet for repeated post monitoring
