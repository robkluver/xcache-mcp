# language: en
@mcp @stdio
Feature: MCP over stdio (subprocess mode)
  As OpenClaw running on the user's machine
  I want to spawn xcache-mcp as a subprocess and talk to it via stdio
  So that the integration is self-contained and does not require an HTTP listener.

  Background:
    Given OpenClaw spawns the proxy with stdin/stdout connected
    And server.stdio.enabled is true

  Scenario: Stdio transport is connected at startup
    When the proxy boots
    Then a StdioServerTransport is created
    And it is connected to a freshly-constructed Server
    And the proxy writes "MCP stdio transport connected" to stderr (not stdout)

  Scenario: Stdout is reserved for the MCP protocol channel
    When the proxy emits any human-readable diagnostic
    Then the diagnostic is written to stderr
    And stdout receives only valid JSON-RPC messages

  Scenario: Fastify logger writes only to stderr when stdio is active
    Given the Fastify logger is configured with stream: process.stderr
    When Fastify emits request logs (LOG_LEVEL=info or higher)
    Then those logs appear on stderr
    And the MCP protocol on stdout is uncorrupted by interleaved log lines

  Scenario: tools/list over stdio returns the same seven tools as HTTP
    Given OpenClaw sends a tools/list JSON-RPC request on stdin
    When the proxy responds
    Then the result.tools array on stdout contains exactly the 7 expected tool names
    And the descriptions match those served on the HTTP transport

  Scenario: tools/call over stdio dispatches the same logic as HTTP
    When OpenClaw sends a tools/call for "x_posts_since"
    Then the proxy executes the tool
    And returns a JSON-RPC response on stdout

  Scenario: A single Server backs the stdio transport for the process lifetime
    Given the proxy was started with stdio enabled
    When multiple JSON-RPC requests arrive in sequence on stdin
    Then they are all served by the same Server instance
    And no per-request teardown occurs (unlike the stateless HTTP path)

  Scenario: Combined stdio + HTTP mode
    Given server.stdio.enabled is true
    And server.http.enabled is true
    When the proxy starts
    Then both transports are active
    And HTTP requests and stdio requests are processed independently
    And both surfaces share the same SQLite database and log writer

  Scenario: stdio-only mode for OpenClaw subprocess
    Given server.http.enabled is false
    When the proxy starts
    Then no HTTP listener is opened
    And only the stdio transport is available
    And the process consumes no TCP port

  Scenario: stdio events log entries have client_kind mcp_stdio
    When OpenClaw issues any tools/call over stdio
    Then the resulting event log entry has client_kind "mcp_stdio"

  Scenario: Shutdown closes stdio cleanly
    Given the proxy is running with stdio active
    When the proxy receives SIGTERM
    Then Server.close() is called
    And StdioServerTransport.close() is called
    And the log writer is drained
    And the process exits with code 0
