Feature: Billing — per-request cost estimation and period totals

  Reading "billing" estimates the USD cost of upstream X API calls and reports
  a running cumulative total since the start of the configured billing period.
  Cache hits, gate-blocked requests, and errors are non-billable; only
  successful live upstream calls increment the period total.

  Background:
    Given billing is enabled in app.config.json with:
      | period_start_day  | 1                  |
      | period_start_time | 00:00              |
      | rates.owned_read  | 0.001 USD/resource |
      | rates.post_read   | 0.005 USD/resource |
      | rates.user_read   | 0.010 USD/resource |
      | rates.following_read | 0.010 USD/resource |
      | rates.list_read   | 0.005 USD/resource |

  Rule: REST passthrough responses include billing headers

    Scenario: Successful live call applies cost based on result_count and resource kind
      Given the gate is open for the request
      When the proxy fetches "/2/users/123/tweets" live and the upstream returns 200 with result_count=4
      Then the response includes header "x-xcache-source: live"
      And the response includes header "x-xcache-cost-estimate: 0.020000"
      And the response includes header "x-xcache-cost-period" reflecting the new running total
      And the response includes header "x-xcache-cost-period-start" set to the current period anchor (UTC ISO-8601)
      And the response includes header "x-xcache-cost-currency: USD"

    Scenario: Cache hit is free
      Given a cached response exists for the request
      When the proxy serves the cached response
      Then the response includes header "x-xcache-source: cache"
      And the response includes header "x-xcache-cost-estimate: 0.000000"
      And the response includes header "x-xcache-cost-period" set to the unchanged running total

    Scenario: Gate-blocked request is free
      Given the gate is closed and no cached response exists
      When the proxy returns 429 gate_blocked
      Then the response includes header "x-xcache-source: gate_blocked"
      And the response includes header "x-xcache-cost-estimate: 0.000000"

    Scenario: Live error is free; period total is unchanged
      Given the gate is open
      When the upstream call fails with HTTP 500
      Then the response includes header "x-xcache-cost-estimate: 0.000000"
      And the period total is unchanged

  Rule: MCP tool responses embed a "cost" block

    Scenario: Tool call cost is the diff between snapshots
      When an MCP tool call performs one billable upstream fetch worth $0.005
      Then the tool response object includes a "cost" block with:
        | this_call_usd     | 0.005000             |
        | period_total_usd  | (running total)      |
        | period_started_iso| current period anchor|
        | currency          | USD                  |

    Scenario: Tool call that hits cache has cost=0
      When an MCP tool call returns entirely from cache
      Then the tool response includes a "cost" block where this_call_usd is 0.000000

  Rule: Owned reads use the owned_read rate

    Scenario: Owner_user_id matches account_id → 0.001/resource
      Given owner_user_id is "9" (auto-detected at startup)
      When the proxy fetches "/2/users/9/tweets" live with result_count=10
      Then x-xcache-cost-estimate is "0.010000"

    Scenario: Non-owner account → per-resource rate
      Given owner_user_id is "9"
      When the proxy fetches "/2/users/123/tweets" live with result_count=10
      Then x-xcache-cost-estimate is "0.050000"

  Rule: Period start anchoring with day-of-month + time

    Scenario: Current period rolls back to last month when "now" is before this month's anchor
      Given period_start_day=15 and period_start_time="00:00"
      And "now" is "2026-05-05T12:00:00Z"
      Then the current period start is "2026-04-15T00:00:00Z"

    Scenario: Day=31 floors to the last day of a 30-day month
      Given period_start_day=31
      And "now" is "2026-04-30T23:59:00Z"
      Then the current period start is "2026-04-30T00:00:00Z"

    Scenario: Period rollover resets the running total
      Given the stored period started "2026-04-01T00:00:00Z" with total $1.234
      When a billable event arrives and "now" is "2026-05-01T00:00:01Z"
      Then the period_started_iso is "2026-05-01T00:00:00Z"
      And the period_total_usd starts from the new event's cost only

  Rule: Owner_user_id auto-detection

    Scenario: First start with no override and no cached value
      Given billing.owner_user_id is unset and proxy_meta has no owner_user_id
      When the process starts
      Then the proxy issues GET /2/users/me once
      And persists the returned id as owner_user_id

    Scenario: Configured override wins
      Given billing.owner_user_id is "42"
      When the process starts
      Then owner_user_id is set to "42" without calling /2/users/me

    Scenario: Resolution failure is non-fatal
      Given /2/users/me returns 401
      When the process starts
      Then the process continues to serve requests
      And non-owned rates apply until owner_user_id is resolved on a later start
