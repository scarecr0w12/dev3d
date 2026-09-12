/**
 * MCP (Model Context Protocol) support.
 *
 * dev3d speaks MCP as a *client*: it connects to servers other people publish
 * and exposes their tools to employees, under names that cannot collide with the
 * built-in tools. The protocol is implemented directly on Node built-ins — see
 * `jsonrpc.ts` for why — and the two transports are `stdio` (a server run as a
 * child process) and Streamable HTTP.
 *
 * Entry points:
 *   - `loadMcpConfig`   read `DEV3D_MCP_SERVERS` and `mcp.json`
 *   - `McpManager`      connect, publish tools into the registry, report status
 *   - `McpClient`       one connection, speaking JSON-RPC
 */

export {
  HttpTransport,
  type HttpTransportOptions,
} from './http.ts';
export {
  McpClient,
  MCP_PROTOCOL_VERSION,
  RPC_ERRORS,
  type McpClientOptions,
  type McpServerInfo,
  type McpToolInfo,
  type McpTransport,
} from './client.ts';
export { StdioTransport, type StdioTransportOptions } from './stdio.ts';
export {
  McpManager,
  parsePublishedToolName,
  publishedToolName,
  type McpManagerDeps,
  type McpServerConfig,
  type McpServerState,
  type McpStatus,
  type McpToolRecord,
  type TransportHooks,
} from './manager.ts';
export {
  loadMcpConfig,
  parseServerList,
  readConfigFile,
  type McpConfigResult,
} from './config.ts';
export {
  notification,
  parseMessage,
  request,
  type JsonRpcError,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './jsonrpc.ts';
