# language: en
@tool @x_get_user_by_username
Feature: Tool x_get_user_by_username
  As an MCP agent
  I want to look up a single X user by their @handle
  So that I can resolve a username to a user_id or fetch profile metadata.

  # Operation:    get_user_by_username
  # Default gate: 7d
  # Account ID:   the username, lowercased, leading @ stripped
  # Upstream:     GET /2/users/by/username/:username

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And the throttle config maps "get_user_by_username" to a 7d interval

  Scenario: First lookup hits upstream and caches the response
    Given there is no cached entry for "@xdevelopers"
    When the agent calls x_get_user_by_username with {"username": "xdevelopers"}
    Then the proxy issues GET /2/users/by/username/xdevelopers
    And the JSON response is returned to the caller
    And the response body is stored in url_cache
    And a fetch_gate row is written for ("get_user_by_username", "xdevelopers") with last_status 200

  Scenario: Leading @ is stripped from the username
    When the agent calls x_get_user_by_username with {"username": "@xdevelopers"}
    Then the upstream request URL ends with "/by/username/xdevelopers"
    And the gate's account_id is "xdevelopers"

  Scenario: Username is lowercased for the gate's account_id
    When the agent calls x_get_user_by_username with {"username": "XDevelopers"}
    Then the gate's account_id is "xdevelopers"
    And a follow-up call with {"username": "xdevelopers"} hits the same gate row

  Scenario: Repeated lookup within 7 days serves from cache
    Given a successful x_get_user_by_username call for "xdevelopers" was made 6 days ago
    When the agent calls x_get_user_by_username with {"username": "xdevelopers"}
    Then no upstream call is issued
    And the cached response is returned
    And an event log entry with source "cache" is recorded

  Scenario: Gate elapsed → refresh upstream
    Given a successful x_get_user_by_username call for "xdevelopers" was made 8 days ago
    When the agent calls x_get_user_by_username with {"username": "xdevelopers"}
    Then a fresh upstream call is issued
    And url_cache is updated with the new body
    And first_fetched_at is preserved
    And last_fetched_at advances to now

  Scenario: user.fields parameter is part of the cache key
    Given a successful call with no user.fields was cached
    When the agent calls x_get_user_by_username with {"username": "xdevelopers", "user.fields": "description,public_metrics"}
    Then the second request misses the cache
    And a separate url_cache entry is created for the new field set
    And the second request hits upstream

  Scenario: Upstream 404 closes the gate for the 4xx retry interval
    Given there is no cached entry for "@nonexistent_user_xyz"
    When the agent calls x_get_user_by_username with {"username": "nonexistent_user_xyz"}
    And upstream returns 404
    Then the proxy returns a structured upstream_error or not-found result to the caller
    And a fetch_gate error row is written with last_status 404
    And the gate stays closed for the 404 retry interval

  Scenario: Gate-closed-no-cache after a 404 returns gate_blocked instead of re-hitting
    Given the previous scenario left a gate-error row for "nonexistent_user_xyz"
    And no url_cache entry exists
    When the agent calls x_get_user_by_username again within the 4xx retry window
    Then no upstream call is made
    And a structured "gate_blocked" result is returned with last_status 404 and next_eligible_at
    And an event log entry with source "gate_blocked" is recorded

  Scenario: Stale-cache fallback when a refresh attempt errors
    Given a successful call for "xdevelopers" was cached
    And the gate has elapsed and reopened
    When the next refresh attempt returns a 503
    Then the previously-cached body is returned
    And a fetch_gate error row is written

  Scenario: Tool description steers the agent toward x_posts_since for monitoring
    When the agent reads the tool's description
    Then the description explicitly recommends x_posts_since for "repeated monitoring of a user's posts over time"
    And it recommends x_follows_changes_since for monitoring follow-list changes

  Scenario: Event log entry records this tool's name
    When the agent calls x_get_user_by_username
    Then the event log entry has mcp_tool "x_get_user_by_username"
    And the entry has operation "get_user_by_username"
    And the entry has account_id matching the lowercased username
