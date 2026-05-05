# language: en
@tool @x_get_user_by_id
Feature: Tool x_get_user_by_id
  As an MCP agent
  I want to look up a single X user by their numeric user_id
  So that I can fetch profile metadata when I already know the ID.

  # Operation:    get_user_by_id
  # Default gate: 7d
  # Account ID:   the user_id (already canonical)
  # Upstream:     GET /2/users/:id

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "get_user_by_id" to a 7d interval

  Scenario: First lookup hits upstream and caches the response
    Given there is no cached entry for user_id "2244994945"
    When the agent calls x_get_user_by_id with {"user_id": "2244994945"}
    Then the proxy issues GET /2/users/2244994945
    And the JSON response is returned to the caller
    And url_cache is updated
    And a fetch_gate row is written for ("get_user_by_id", "2244994945")

  Scenario: Repeated lookup within 7 days serves from cache
    Given a successful x_get_user_by_id call for "2244994945" was made 1 day ago
    When the agent repeats the call
    Then no upstream call is issued
    And the cached body is returned

  Scenario: Different user.fields create distinct cache entries
    Given a call with no user.fields was cached for "2244994945"
    When the agent calls x_get_user_by_id with {"user_id": "2244994945", "user.fields": "verified"}
    Then a separate url_cache entry is created
    And the second call hits upstream

  Scenario: 404 from upstream is treated as not-found and writes a gate error row
    When the agent calls x_get_user_by_id with {"user_id": "999999999999999"}
    And upstream returns 404
    Then a structured not-found-style result is returned
    And a fetch_gate error row is written with last_status 404

  Scenario: Tool description steers the agent toward x_posts_since for monitoring
    When the agent reads the tool's description
    Then the description recommends x_posts_since for repeated post monitoring
    And it recommends x_follows_changes_since for follow-list monitoring

  Scenario: Event log entry records this tool's name
    When the agent calls x_get_user_by_id
    Then the event log entry has mcp_tool "x_get_user_by_id"
    And operation "get_user_by_id"
    And account_id matching the requested user_id
