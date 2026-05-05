# language: en
@mcp @http
Feature: MCP over Streamable HTTP (stateless mode)
  As an MCP client (e.g. OpenClaw or any other agent)
  I want to call the proxy's tools over HTTP
  So that I do not have to spawn it as a subprocess.

  Background:
    Given the proxy is running with X_BEARER_TOKEN set
    And server.http.enabled is true

  Scenario: tools/list returns all seven tools
    When the client sends:
      """
      POST /mcp
      Content-Type: application/json
      Accept: application/json, text/event-stream

      {"jsonrpc":"2.0","id":1,"method":"tools/list"}
      """
    Then the response is an SSE or JSON envelope
    And the parsed result.tools array contains exactly these names:
      | x_get_user_by_username  |
      | x_get_user_by_id        |
      | x_get_tweet             |
      | x_raw_get               |
      | x_posts_since           |
      | x_follows_changes_since |
      | x_verify_posts          |
    And each tool has a non-empty "description" field
    And each tool has an "inputSchema" with "type": "object"

  Scenario: Tool descriptions steer the agent toward monitoring tools
    When the client lists tools
    Then the description of "x_get_user_by_username" mentions "x_posts_since" for repeated monitoring
    And the description of "x_get_tweet" mentions "x_posts_since" for repeated monitoring
    And the description of "x_raw_get" mentions the higher-level tools
    And the description of "x_posts_since" begins with a star or "preferred"
    And the description of "x_follows_changes_since" begins with a star or "preferred"
    And the description of "x_verify_posts" warns it is expensive

  Scenario: tools/call dispatches to the named tool
    When the client posts a tools/call for "x_get_user_by_username" with {"username": "xdevelopers"}
    Then the proxy executes the tool
    And the response.content[0].type is "text"
    And the response.content[0].text parses as JSON

  Scenario: Stateless mode — no session ID is issued or required
    Given the StreamableHTTPServerTransport is configured with sessionIdGenerator: undefined
    When two independent clients each post a tools/call
    Then neither client has to send an "Mcp-Session-Id" header
    And each request gets a fresh Server and transport instance

  Scenario: Concurrent calls do not share state
    When two clients each post a tools/call simultaneously
    Then both calls are processed independently
    And the responses are returned to the correct clients
    And no inter-client data leaks

  Scenario Outline: Non-POST methods return 405
    When the client sends "<method> /mcp"
    Then the response status is 405
    And the response includes header "Allow: POST"
    And the response body explains that stateless MCP only supports POST

    Examples:
      | method |
      | GET    |
      | DELETE |

  Scenario: Fastify hijacks the response so the MCP transport writes to raw res
    When the proxy handles "POST /mcp"
    Then reply.hijack() is called before transport.handleRequest
    And the SDK transport writes directly to the underlying http.ServerResponse

  Scenario: Server and transport are torn down per request
    When a single tools/call request completes
    Then the per-request Server.close() is called
    And the per-request transport.close() is called
    And no listeners or DB handles leak between requests

  Scenario: Internal error is reported as JSON-RPC error
    Given a malformed POST body that the SDK cannot dispatch
    When the proxy receives it
    Then it responds with a JSON-RPC envelope
    And the envelope contains "error.code": -32603 (or another standard code) and a message string
    And the response status is 500

  Scenario: X-Agent-Session header threads through to the event log
    When the client sends "POST /mcp" with header "X-Agent-Session: sess-xyz" and a tools/call
    Then the resulting event log entry has agent_session_id "sess-xyz"
    And the entry has client_kind "mcp_http"

  Scenario: Tool execution failures are returned as text content with isError=true
    Given a tool dispatch raises an exception
    When the proxy serializes the failure
    Then the JSON-RPC result has isError: true
    And content[0].text is a JSON-encoded {"error": "tool_error", "message": "..."}
